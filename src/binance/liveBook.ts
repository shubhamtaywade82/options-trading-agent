import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentId, Position, Side } from '../types.js';
import { roundPrice, roundQty } from './symbolRules.js';
import type { PositionVenue, ReduceResult } from '../position/PositionDriver.js';

/**
 * Live Binance side of the position manager. Everything exchange-specific sits behind `LiveOrderPort`, so the logic
 * here (reconciliation, partials, stop replacement, fail-safe ordering) is tested against a fake exchange.
 *
 * Modes: `shadow` computes and logs what the manager WOULD do against an in-memory overlay and sends nothing;
 * `on` sends real orders. The exchange keeps its own server-side STOP_MARKET / TAKE_PROFIT_MARKET (closePosition) orders
 * the whole time: they protect the position even if this process dies.
 *
 * Fail-safe rules for a stop change (the client library has no way to edit a conditional order):
 *   1. cancel the old stop by id; if that fails, abort and keep everything as it was;
 *   2. place the new stop (retried); on success remember its order id;
 *   3. if every attempt fails, put the previous stop back; if that fails too, close the position at market.
 * A position is never left without a stop on purpose, and a stop is never loosened.
 */
export type LiveManagerMode = 'shadow' | 'on';

export interface LivePositionRaw {
  symbol: string;
  /** Signed: positive long, negative short. */
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unrealizedProfit: number;
  liquidationPrice: number;
  leverage: number;
  isolated: boolean;
}

export interface LiveOpenOrder {
  orderId: number;
  type: string;
  side: 'BUY' | 'SELL';
  stopPrice: number;
  closePosition: boolean;
}

export interface LiveOrderPort {
  /** One-way-mode positions with a non-zero amount. */
  fetchPositions(): Promise<LivePositionRaw[]>;
  openOrders(symbol: string): Promise<LiveOpenOrder[]>;
  /** A closePosition conditional market order (STOP_MARKET / TAKE_PROFIT_MARKET). */
  placeConditional(order: { symbol: string; side: 'BUY' | 'SELL'; type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET'; stopPrice: number }): Promise<{ orderId: number }>;
  cancel(symbol: string, orderId: number): Promise<void>;
  /** A reduce-only market order that reports what actually executed. */
  marketReduce(order: { symbol: string; side: 'BUY' | 'SELL'; quantity: number; clientOrderId: string }): Promise<{ status: string; executedQty: number }>;
}

/** What the order flow knows about a position that the exchange does not: who opened it, and its protection. */
export interface LiveMeta {
  symbol: string;
  side: Side;
  strategy: AgentId;
  stopLoss: number;
  takeProfit: number | null;
  stopOrderId?: number;
  tpOrderId?: number;
  initialRisk?: number;
  openedAt: number;
  decisionId?: string;
}

interface LiveStateFile { version: 1; positions: Record<string, LiveMeta> }

const isMeta = (v: unknown): v is LiveMeta => {
  const m = v as Partial<LiveMeta> | null;
  return m !== null && typeof m === 'object' && typeof m.symbol === 'string' && (m.side === 'LONG' || m.side === 'SHORT')
    && typeof m.strategy === 'string' && typeof m.stopLoss === 'number' && Number.isFinite(m.stopLoss);
};

/** data/live-state.json: per-symbol metadata, atomic writes. Corrupt or missing files mean "nothing managed", never a crash. */
export class LiveStateStore {
  private positions: Record<string, LiveMeta> = {};

  constructor(private readonly filePath = path.resolve('data/live-state.json')) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<LiveStateFile>;
      if (parsed.version === 1 && parsed.positions && typeof parsed.positions === 'object') {
        for (const [symbol, meta] of Object.entries(parsed.positions)) if (isMeta(meta)) this.positions[symbol] = meta;
      }
    } catch { /* first run, or unreadable: start empty */ }
  }

  get(symbol: string): LiveMeta | undefined { return this.positions[symbol]; }
  symbols(): string[] { return Object.keys(this.positions); }
  set(meta: LiveMeta): void { this.positions[meta.symbol] = meta; this.flush(); }
  delete(symbol: string): void { if (symbol in this.positions) { delete this.positions[symbol]; this.flush(); } }

  private flush(): void {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, positions: this.positions } satisfies LiveStateFile, null, 2));
      renameSync(tmp, this.filePath);
    } catch { /* the in-memory copy still governs this session */ }
  }
}

export interface LiveBookOptions {
  mode: LiveManagerMode;
  log(message: string, level: 'info' | 'warn' | 'error'): void;
  now?(): number;
  /** Placement attempts per protective order before falling back. */
  placeAttempts?: number;
}

