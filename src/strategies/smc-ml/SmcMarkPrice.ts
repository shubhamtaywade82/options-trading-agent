export interface SmcMarkPriceEvent {
  symbol: string;
  markPrice: number;
}

export function parseMarkPriceEvent(payload: unknown): SmcMarkPriceEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const event = payload as { e?: unknown; s?: unknown; p?: unknown };
  if (event.e !== 'markPriceUpdate' || typeof event.s !== 'string') return null;

  const markPrice = Number(event.p);
  if (!Number.isFinite(markPrice) || markPrice <= 0) return null;

  return {
    symbol: event.s.toUpperCase(),
    markPrice,
  };
}
