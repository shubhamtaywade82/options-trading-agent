import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import type { InstrumentRef, Tick } from '../domain/types.js';
import { instrumentKey } from '../domain/types.js';
import type { Logger } from '../ops/logger.js';
import { dhanEpochSecondsToMs } from '../time/ist.js';

type FeedClient = Pick<DhanClient, 'ws'>;

export type DhanMarketFeedMode = 'ticker' | 'quote' | 'full';

export interface DhanFeedOptions {
  readonly istShiftedTimestamps: boolean;
  /** Dhan WS RequestCode for subscriptions. Use ticker or quote for index spots (IDX_I). */
  readonly marketFeedMode?: DhanMarketFeedMode;
  readonly now?: () => number;
  /** Where socket errors are logged. Errors are handled either way, so a missing logger never crashes the process. */
  readonly logger?: Logger;
  /**
   * Opens the order-update socket as well as the market socket. Live mode needs it for fills. Sandbox and paper
   * never use it, and the Dhan sandbox serves no WebSocket, so it stays closed there. Defaults to false.
   */
  readonly connectOrderUpdates?: boolean;
  /** Called once, with the reason code, when the server ends the market feed for good. */
  readonly onTerminalDisconnect?: ((code: number) => void) | undefined;
}

/**
 * Server disconnect reasons that reconnecting cannot clear: no Data API plan, bad token or client id, the instrument or
 * connection cap, an expired token (SDK 2.1.0 `FEED_TERMINAL_DISCONNECT_CODES`). The SDK stops the market socket for these
 * and emits no error, so the feed must record the stop itself or it goes silent.
 */
export const TERMINAL_FEED_DISCONNECT_CODES: readonly number[] = [804, 805, 806, 807, 808, 809, 810];

interface PriceEvent {
  readonly type: 'ticker' | 'quote' | 'full';
  readonly exchangeSegment: string;
  readonly securityId: string;
  readonly ltp: number;
  readonly ltt: number;
}

/** Narrows a market-feed packet to one that carries a last-traded price and time. */
export function asPriceEvent(value: unknown): PriceEvent | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Partial<PriceEvent>;
  const priceType = candidate.type === 'ticker' || candidate.type === 'quote' || candidate.type === 'full';
  if (
    !priceType ||
    typeof candidate.exchangeSegment !== 'string' ||
    typeof candidate.securityId !== 'string' ||
    typeof candidate.ltp !== 'number' ||
    typeof candidate.ltt !== 'number' ||
    !Number.isFinite(candidate.ltp) ||
    candidate.ltp <= 0
  ) {
    return undefined;
  }
  return candidate as PriceEvent;
}

/**
 * Live LTP feed over the Dhan market socket. Ticks are keyed by the composite
 * `exchangeSegment:securityId`. Staleness runs from the older of local receipt
 * and exchange time, so neither a dead socket nor a delayed packet looks fresh.
 * Reconnection and re-subscription are handled by the SDK.
 */
/** Allowance for clock skew between this host and the exchange's trade stamps. */
const FUTURE_LTT_TOLERANCE_MS = 60_000;
/** A tick whose exchange time lags receipt by more than this is reported once: feed delay, or a host clock running fast. */
const LATE_LTT_WARN_MS = 5_000;

export class DhanFeed {
  private readonly listeners = new Set<(tick: Tick) => void>();
  private readonly lastReceived = new Map<string, number>();
  private readonly subscriptions = new Map<string, InstrumentRef>();
  private started = false;
  private warnedFutureLtt = false;
  private warnedLateLtt = false;
  private terminalCode: number | undefined;

  constructor(
    private readonly client: FeedClient,
    private readonly options: DhanFeedOptions,
  ) {}

  private get now(): () => number {
    return this.options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    if (this.options.marketFeedMode !== undefined) {
      (this.client.ws.market as unknown as { mode?: DhanMarketFeedMode }).mode = this.options.marketFeedMode;
    }
    const { market, orders } = this.client.ws;
    market.on('tick', (value: unknown) => this.handlePacket(value));
    // The SDK re-emits a socket's connection errors as `error` events. With no listener, Node throws and the process
    // dies, so every socket this feed opens gets one before it connects.
    market.on('error', (error: unknown) => this.reportSocketError('market feed', error));
    market.on('disconnect', (event: unknown) => this.handleDisconnect(event));
    if (this.options.connectOrderUpdates === true) {
      orders.on('error', (error: unknown) => this.reportSocketError('order update', error));
      await this.client.ws.connect();
      return;
    }
    await market.connect();
  }

