import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import type { InstrumentRef, Tick } from '../domain/types.js';
import { instrumentKey } from '../domain/types.js';
import type { Logger } from '../ops/logger.js';
import { dhanEpochSecondsToMs } from '../time/ist.js';

type FeedClient = Pick<DhanClient, 'ws'>;

export interface DhanFeedOptions {
  readonly istShiftedTimestamps: boolean;
  readonly now?: () => number;
  /** Where socket errors are logged. Errors are handled either way, so a missing logger never crashes the process. */
  readonly logger?: Logger;
  /**
   * Opens the order-update socket as well as the market socket. Live mode needs it for fills. Sandbox and paper
   * never use it, and the Dhan sandbox serves no WebSocket, so it stays closed there. Defaults to false.
   */
  readonly connectOrderUpdates?: boolean;
}

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
 * `exchangeSegment:securityId` and carry the local receipt time so staleness
 * is judged on what this process actually saw, not on the exchange clock.
 * Reconnection and re-subscription are handled by the SDK.
 */
export class DhanFeed {
  private readonly listeners = new Set<(tick: Tick) => void>();
  private readonly lastReceived = new Map<string, number>();
  private readonly subscriptions = new Map<string, InstrumentRef>();
  private started = false;

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
    const { market, orders } = this.client.ws;
    market.on('tick', (value: unknown) => this.handlePacket(value));
    // The SDK re-emits a socket's connection errors as `error` events. With no listener, Node throws and the process
    // dies, so every socket this feed opens gets one before it connects.
    market.on('error', (error: unknown) => this.reportSocketError('market feed', error));
    if (this.options.connectOrderUpdates === true) {
      orders.on('error', (error: unknown) => this.reportSocketError('order update', error));
      await this.client.ws.connect();
      return;
    }
    await market.connect();
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

  /** Milliseconds since this process last received a tick for the instrument; undefined if never. */
  ageMs(ref: InstrumentRef, nowMs = this.now()): number | undefined {
    const received = this.lastReceived.get(instrumentKey(ref));
    return received === undefined ? undefined : nowMs - received;
  }

  stop(): void {
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
    this.lastReceived.set(key, receivedAt);
    const tick: Tick = {
      exchangeSegment: event.exchangeSegment,
      securityId: event.securityId,
      ltp: event.ltp,
      ltt: dhanEpochSecondsToMs(event.ltt, this.options.istShiftedTimestamps),
    };
    for (const listener of this.listeners) {
      listener(tick);
    }
  }
}
