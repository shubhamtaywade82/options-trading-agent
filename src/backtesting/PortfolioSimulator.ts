import type { AgentId, Candle, Position, Side } from '../types.js';
import type { MarketRegime } from '../market/types.js';
import { ExecutionSimulator, liquidationPrice } from './ExecutionSimulator.js';
import type { SimTrade } from './types.js';
import { advance, initState, type LotRules, type PmConfig, type PmInput, type PmState } from '../position/PositionManager.js';
import type { SymbolFeatures } from '../position/PositionDriver.js';

/** Position-manager hooks for the bar loop; absent means the legacy fixed stop/target behaviour. */
export interface BarManager {
  cfg: PmConfig;
  features(symbol: string): SymbolFeatures | undefined;
  lot(symbol: string): LotRules;
}

const SWING_BUFFER_ATR = 0.15;

interface SimPosition {
  symbol: string;
  side: Side;
  strategy: AgentId;
  entry: number;
  qty: number;
  leverage: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: number;
  initialRisk: number | null;
  decisionId?: string;
  regime: MarketRegime;
  evidenceScore: number | null;
  mark: number;
  fees: number;
  funding: number;
  slippage: number;
  /** Extremes seen since entry, in price units, updated on every bar. */
  best: number;
  worst: number;
  positionId: string;
  pm: PmState | null;
}

export interface OpenRequest {
  symbol: string;
  side: Side;
  qty: number;
  leverage: number;
  strategy: AgentId;
  stopLoss?: number;
  takeProfit?: number;
  decisionId?: string;
  regime: MarketRegime;
  evidenceScore: number | null;
  fillPrice: number;
  fee: number;
  slippage: number;
  openedAt: number;
}

export interface ExitFill {
  symbol: string;
  price: number;
  reason: SimTrade['reason'];
}

/**
 * Multi-symbol, multi-position portfolio for replay. One position per symbol —
 * the same netting rule the paper and remote brokers enforce — with realized
 * PnL, fees and funding booked into equity as they happen.
 */
export class PortfolioSimulator {
  private positions: SimPosition[] = [];
  private realized = 0;
  private positionCounter = 0;
  private readonly trades: SimTrade[] = [];

  constructor(private readonly initialEquity: number, private readonly simulator: ExecutionSimulator) {}

  /** One strategy per symbol, mirroring the venue ownership rule. */
  holderOf(symbol: string): SimPosition | undefined {
    return this.positions.find((p) => p.symbol === symbol);
  }

  positionCount(): number {
    return this.positions.length;
  }

  open(request: OpenRequest): void {
    // Fees leave the wallet the moment they are charged; price friction (spread/slippage) is already inside the fill price
    this.realized -= request.fee;
    this.positions.push({
      symbol: request.symbol,
      side: request.side,
      strategy: request.strategy,
      entry: request.fillPrice,
      qty: request.qty,
      leverage: request.leverage,
      stopLoss: request.stopLoss ?? null,
      takeProfit: request.takeProfit ?? null,
      openedAt: request.openedAt,
      initialRisk: request.stopLoss !== undefined ? Math.abs(request.fillPrice - request.stopLoss) : null,
      ...(request.decisionId === undefined ? {} : { decisionId: request.decisionId }),
      regime: request.regime,
      evidenceScore: request.evidenceScore,
      mark: request.fillPrice,
      fees: request.fee,
      funding: 0,
      slippage: request.slippage,
      best: request.fillPrice,
      worst: request.fillPrice,
      positionId: `${request.symbol}:${request.strategy}:${request.openedAt}:${this.positionCounter++}`,
      pm: null,
    });
  }

