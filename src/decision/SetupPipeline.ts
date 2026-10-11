import type { FlowContext } from '../market/FlowTracker.js';
import type { MarketState } from '../market/types.js';
import type { CostRates } from '../risk/rrProfile.js';
import { locationAtEntry, sweepEvidence } from './SetupEvidence.js';
import { assessScenario } from './SetupQuality.js';
import type { SetupMap } from './SetupTypes.js';

/**
 * Stamps every scenario with entry-location, sweep evidence and the deterministic quality verdict.
 * Runs after the ledger so it judges the frozen levels and pinned lifecycle, not this cycle's drift.
 */
export function annotateSetupMap(state: MarketState, map: SetupMap, flow: FlowContext | undefined, costs: CostRates): SetupMap {
  const atr = state.timeframes['15m'].atr14 ?? 0;
  const withFlow: SetupMap = { ...map, flow };
  const scenarios = map.scenarios.map((scenario) => {
    const base = { ...scenario, locationAtEntry: locationAtEntry(state, scenario) ?? undefined, evidence: sweepEvidence(state, scenario, atr) ?? undefined };
    return { ...base, quality: assessScenario(base, withFlow, costs) };
  });
  return { ...withFlow, scenarios };
}
