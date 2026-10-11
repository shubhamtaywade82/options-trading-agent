/** Machine-readable reasons a candidate ends in NO_TRADE; the audit trail keys on these, not on prose. */
export const NO_TRADE_REASONS = [
  'RR_TOO_LOW',
  'PORTFOLIO_CAPACITY',
  'CIRCUIT_BREAKER',
  'RISK_PER_TRADE',
  'LEVERAGE',
  'SIZING_FAILED',
  'OTHER_RISK',
  'STALE_SETUP',
  'ENTRY_MISSED',
  'INSUFFICIENT_CONFIRMATION',
  'FLOW_NOT_CONFIRMED',
  'COST_ADJUSTED_EDGE_TOO_LOW',
  'CONFLICTING_TIMEFRAMES',
  'ENTRY_LOCATION',
  'CONFLICTING_THESIS',
  'DEGENERATE_GEOMETRY',
  'LIQ_BUFFER',
  'NOT_APPROVED',
] as const;
export type NoTradeReason = (typeof NO_TRADE_REASONS)[number];

/** Blocks that are standing states: they cannot clear until the portfolio or circuit changes. */
const STANDING: ReadonlySet<NoTradeReason> = new Set(['PORTFOLIO_CAPACITY', 'CIRCUIT_BREAKER']);

/** Maps a risk-engine refusal ("risk-engine: name: detail; name: detail") to a code; the first failing check wins. */
export function classifyRiskRefusal(reason: string): NoTradeReason {
  // The legacy (engine-off) gate speaks in prose, not `check: detail`; its capacity and drawdown blocks are standing states too
  if (/drawdown kill-switch|^kill-switch:/.test(reason)) return 'CIRCUIT_BREAKER';
  if (/max gross exposure|max concurrent positions/.test(reason)) return 'PORTFOLIO_CAPACITY';
  if (/^liq buffer /.test(reason)) return 'LIQ_BUFFER';
  if (/not approved for live trading/.test(reason)) return 'NOT_APPROVED';
  const text = reason.replace(/^risk-engine:\s*/, '');
  const name = /^([a-z_]+):/.exec(text)?.[1];
  switch (name) {
    case 'min_rr': return 'RR_TOO_LOW';
    case 'portfolio_limits':
    case 'position_count': return 'PORTFOLIO_CAPACITY';
    case 'circuit_breaker':
    case 'daily_loss':
    case 'loss_streak': return 'CIRCUIT_BREAKER';
    case 'risk_per_trade': return 'RISK_PER_TRADE';
    case 'leverage': return 'LEVERAGE';
    case 'sizing': return 'SIZING_FAILED';
    default: return 'OTHER_RISK';
  }
}

export const isStandingBlock = (reason: NoTradeReason): boolean => STANDING.has(reason);
