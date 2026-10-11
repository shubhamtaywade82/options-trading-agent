import type { MarketState } from '../market/types.js';
import type { Signal } from '../types.js';
import type { SetupMap, SetupScenario } from './SetupTypes.js';
import type { CouncilResult } from '../llm/types.js';

/**
 * Queued council signals are drained on the next cycle; anything older than
 * this is stale evidence and is dropped rather than traded on.
 */
export const COUNCIL_SIGNAL_TTL_MS = 5 * 60_000;

function matchingScenario(setup: SetupMap, scenarioId: string | null): SetupScenario | null {
  if (!scenarioId) return null;
  return setup.scenarios.find((s) => s.id === scenarioId) ?? null;
}

/**
 * Converts a council TRADE verdict into a real Signal — but only when the
 * verdict targets a scenario the deterministic engine has itself already
 * confirmed (state === 'TRIGGERED'). The council can never invent its own
 * entry/stop/target: those always come from the scenario, so an LLM
 * hallucination can at worst pick the wrong (but still real, already
 * risk-vetted) setup, never a fabricated price level. The chair prompt says
 * "you do not place orders and cannot override deterministic risk or
 * execution controls" — this is the code that actually enforces that: the
 * result still passes through RiskAgent.gate() like every other signal.
 *
 * Returns null (no trade) for anything short of that: WATCH/NO_TRADE
 * verdicts, a NEUTRAL stance, a scenario that is only FORMING/ARMED, a
 * mismatched direction, or a probability below the configured floor.
 */
export function buildCouncilSignal(
  state: MarketState,
  setup: SetupMap,
  result: CouncilResult,
  minProbability: number,
): Signal | null {
  const { chair } = result;
  if (chair.action !== 'TRADE' || chair.stance === 'NEUTRAL') return null;
  if (chair.probability < minProbability) return null;

  const scenario = matchingScenario(setup, chair.scenarioId);
  if (!scenario || scenario.state !== 'TRIGGERED') return null;
  // Fail closed: a trigger is an event, not an order. Execution needs the deterministic gate's ENTRY_ELIGIBLE
  // on the authoritative thesis; a scenario that never went through the pipeline has no verdict and is refused.
  if (scenario.quality?.verdict !== 'ENTRY_ELIGIBLE' || scenario.thesisRole === 'COMPETING') return null;
  if ((chair.stance === 'LONG') !== (scenario.direction === 'LONG')) return null;

  return {
    id: `council-${state.symbol}-${scenario.id}-${state.generatedAt}`,
    ts: Date.now(),
    agent: 'AI-COUNCIL-κ',
    symbol: state.symbol,
    type: scenario.direction === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
    confidence: chair.probability,
    entry: state.mark,
    stopLoss: scenario.stopLoss,
    takeProfit: scenario.target1,
    reason: `AI council TRADE (${(chair.probability * 100).toFixed(0)}%) on ${scenario.kind} ${scenario.id}: ${chair.rationale}`,
  };
}
