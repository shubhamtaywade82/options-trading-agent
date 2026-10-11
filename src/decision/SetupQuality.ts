import type { FlowContext } from '../market/FlowTracker.js';
import { flowVerdict } from '../market/FlowTracker.js';
import type { CostRates } from '../risk/rrProfile.js';
import { costAdjustedRr } from '../risk/rrProfile.js';
import type { NoTradeReason } from './NoTrade.js';
import type { CheckResult, SetupMap, SetupQuality, SetupScenario } from './SetupTypes.js';

/** Starting thresholds; the setup outcome ledger records every check so they can be tuned on data, never by an LLM. */
export const QUALITY_THRESHOLDS = {
  effectiveRrPass: 1.25,
  effectiveRrWeak: 1.0,
  sweepMinDepthAtr: 0.1,
  sweepMinDisplacementAtr: 0.5,
  /** Fraction of the setup's lifespan that must remain for freshness to be a clean PASS. */
  freshnessPassFraction: 0.2,
  maxWeakChecks: 1,
} as const;

const T = QUALITY_THRESHOLDS;

function structureCheck(map: SetupMap, scenario: SetupScenario): CheckResult {
  const want = scenario.direction === 'LONG' ? 'BULLISH' : 'BEARISH';
  const against = scenario.direction === 'LONG' ? 'BEARISH' : 'BULLISH';
  const reversal = scenario.kind === 'LIQUIDITY_SWEEP';
  if (map.htfTrend === against) return reversal ? 'WEAK' : 'FAIL';
  if (map.htfTrend === want && map.ltfTrend === want) return 'PASS';
  if (map.ltfTrend === against) return reversal ? 'PASS' : 'FAIL';
  return 'WEAK';
}

function locationCheck(scenario: SetupScenario): CheckResult {
  const loc = scenario.locationAtEntry?.location;
  if (!loc) return 'WEAK';
  if (loc === 'EQUILIBRIUM') return 'WEAK';
  const good = scenario.direction === 'LONG' ? 'DISCOUNT' : 'PREMIUM';
  if (loc === good) return 'PASS';
  // Continuation entries at the wrong end of the range are risky but not disqualifying on their own
  return scenario.kind === 'BREAKOUT_RETEST' ? 'WEAK' : 'FAIL';
}

const triggerCheck = (scenario: SetupScenario): CheckResult =>
  scenario.state === 'TRIGGERED' ? 'PASS' : scenario.state === 'ARMED' ? 'WEAK' : 'FAIL';

function evidenceCheck(scenario: SetupScenario): CheckResult {
  if (scenario.kind !== 'LIQUIDITY_SWEEP') return 'PASS';
  const e = scenario.evidence;
  if (!e || !e.reclaimed) return 'FAIL';
  const deep = e.depthAtr >= T.sweepMinDepthAtr;
  const displaced = e.displacementAtr >= T.sweepMinDisplacementAtr;
  return deep && displaced ? 'PASS' : deep || displaced ? 'WEAK' : 'FAIL';
}

function flowCheck(scenario: SetupScenario, flow: FlowContext | undefined): CheckResult {
  if (!flow) return 'WEAK';
  const verdict = flowVerdict(flow, scenario.direction, scenario.kind === 'LIQUIDITY_SWEEP');
  return verdict === 'CONFIRMS' ? 'PASS' : verdict === 'CONTRADICTS' ? 'FAIL' : 'WEAK';
}

function rrCheck(effectiveRr: number): CheckResult {
  if (!Number.isFinite(effectiveRr)) return 'FAIL';
  return effectiveRr >= T.effectiveRrPass ? 'PASS' : effectiveRr >= T.effectiveRrWeak ? 'WEAK' : 'FAIL';
}

function freshnessCheck(scenario: SetupScenario, now: number): CheckResult {
  const life = scenario.lifecycle;
  if (!life) return 'WEAK';
  if (life.entryState === 'ENTRY_MISSED' || now >= life.expiresAt) return 'FAIL';
  const span = life.expiresAt - life.createdAt;
  return span > 0 && (life.expiresAt - now) / span < T.freshnessPassFraction ? 'WEAK' : 'PASS';
}

function reasonsFor(checks: SetupQuality['checks'], scenario: SetupScenario): NoTradeReason[] {
  const out: NoTradeReason[] = [];
  if (checks.structure === 'FAIL') out.push('CONFLICTING_TIMEFRAMES');
  if (checks.location === 'FAIL') out.push('ENTRY_LOCATION');
  if (checks.evidence === 'FAIL') out.push('INSUFFICIENT_CONFIRMATION');
  if (checks.flow === 'FAIL') out.push('FLOW_NOT_CONFIRMED');
  if (checks.rr === 'FAIL') out.push('COST_ADJUSTED_EDGE_TOO_LOW');
  if (checks.freshness === 'FAIL') out.push(scenario.lifecycle?.entryState === 'ENTRY_MISSED' ? 'ENTRY_MISSED' : 'STALE_SETUP');
  return out;
}

/**
 * ENTRY_ELIGIBLE needs: no FAIL anywhere, trigger confirmed, price inside the entry zone, and at most one
 * WEAK check. A confirmed trigger whose entry is still ahead is WATCH ("trigger confirmed, waiting for entry"),
 * which is the distinction between a trigger event and an executable trade.
 */
export function assessScenario(scenario: SetupScenario, map: SetupMap, costs: CostRates, now = map.generatedAt): SetupQuality {
  const effectiveRr = costAdjustedRr(
    { entry: scenario.direction === 'LONG' ? scenario.entryHigh : scenario.entryLow, stopLoss: scenario.stopLoss, takeProfit: scenario.target1, side: scenario.direction },
    costs,
  );
  const checks: SetupQuality['checks'] = {
    structure: structureCheck(map, scenario),
    location: locationCheck(scenario),
    trigger: triggerCheck(scenario),
    evidence: evidenceCheck(scenario),
    flow: flowCheck(scenario, map.flow),
    rr: rrCheck(effectiveRr),
    freshness: freshnessCheck(scenario, now),
  };
  const values = Object.values(checks);
  // A FORMING/ARMED trigger is expected to be incomplete; it makes the setup WATCH, not NO_TRADE
  const hardFails = (Object.entries(checks) as [keyof typeof checks, CheckResult][]).filter(([name, v]) => v === 'FAIL' && name !== 'trigger');
  const reasons = reasonsFor(checks, scenario);
  if (hardFails.length > 0) return { verdict: 'NO_TRADE', checks, effectiveRr, reasons };

  const weak = values.filter((v) => v === 'WEAK').length;
  const eligible = checks.trigger === 'PASS'
    && scenario.lifecycle?.entryState === 'IN_ENTRY_ZONE'
    && weak <= T.maxWeakChecks;
  if (eligible) return { verdict: 'ENTRY_ELIGIBLE', checks, effectiveRr, reasons: [] };
  const wait: NoTradeReason[] = checks.trigger === 'PASS' && weak > T.maxWeakChecks ? ['INSUFFICIENT_CONFIRMATION'] : [];
  return { verdict: 'WATCH', checks, effectiveRr, reasons: wait };
}
