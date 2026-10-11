import type { TradeRecord } from '../types.js';

/** Same position: the decision that opened it, else symbol + strategy + side + entry. */
const samePosition = (a: TradeRecord, b: TradeRecord): boolean =>
  a.decisionId !== undefined || b.decisionId !== undefined
    ? a.decisionId === b.decisionId
    : a.symbol === b.symbol && a.strategy === b.strategy && a.side === b.side && a.entry === b.entry;

/**
 * Merges a final close with the partial exits of the same position that preceded it: total quantity, total gross PnL and
 * the quantity-weighted exit, so R = total PnL / (1R x total quantity). A trade without partials is returned unchanged.
 */
export function wholePosition(final: TradeRecord, all: readonly TradeRecord[]): TradeRecord {
  // Partials of an earlier position with the same key end at that position's own final close
  const earlierFinal = all.filter((t) => !t.partial && t !== final && t.closedAt < final.closedAt && samePosition(t, final))
    .reduce((latest, t) => Math.max(latest, t.closedAt), 0);
  const partials = all.filter((t) => t.partial && t.closedAt <= final.closedAt && t.closedAt > earlierFinal && samePosition(t, final));
  if (partials.length === 0) return final;
  const qty = partials.reduce((sum, t) => sum + t.qty, final.qty);
  const pnl = partials.reduce((sum, t) => sum + t.pnl, final.pnl);
  const direction = final.side === 'LONG' ? 1 : -1;
  return { ...final, qty, pnl, exit: qty > 0 ? final.entry + (direction * pnl) / qty : final.exit };
}


/**
 * Journal view with one record per finished position: every final close absorbs its partials, which are dropped.
 * A partial whose position is still open stays (its profit is realized), so sums over the result still equal realized PnL.
 */
export function foldPartials(trades: readonly TradeRecord[]): TradeRecord[] {
  const absorbed = new Set<TradeRecord>();
  const folded = trades.map((trade) => {
    if (trade.partial) return trade;
    const whole = wholePosition(trade, trades);
    if (whole !== trade) {
      for (const t of trades) if (t.partial && t.closedAt <= trade.closedAt && samePosition(t, trade) && t.qty > 0) absorbed.add(t);
    }
    return whole;
  });
  return folded.filter((t) => !absorbed.has(t));
}