  /** The reason code that ended the market feed for good, or undefined while the feed is recoverable. */
  terminalDisconnectCode(): number | undefined {
    return this.terminalCode;
  }

  private handleDisconnect(event: unknown): void {
    const code = (event as { reasonCode?: unknown } | null | undefined)?.reasonCode;
    if (typeof code !== 'number' || !TERMINAL_FEED_DISCONNECT_CODES.includes(code) || this.terminalCode !== undefined) {
      return;
    }
    this.terminalCode = code;
    this.options.logger?.error(`market feed ended by the server with code ${code}; entries stay refused until the feed is restarted`, { code });
    this.options.onTerminalDisconnect?.(code);
  }

  /**
   * Logs a socket error by its name and code only. The SDK's socket URLs carry the access token, so the message
   * is not logged. Ticks stop while the socket is down, and the stale-feed check refuses entries until they resume.
   */
  private reportSocketError(socket: string, error: unknown): void {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    this.options.logger?.error(`${socket} socket error; entries are refused while ticks are stale`, {
      error: error instanceof Error ? error.name : 'unknown',
      code: typeof code === 'string' ? code : undefined,
    });
  }

  subscribe(refs: readonly InstrumentRef[]): void {
    const fresh = refs.filter((ref) => !this.subscriptions.has(instrumentKey(ref)));
    if (fresh.length === 0) {
      return;
    }
    for (const ref of fresh) {
      this.subscriptions.set(instrumentKey(ref), ref);
    }
    this.client.ws.market.subscribe(fresh.map((ref) => ({ exchangeSegment: ref.exchangeSegment, securityId: ref.securityId })));
  }

  unsubscribe(refs: readonly InstrumentRef[]): void {
    const held = refs.filter((ref) => this.subscriptions.has(instrumentKey(ref)));
    if (held.length === 0) {
      return;
    }
    for (const ref of held) {
      this.subscriptions.delete(instrumentKey(ref));
      this.lastReceived.delete(instrumentKey(ref));
    }
    this.client.ws.market.unsubscribe(held.map((ref) => ({ exchangeSegment: ref.exchangeSegment, securityId: ref.securityId })));
  }

  onTick(listener: (tick: Tick) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Milliseconds since the last tick's exchange time, or its receipt if that is earlier; undefined if never. */
  ageMs(ref: InstrumentRef, nowMs = this.now()): number | undefined {
    const received = this.lastReceived.get(instrumentKey(ref));
    return received === undefined ? undefined : nowMs - received;
  }

  stop(): void {
    this.started = false;
    this.client.ws.disconnect();
    this.listeners.clear();
  }

  private handlePacket(value: unknown): void {
    const event = asPriceEvent(value);
    if (event === undefined) {
      return;
    }
    const receivedAt = this.now();
    const key = `${event.exchangeSegment}:${event.securityId}`;
    if (!this.subscriptions.has(key)) {
      return;
    }
    const ltt = dhanEpochSecondsToMs(event.ltt, this.options.istShiftedTimestamps);
    // A delayed packet must not look fresh, so age runs from the older of receipt and exchange time. A future LTT
    // (wrong convention, reported below) falls back to receipt time.
    this.lastReceived.set(key, Math.min(receivedAt, ltt));
    // A trade cannot happen after it is received. A tick from the future means the LTT convention is wrong, which
    // moves bars and fill times by 5h30m, so it is reported loudly, once.
    if (ltt > receivedAt + FUTURE_LTT_TOLERANCE_MS && !this.warnedFutureLtt) {
      this.warnedFutureLtt = true;
      this.options.logger?.error('feed LTT is ahead of the clock; check DHAN_FEED_IST_SHIFTED', { aheadMs: ltt - receivedAt });
    }
    if (receivedAt - ltt > LATE_LTT_WARN_MS && !this.warnedLateLtt) {
      this.warnedLateLtt = true;
      this.options.logger?.warn('feed tick exchange time lags receipt; entries refuse stale ticks. Check feed delay or host clock (NTP)', {
        key,
        lagMs: receivedAt - ltt,
      });
    }
    const tick: Tick = {
      exchangeSegment: event.exchangeSegment,
      securityId: event.securityId,
      ltp: event.ltp,
      ltt,
    };
    for (const listener of this.listeners) {
      listener(tick);
    }
  }
}