  /**
   * Marks positions of `symbol` to the bar's close and resolves exits. Without a manager: liquidation, stop, target
   * (stop first). With one, the bar is walked adverse-extreme first (open -> low -> high -> close for a long):
   * stop/liquidation, then partials and stop moves at the favourable extreme, then the remaining target, and finally a
   * stop moved on this bar is tested against the close, the only point of the path that follows the favourable extreme.
   * Stop moves therefore never help a trade on the bar that produced them.
   */
  onBar(symbol: string, bar: Candle, manager?: BarManager): ExitFill[] {
    const exits: ExitFill[] = [];
    for (const pos of [...this.positions]) {
      if (pos.symbol !== symbol) continue;
      pos.mark = bar.close;
      // Best = most favorable price seen since entry; worst = most adverse. LONG gains upward, SHORT gains downward.
      if (pos.side === 'LONG') {
        pos.best = Math.max(pos.best, bar.high);
        pos.worst = Math.min(pos.worst, bar.low);
      } else {
        pos.best = Math.min(pos.best, bar.low);
        pos.worst = Math.max(pos.worst, bar.high);
      }
      const closedAt = bar.openTime + 15 * 60_000;
      const exit = manager
        ? this.simulator.evaluateExit({ ...pos, takeProfit: null }, bar)
        : this.simulator.evaluateExit(pos, bar);
      if (exit) {
        exits.push(this.closeAt(pos, exit.price, exit.reason, closedAt));
        continue;
      }
      if (!manager) continue;
      const movedStop = this.manage(pos, bar, manager, closedAt);
      const targetExit = this.simulator.evaluateExit({ ...pos, stopLoss: null }, bar);
      if (targetExit) {
        exits.push(this.closeAt(pos, targetExit.price, targetExit.reason, closedAt));
        continue;
      }
      const dir = pos.side === 'LONG' ? 1 : -1;
      if (movedStop && pos.stopLoss !== null && (bar.close - pos.stopLoss) * dir <= 0) {
        exits.push(this.closeAt(pos, pos.stopLoss, 'STOP LOSS', closedAt));
      }
    }
    return exits;
  }

  /** Runs the manager at the bar's favourable extreme; returns true when it moved the stop. */
  private manage(pos: SimPosition, bar: Candle, manager: BarManager, closedAt: number): boolean {
    const { cfg } = manager;
    pos.pm ??= initState(this.toPosition(pos), bar.openTime, cfg);
    if (!pos.pm) return false;
    const dir = pos.side === 'LONG' ? 1 : -1;
    const f = manager.features(pos.symbol);
    const atr = f?.atr ?? null;
    const swing = pos.side === 'LONG' ? f?.swingLow : f?.swingHigh;
    const buffer = (atr ?? 0) * SWING_BUFFER_ATR;
    const input: PmInput = {
      mark: dir === 1 ? bar.high : bar.low, qty: pos.qty, atr, vol: f?.vol ?? 'MEDIUM',
      swingStop: typeof swing === 'number' ? (dir === 1 ? swing - buffer : swing + buffer) : null,
      superTrend: f?.superTrend && f.superTrend.agent === pos.strategy ? f.superTrend.level : null,
      lot: manager.lot(pos.symbol),
    };
    const result = advance(pos.pm, input, cfg, bar.openTime);
    pos.pm = result.state;
    let moved = false;
    for (const action of result.actions) {
      if (action.type === 'REDUCE') {
        const rMultiple = action.reason === 'TP1' ? cfg.tp1R : cfg.tp2R;
        const level = result.state.entry + dir * rMultiple * result.state.oneR;
        // A gap through the level fills at the open (better for the seller), never at an unreachable level
        const price = dir === 1 ? Math.max(level, bar.open) : Math.min(level, bar.open);
        this.reduce(pos, action.qty, price, closedAt);
      } else {
        pos.stopLoss = action.stop;
        pos.takeProfit = action.target;
        moved = true;
      }
    }
    return moved;
  }

