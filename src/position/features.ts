import type { AgentId } from '../types.js';
import type { MarketState } from '../market/types.js';
import type { SymbolFeatures } from './PositionDriver.js';
import type { VolClass } from './PositionManager.js';

export interface AdaptiveFeatures {
  agent: AgentId;
  assignedAtr: number;
  regime: VolClass;
  superTrend: number;
}

/** Slow-loop inputs of the position manager, shared by the orchestrator and the replay so both manage on identical numbers. */
export function featuresFromState(state: MarketState | undefined, adaptive?: AdaptiveFeatures): SymbolFeatures {
  return {
    atr: adaptive?.assignedAtr ?? state?.timeframes?.['15m']?.atr14 ?? null,
    vol: adaptive?.regime ?? state?.regime?.volatility ?? 'MEDIUM',
    swingLow: state?.ltfStructure?.protectedLow?.price ?? null,
    swingHigh: state?.ltfStructure?.protectedHigh?.price ?? null,
    superTrend: adaptive ? { agent: adaptive.agent, level: adaptive.superTrend } : null,
  };
}
