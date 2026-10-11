import type { Signal } from '../types.js';
import type { MarketState, MarketRegime } from '../market/types.js';

// Which regimes each strategy is allowed to trade in.
// Omitting an agent = no regime gate (legacy agents, funding arb, etc.)
const REGIME_ALLOW: Partial<Record<string, Set<MarketRegime>>> = {
  // Uses HTF structure (CHOCH/BOS) which is valid in transitional markets too
  'STRUCTURE-TREND-η': new Set(['TREND_UP', 'TREND_DOWN', 'HIGH_VOL', 'TRANSITION']),
  'MEAN-REVERT-θ':     new Set(['RANGE', 'LOW_VOL']),
  // Uses crowding + liquidity sweeps — both meaningful in any regime
  'CROWDING-ι':        new Set(['TREND_UP', 'TREND_DOWN', 'RANGE', 'TRANSITION']),
  'MOMENTUM-γ':        new Set(['TREND_UP', 'TREND_DOWN', 'HIGH_VOL']),
  // The setup itself requires a directional regime; the router states the same domain
  'STRUCT-LIQ-η':      new Set(['TREND_UP', 'TREND_DOWN']),
};

/**
 * Returns false when the signal's agent is explicitly blocked in the current regime.
 * Signals from agents without a regime rule always pass.
 */
export function isRouted(signal: Signal, state: MarketState | undefined): boolean {
  const allowed = REGIME_ALLOW[signal.agent];
  if (!allowed || !state) return true; // no gate or no state → pass through
  return allowed.has(state.regime.regime);
}

/**
 * Filters a signal list by regime routing, logging vetoed signals.
 * Returns [passed, vetoed] counts for the caller to log.
 */
export function applyRouter(
  signals: Signal[],
  states: Record<string, MarketState>,
): { passed: Signal[]; vetoed: Array<{ agent: string; symbol: string; regime: string }> } {
  const passed: Signal[] = [];
  const vetoed: Array<{ agent: string; symbol: string; regime: string }> = [];
  for (const s of signals) {
    const state = states[s.symbol];
    if (isRouted(s, state)) { passed.push(s); continue; }
    vetoed.push({ agent: s.agent, symbol: s.symbol, regime: state!.regime.regime });
  }
  return { passed, vetoed };
}