  /** Books a partial take-profit leg: realized PnL and fees now, the rest of the position stays open. */
  private reduce(pos: SimPosition, qty: number, price: number, closedAt: number): void {
    const quote = this.simulator.exit(pos.side, price, qty);
    const direction = pos.side === 'LONG' ? 1 : -1;
    const gross = (quote.price - pos.entry) * qty * direction;
    this.realized += gross - quote.fee;
    const riskUnit = pos.initialRisk && pos.initialRisk > 0 ? pos.initialRisk : null;
    this.trades.push({
      symbol: pos.symbol, strategy: pos.strategy, side: pos.side, entry: pos.entry, exit: quote.price, qty, pnl: gross,
      reason: 'PARTIAL TP', partial: true, closedAt, positionId: pos.positionId,
      ...(pos.initialRisk === null ? {} : { initialRisk: pos.initialRisk }),
      ...(pos.decisionId === undefined ? {} : { decisionId: pos.decisionId }),
      openedAt: pos.openedAt, regime: pos.regime, evidenceScore: pos.evidenceScore,
      maeR: riskUnit !== null ? Number((((pos.entry - pos.worst) * direction) / riskUnit).toFixed(3)) : null,
      mfeR: riskUnit !== null ? Number((((pos.best - pos.entry) * direction) / riskUnit).toFixed(3)) : null,
      fees: Number(quote.fee.toFixed(6)), funding: 0, slippage: Number(quote.slippage.toFixed(6)),
    });
    pos.qty -= qty;
  }

  /** Closes a position at an explicit price (manual close / emergency drawdown). */
  closeAt(pos: SimPosition, price: number, reason: SimTrade['reason'], closedAt: number): ExitFill {
    const quote = this.simulator.exit(pos.side, price, pos.qty);
    // Gross price pnl — spread and slippage live inside the fill prices, fees and funding are reported separately (venue parity)
    const gross = (quote.price - pos.entry) * pos.qty * (pos.side === 'LONG' ? 1 : -1);
    this.realized += gross - quote.fee;
    const riskUnit = pos.initialRisk && pos.initialRisk > 0 ? pos.initialRisk : null;
    const direction = pos.side === 'LONG' ? 1 : -1;
    this.trades.push({
      symbol: pos.symbol,
      strategy: pos.strategy,
      side: pos.side,
      entry: pos.entry,
      exit: quote.price,
      qty: pos.qty,
      pnl: gross,
      reason,
      closedAt,
      ...(pos.initialRisk === null ? {} : { initialRisk: pos.initialRisk }),
      ...(pos.decisionId === undefined ? {} : { decisionId: pos.decisionId }),
      openedAt: pos.openedAt,
      positionId: pos.positionId,
      regime: pos.regime,
      evidenceScore: pos.evidenceScore,
      maeR: riskUnit !== null ? Number((((pos.entry - pos.worst) * direction) / riskUnit).toFixed(3)) : null,
      mfeR: riskUnit !== null ? Number((((pos.best - pos.entry) * direction) / riskUnit).toFixed(3)) : null,
      fees: Number((pos.fees + quote.fee).toFixed(6)),
      funding: Number(pos.funding.toFixed(6)),
      slippage: Number((pos.slippage + quote.slippage).toFixed(6)),
    });
    this.positions.splice(this.positions.indexOf(pos), 1);
    return { symbol: pos.symbol, price: quote.price, reason };
  }

  /** Same-side add by the owning strategy: weighted-average entry, new levels replace the old ones (venue parity). */
  scaleIn(pos: SimPosition, request: OpenRequest): void {
    this.realized -= request.fee;
    const totalQty = pos.qty + request.qty;
    pos.entry = (pos.entry * pos.qty + request.fillPrice * request.qty) / totalQty;
    pos.qty = totalQty;
    pos.leverage = request.leverage;
    if (request.stopLoss !== undefined) pos.stopLoss = request.stopLoss;
    if (request.takeProfit !== undefined) pos.takeProfit = request.takeProfit;
    pos.fees += request.fee;
    pos.slippage += request.slippage;
    pos.mark = request.fillPrice;
    pos.best = request.fillPrice;
    pos.worst = request.fillPrice;
    pos.pm = null; // the scaled position gets a fresh manager state on the new levels
  }

