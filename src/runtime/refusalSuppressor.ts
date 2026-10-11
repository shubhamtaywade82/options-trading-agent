import { classifyRiskRefusal, isStandingBlock } from '../decision/NoTrade.js';
import type { Position, Signal } from '../types.js';

export interface PortfolioSnapshot {
  equity: number;
  positions: readonly Position[];
  circuit?: string;
}

const EQUITY_BUCKET = 0.01;

/** Changes here can flip a capacity block; anything finer (a price tick) cannot. */
function signatureOf({ equity, positions, circuit }: PortfolioSnapshot): string {
  const book = [...positions]
    .map((p) => `${p.symbol}:${p.strategy}:${p.side}:${Math.round(p.qty * p.mark)}`)
    .sort()
    .join('|');
  const bucket = equity > 0 ? Math.round(Math.log(equity) / Math.log(1 + EQUITY_BUCKET)) : 0;
  return `${circuit ?? ''}#${bucket}#${book}`;
}

const keyOf = (signal: Signal): string => `${signal.symbol}:${signal.agent}:${signal.type}`;

/**
 * A capacity or circuit block is a standing state. Once a signal is refused for one, re-gating the same
 * signal while the portfolio is unchanged can only repeat the refusal, so it is skipped until the book,
 * equity bucket or circuit state moves.
 */
export class RefusalSuppressor {
  private readonly blocked = new Map<string, string>();

  shouldSkip(signal: Signal, portfolio: PortfolioSnapshot): boolean {
    const stored = this.blocked.get(keyOf(signal));
    if (stored === undefined) return false;
    if (stored === signatureOf(portfolio)) return true;
    this.blocked.delete(keyOf(signal));
    return false;
  }

  /** Call with every refusal; only standing blocks are remembered. */
  noteRefusal(signal: Signal, reason: string, portfolio: PortfolioSnapshot): void {
    if (isStandingBlock(classifyRiskRefusal(reason))) this.blocked.set(keyOf(signal), signatureOf(portfolio));
  }

  /** An approval proves the block cleared. */
  noteApproval(signal: Signal): void {
    this.blocked.delete(keyOf(signal));
  }
}
