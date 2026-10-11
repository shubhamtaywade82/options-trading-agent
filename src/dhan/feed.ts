import type { DhanClient } from '@nemesis-oss/dhanhq-sdk';
import type { InstrumentRef, Tick } from '../domain/types.js';
import { instrumentKey } from '../domain/types.js';
import { dhanEpochSecondsToMs } from '../time/ist.js';

type FeedClient = Pick<DhanClient, 'ws'>;

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
    private readonly options: { istShiftedTimestamps: boolean; now?: () => number },
  ) {}

  private get now(): () => number {
    return this.options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.client.ws.market.on('tick', (value: unknown) => this.handlePacket(value));
    await this.client.ws.connect();
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