  /** Applies a funding payment to every open position of `symbol`: longs pay positive rates. */
  applyFunding(symbol: string, rate: number, at: number): void {
    for (const pos of this.positions) {
      if (pos.symbol !== symbol) continue;
      const payment = -rate * pos.mark * pos.qty * (pos.side === 'LONG' ? 1 : -1);
      this.realized += payment;
      pos.funding += payment;
    }
    void at;
  }

  /** Close every open position at the given marks (end-of-replay liquidation of inventory). */
  forceCloseAll(marks: Record<string, number>, at: number, reason: SimTrade['reason'] = 'CLOSE'): void {
    for (const pos of [...this.positions]) {
      const mark = marks[pos.symbol] ?? pos.mark;
      this.closeAt(pos, mark, reason, at);
    }
  }

  unrealized(): number {
    return this.positions.reduce((sum, pos) => sum + (pos.mark - pos.entry) * pos.qty * (pos.side === 'LONG' ? 1 : -1), 0);
  }

  equity(): number {
    return this.initialEquity + this.realized + this.unrealized();
  }

  marginUsed(): number {
    return this.positions.reduce((sum, pos) => sum + (pos.qty * pos.mark) / Math.max(1, pos.leverage), 0);
  }

  account(): { equity: number; marginUsed: number; initialEquity: number } {
    return { equity: this.equity(), marginUsed: this.marginUsed(), initialEquity: this.initialEquity };
  }

  getTrades(): SimTrade[] {
    return [...this.trades];
  }

  /** Production-shaped positions for the risk gates and telemetry. */
  toPositions(): Position[] {
    return this.positions.map((pos) => this.toPosition(pos));
  }

  private toPosition(pos: SimPosition): Position {
    const direction = pos.side === 'LONG' ? 1 : -1;
    const liq = liquidationPrice(pos.side, pos.entry, pos.leverage);
    return {
      id: `${pos.symbol}_${pos.strategy}`,
      symbol: pos.symbol,
      side: pos.side,
      strategy: pos.strategy,
      entry: pos.entry,
      qty: pos.qty,
      mark: pos.mark,
      upnl: (pos.mark - pos.entry) * pos.qty * direction,
      upnlPct: pos.entry ? ((pos.mark - pos.entry) / pos.entry) * 100 * direction : 0,
      leverage: pos.leverage,
      marginType: 'ISOLATED' as const,
      liqDistancePct: liq !== null ? (Math.abs(pos.mark - liq) / pos.mark) * 100 : null,
      serverSl: pos.stopLoss !== null ? String(pos.stopLoss) : '—',
      serverTp: pos.takeProfit !== null ? String(pos.takeProfit) : 'trail',
      ...(pos.initialRisk !== null ? { initialRisk: pos.initialRisk } : {}),
      ...(pos.decisionId === undefined ? {} : { decisionId: pos.decisionId }),
    };
  }
}

/**
 * One record per position: each final close absorbs its partial legs (quantity, gross PnL, fees and slippage summed, the
 * exit quantity-weighted so R = total PnL / (1R x total quantity)). Records without a positionId pass through untouched.
 */
export function foldSimTrades(trades: readonly SimTrade[]): SimTrade[] {
  const legs = new Map<string, SimTrade[]>();
  for (const t of trades) if (t.partial && t.positionId) legs.set(t.positionId, [...(legs.get(t.positionId) ?? []), t]);
  const out: SimTrade[] = [];
  for (const t of trades) {
    if (t.partial) continue;
    const parts = t.positionId ? legs.get(t.positionId) : undefined;
    if (!parts) { out.push(t); continue; }
    const qty = parts.reduce((sum, p) => sum + p.qty, t.qty);
    const pnl = parts.reduce((sum, p) => sum + p.pnl, t.pnl);
    const direction = t.side === 'LONG' ? 1 : -1;
    out.push({
      ...t, qty, pnl, exit: qty > 0 ? t.entry + (direction * pnl) / qty : t.exit,
      fees: Number(parts.reduce((sum, p) => sum + p.fees, t.fees).toFixed(6)),
      slippage: Number(parts.reduce((sum, p) => sum + p.slippage, t.slippage).toFixed(6)),
    });
  }
  return out;
}