export interface EntryRecord {
  symbol: string;
  side: Side;
  strategy: AgentId;
  stopLoss: number;
  takeProfit: number | null;
  stopOrderId?: number;
  tpOrderId?: number;
  decisionId?: string;
}

interface Simulated { reduced: number; stop?: number; target?: number | null }

const exitSideOf = (side: Side): 'BUY' | 'SELL' => (side === 'LONG' ? 'SELL' : 'BUY');
const sideOfAmount = (amt: number): Side => (amt > 0 ? 'LONG' : 'SHORT');
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class LiveBook {
  private raw = new Map<string, LivePositionRaw>();
  private readonly sim = new Map<string, Simulated>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly announcedUnmanaged = new Set<string>();
  private sequence = 0;
  private readonly now: () => number;
  private readonly attempts: number;

  constructor(private readonly port: LiveOrderPort, private readonly store: LiveStateStore, private readonly options: LiveBookOptions) {
    this.now = options.now ?? Date.now;
    this.attempts = options.placeAttempts ?? 3;
  }

  get mode(): LiveManagerMode { return this.options.mode; }

  /** Serialises everything that touches one symbol's orders, so a refresh can never observe a half-done stop replacement. */
  private exclusive<T>(symbol: string, task: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(symbol) ?? Promise.resolve()).then(task, task);
    this.locks.set(symbol, run.catch(() => undefined));
    return run;
  }

  /** Called by the order flow right after an entry's protective orders are on the exchange. */
  recordEntry(entry: EntryRecord): void {
    const prior = this.store.get(entry.symbol);
    const sameSide = prior?.side === entry.side;
    this.store.set({
      symbol: entry.symbol, side: entry.side, strategy: entry.strategy, stopLoss: entry.stopLoss, takeProfit: entry.takeProfit,
      ...(entry.stopOrderId === undefined ? {} : { stopOrderId: entry.stopOrderId }),
      ...(entry.tpOrderId === undefined ? {} : { tpOrderId: entry.tpOrderId }),
      // A same-side add keeps the position's original 1R and opening time, like the paper engine
      ...(sameSide && prior?.initialRisk !== undefined ? { initialRisk: prior.initialRisk } : {}),
      openedAt: sameSide && prior ? prior.openedAt : this.now(),
      ...(entry.decisionId === undefined ? {} : { decisionId: entry.decisionId }),
    });
    this.sim.delete(entry.symbol);
  }

  /**
   * Once per cycle: forget positions that no longer exist, fix up the 1R of new ones, and (mode `on`) make sure every
   * managed position still has its stop on the exchange. The stop audit reads the open orders INSIDE the symbol's lock:
   * read outside it, a snapshot taken between a stop replacement's cancel and its place would show "no stop" and the
   * audit would act on it after the replacement finished.
   */
  async refresh(): Promise<void> {
    const positions = await this.port.fetchPositions();
    this.raw = new Map(positions.map((p) => [p.symbol, p]));

    for (const symbol of this.store.symbols()) {
      const meta = this.store.get(symbol)!;
      const position = this.raw.get(symbol);
      if (!position || sideOfAmount(position.positionAmt) !== meta.side) {
        this.store.delete(symbol); // closed by a stop, a target, a manual close, or flipped by someone else
        this.sim.delete(symbol);
        continue;
      }
      if (meta.initialRisk === undefined) {
        const initialRisk = Math.abs(position.entryPrice - meta.stopLoss);
        if (initialRisk > 0) this.store.set({ ...meta, initialRisk });
      }
      if (this.options.mode === 'on') await this.exclusive(symbol, () => this.auditProtection(symbol));
    }
    for (const position of positions) {
      if (this.store.get(position.symbol) || this.announcedUnmanaged.has(position.symbol)) continue;
      this.announcedUnmanaged.add(position.symbol);
      this.options.log(`live book: ${position.symbol} ${sideOfAmount(position.positionAmt)} has no recorded entry; left to its exchange-side orders, not managed`, 'info');
    }
  }

  /** The managed positions as the position manager reads them: exchange entry/qty, recorded stop/target, marks from the live feed. */
  positions(prices: Record<string, number> = {}): Position[] {
    const out: Position[] = [];
    for (const [symbol, raw] of this.raw) {
      const meta = this.store.get(symbol);
      if (!meta) continue;
      const sim = this.sim.get(symbol);
      const qty = Math.abs(raw.positionAmt) - (sim?.reduced ?? 0);
      if (!(qty > 0)) continue;
      const direction = meta.side === 'LONG' ? 1 : -1;
      const mark = prices[symbol] ?? raw.markPrice;
      const stop = sim?.stop ?? meta.stopLoss;
      const target = sim && 'target' in sim ? sim.target : meta.takeProfit;
      out.push({
        id: `${symbol}_${meta.strategy}`, symbol, side: meta.side, strategy: meta.strategy, entry: raw.entryPrice, qty, mark,
        upnl: (mark - raw.entryPrice) * qty * direction,
        upnlPct: raw.entryPrice ? ((mark - raw.entryPrice) / raw.entryPrice) * 100 * direction : 0,
        leverage: raw.leverage, marginType: raw.isolated ? 'ISOLATED' : 'CROSS',
        liqDistancePct: raw.liquidationPrice > 0 && mark > 0 ? (Math.abs(mark - raw.liquidationPrice) / mark) * 100 : null,
        serverSl: String(stop), serverTp: target === null || target === undefined ? 'trail' : String(target),
        ...(meta.initialRisk === undefined ? {} : { initialRisk: meta.initialRisk }),
        ...(meta.decisionId === undefined ? {} : { decisionId: meta.decisionId }),
      });
    }
    return out;
  }

  /** The venue the position driver talks to. */
  venue(): PositionVenue {
    return {
      reducePosition: (pos, qty) => this.reduce(pos, qty),
      updateStops: (symbol, _strategy, stop, target, side) => this.updateStops(symbol, stop, target, side),
    };
  }

  private async reduce(pos: Position, qty: number): Promise<ReduceResult> {
    const quantity = roundQty(pos.symbol, qty);
    if (!(quantity > 0) || quantity >= pos.qty) throw new Error(`refusing partial ${quantity} of ${pos.qty} ${pos.symbol}`);
    if (this.options.mode === 'shadow') {
      const sim = this.sim.get(pos.symbol) ?? { reduced: 0 };
      this.sim.set(pos.symbol, { ...sim, reduced: sim.reduced + quantity });
      this.options.log(`SHADOW would reduce ${pos.symbol} ${pos.side} by ${quantity} (market, reduce-only)`, 'info');
      return { executedQty: quantity };
    }
    return this.exclusive(pos.symbol, async () => {
      const clientOrderId = `pm-${pos.symbol}-${this.now()}-${this.sequence++}`;
      const result = await this.port.marketReduce({ symbol: pos.symbol, side: exitSideOf(pos.side), quantity, clientOrderId });
      if (!(result.executedQty > 0)) throw new Error(`partial reduce of ${pos.symbol} executed nothing (status ${result.status})`);
      if (result.executedQty < quantity) this.options.log(`live book: partial reduce of ${pos.symbol} filled ${result.executedQty} of ${quantity} (status ${result.status})`, 'warn');
      const held = this.raw.get(pos.symbol);
      if (held) this.raw.set(pos.symbol, { ...held, positionAmt: held.positionAmt - Math.sign(held.positionAmt) * result.executedQty });
      return { executedQty: result.executedQty };
    });
  }

  private async updateStops(symbol: string, stop: number, target: number | null, side: Side): Promise<void> {
    const meta = this.store.get(symbol);
    if (!meta) throw new Error(`no recorded entry for ${symbol}`);
    const newStop = roundPrice(symbol, stop);
    const direction = side === 'LONG' ? 1 : -1;
    if (this.options.mode === 'shadow') {
      const sim = this.sim.get(symbol) ?? { reduced: 0 };
      this.sim.set(symbol, { ...sim, stop: newStop, target });
      this.options.log(`SHADOW would move ${symbol} stop ${(sim.stop ?? meta.stopLoss)} -> ${newStop}${target === null && meta.takeProfit !== null ? ' and drop the target' : ''}`, 'info');
      return;
    }
    await this.exclusive(symbol, async () => {
      const current = this.store.get(symbol);
      if (!current) return; // closed while this was queued
      if ((newStop - current.stopLoss) * direction > 0) await this.replaceStop(current, newStop);
      if (target === null && current.takeProfit !== null) await this.dropTarget(this.store.get(symbol) ?? current);
    });
  }

  private async placeWithRetry(symbol: string, side: 'BUY' | 'SELL', type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET', stopPrice: number): Promise<number | undefined> {
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try { return (await this.port.placeConditional({ symbol, side, type, stopPrice })).orderId; }
      catch (err) { this.options.log(`live book: ${type} ${symbol} @ ${stopPrice} attempt ${attempt}/${this.attempts} failed: ${errText(err)}`, 'warn'); }
    }
    return undefined;
  }

  private async replaceStop(meta: LiveMeta, newStop: number): Promise<void> {
    const exitSide = exitSideOf(meta.side);
    if (meta.stopOrderId !== undefined) {
      try { await this.port.cancel(meta.symbol, meta.stopOrderId); }
      catch (err) {
        // Nothing has changed on the exchange: the old stop still stands. Try again on a later tick.
        this.options.log(`live book: could not cancel the old ${meta.symbol} stop (${errText(err)}); stop left at ${meta.stopLoss}`, 'warn');
        return;
      }
    }
    const placed = await this.placeWithRetry(meta.symbol, exitSide, 'STOP_MARKET', newStop);
    if (placed !== undefined) {
      this.store.set({ ...meta, stopLoss: newStop, stopOrderId: placed });
      this.options.log(`live book: ${meta.symbol} stop ${meta.stopLoss} -> ${newStop}`, 'info');
      return;
    }
    const restored = await this.placeWithRetry(meta.symbol, exitSide, 'STOP_MARKET', meta.stopLoss);
    if (restored !== undefined) {
      this.store.set({ ...meta, stopOrderId: restored });
      this.options.log(`live book: ${meta.symbol} new stop failed; the previous stop at ${meta.stopLoss} was restored`, 'error');
      return;
    }
    await this.emergencyClose(meta, 'could neither place the new stop nor restore the old one');
  }

  private async dropTarget(meta: LiveMeta): Promise<void> {
    if (meta.tpOrderId !== undefined) {
      try { await this.port.cancel(meta.symbol, meta.tpOrderId); }
      catch (err) { this.options.log(`live book: could not cancel the ${meta.symbol} target (${errText(err)}); it stays`, 'warn'); return; }
    }
    this.store.set({ ...meta, takeProfit: null, tpOrderId: undefined });
    this.options.log(`live book: ${meta.symbol} fixed target dropped, the trail decides`, 'info');
  }

  private async auditProtection(symbol: string): Promise<void> {
    const meta = this.store.get(symbol);
    if (!meta) return;
    let open: LiveOpenOrder[];
    try { open = await this.port.openOrders(symbol); }
    catch (err) { this.options.log(`live book: open orders ${symbol} unavailable (${errText(err)}); stop audit skipped`, 'warn'); return; }
    const exitSide = exitSideOf(meta.side);
    const stop = open.find((o) => o.type === 'STOP_MARKET' && o.closePosition && o.side === exitSide);
    if (stop) {
      // The exchange is the truth: adopt a stop someone replaced by hand, loosened or not, so the ratchet follows reality
      if (stop.orderId !== meta.stopOrderId || stop.stopPrice !== meta.stopLoss) this.store.set({ ...meta, stopOrderId: stop.orderId, stopLoss: stop.stopPrice });
      return;
    }
    // No stop in a snapshot taken moments ago. A stop that TRIGGERED looks the same, so confirm the position is still open
    // (read AFTER the orders) before re-placing anything or closing anything.
    const current = (await this.port.fetchPositions()).find((p) => p.symbol === symbol);
    this.refreshRaw(symbol, current);
    if (!current || sideOfAmount(current.positionAmt) !== meta.side) {
      this.store.delete(symbol);
      this.sim.delete(symbol);
      return;
    }
    this.options.log(`live book: ${symbol} has NO stop order on the exchange; re-placing it at ${meta.stopLoss}`, 'error');
    const placed = await this.placeWithRetry(symbol, exitSide, 'STOP_MARKET', meta.stopLoss);
    if (placed !== undefined) { this.store.set({ ...meta, stopOrderId: placed }); return; }
    await this.emergencyClose(meta, 'unprotected and the stop could not be re-placed');
  }

  private refreshRaw(symbol: string, position: LivePositionRaw | undefined): void {
    if (position) this.raw.set(symbol, position); else this.raw.delete(symbol);
  }

  private async emergencyClose(meta: LiveMeta, reason: string): Promise<void> {
    this.options.log(`live book: EMERGENCY CLOSE ${meta.symbol}: ${reason}`, 'error');
    // The cached quantity can be seconds old (a partial may have reduced it); an oversized reduce-only order is rejected
    // exactly when this matters, so size from the exchange and fall back to the cache only if that read fails
    let held = this.raw.get(meta.symbol);
    try { held = (await this.port.fetchPositions()).find((p) => p.symbol === meta.symbol); this.refreshRaw(meta.symbol, held); }
    catch (err) { this.options.log(`live book: could not re-read ${meta.symbol} before the emergency close (${errText(err)}); using the last known size`, 'warn'); }
    const quantity = held ? roundQty(meta.symbol, Math.abs(held.positionAmt)) : 0;
    if (!(quantity > 0)) return;
    try {
      await this.port.marketReduce({ symbol: meta.symbol, side: exitSideOf(meta.side), quantity, clientOrderId: `pm-emergency-${meta.symbol}-${this.now()}-${this.sequence++}` });
    } catch (err) {
      this.options.log(`live book: EMERGENCY CLOSE of ${meta.symbol} FAILED (${errText(err)}); the position is open and may be unprotected`, 'error');
    }
  }
}
