import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FlowTracker, flowVerdict, type FlowContext } from '../src/market/FlowTracker.js';
import { latestVolumeZ } from '../src/market/RegimeEngine.js';
import { locationAtEntry, sweepEvidence } from '../src/decision/SetupEvidence.js';
import { assessScenario } from '../src/decision/SetupQuality.js';
import { ThesisController } from '../src/decision/ThesisController.js';
import { SetupLedger } from '../src/decision/SetupLedger.js';
import { SetupOutcomeLedger, summarizeSetupOutcomes } from '../src/learning/SetupOutcomeLedger.js';
import type { SetupMap, SetupScenario } from '../src/decision/SetupTypes.js';
import type { MarketState } from '../src/market/types.js';
import type { Candle } from '../src/types.js';

const T0 = Date.UTC(2026, 8, 30, 0, 0, 0);
const MIN = 60_000;
const COSTS = { feeRate: 0.0004, slippageRate: 0.0002 };
const deriv = (oi: number | null, taker: number | null) => ({
  asOf: 0, openInterest: oi, openInterestChangePct: null, globalLongShortRatio: null, topTraderAccountLongShortRatio: null,
  topTraderPositionLongShortRatio: null, takerBuySellRatio: taker, takerVolumeImbalance: null, orderBookImbalance: null, spreadBps: null, basisPct: null,
});

// ---- FlowTracker ------------------------------------------------------------------------------
function feed(tracker: FlowTracker, points: { min: number; price: number; oi: number | null; taker?: number }[]) {
  for (const p of points) tracker.record('X', T0 + p.min * MIN, p.price, deriv(p.oi, p.taker ?? 1), 0.0001);
}

test('OI up with price up is FRESH_LONGS; OI down with price up is SHORT_COVERING', () => {
  const up = new FlowTracker();
  feed(up, [{ min: 0, price: 100, oi: 1000 }, { min: 15, price: 100.5, oi: 1010 }]);
  assert.equal(up.context('X', T0 + 15 * MIN).quadrant, 'FRESH_LONGS');
  const cover = new FlowTracker();
  feed(cover, [{ min: 0, price: 100, oi: 1000 }, { min: 15, price: 100.5, oi: 990 }]);
  assert.equal(cover.context('X', T0 + 15 * MIN).quadrant, 'SHORT_COVERING');
});

test('price down with OI up is FRESH_SHORTS; price down with OI down is LONG_LIQUIDATION', () => {
  const a = new FlowTracker();
  feed(a, [{ min: 0, price: 100, oi: 1000 }, { min: 15, price: 99.5, oi: 1010 }]);
  assert.equal(a.context('X', T0 + 15 * MIN).quadrant, 'FRESH_SHORTS');
  const b = new FlowTracker();
  feed(b, [{ min: 0, price: 100, oi: 1000 }, { min: 15, price: 99.5, oi: 990 }]);
  assert.equal(b.context('X', T0 + 15 * MIN).quadrant, 'LONG_LIQUIDATION');
});

test('moves below the noise thresholds are UNCLEAR, not a direction', () => {
  const t = new FlowTracker();
  feed(t, [{ min: 0, price: 100, oi: 1000 }, { min: 15, price: 100.02, oi: 1000.5 }]);
  assert.equal(t.context('X', T0 + 15 * MIN).quadrant, 'UNCLEAR');
});

test('too little history, stale data or missing OI never yields a confident delta', () => {
  const short = new FlowTracker();
  feed(short, [{ min: 0, price: 100, oi: 1000 }, { min: 3, price: 101, oi: 1100 }]);
  assert.equal(short.context('X', T0 + 3 * MIN).quadrant, 'UNKNOWN');
  const stale = new FlowTracker();
  feed(stale, [{ min: 0, price: 100, oi: 1000 }, { min: 15, price: 101, oi: 1100 }]);
  assert.equal(stale.context('X', T0 + 60 * MIN).quadrant, 'UNKNOWN');
  const noOi = new FlowTracker();
  feed(noOi, [{ min: 0, price: 100, oi: null }, { min: 15, price: 101, oi: null }]);
  assert.equal(noOi.context('X', T0 + 15 * MIN).quadrant, 'UNKNOWN');
  assert.equal(new FlowTracker().context('NONE', T0).quadrant, 'UNKNOWN');
});

test('duplicate or out-of-order samples are ignored', () => {
  const t = new FlowTracker();
  feed(t, [{ min: 15, price: 100, oi: 1000 }, { min: 10, price: 200, oi: 5 }, { min: 15, price: 300, oi: 5 }]);
  assert.equal(t.context('X', T0 + 15 * MIN).samples, 1);
});

test('taker z-score flags an aggression spike against the symbol\'s own history', () => {
  const t = new FlowTracker();
  const points = Array.from({ length: 20 }, (_, i) => ({ min: i, price: 100 + i * 0.001, oi: 1000 + i, taker: 1 + (i % 2 ? 0.02 : -0.02) }));
  points.push({ min: 20, price: 100.05, oi: 1021, taker: 1.4 });
  feed(t, points);
  const z = t.context('X', T0 + 20 * MIN).takerZ;
  assert.ok(z !== null && z > 3, `z=${z}`);
});

const flow = (over: Partial<FlowContext>): FlowContext => ({
  asOf: 0, samples: 20, windowMs: 900_000, oiDeltaPct: 0.5, priceDeltaPct: 0.3, takerRatio: 1, takerZ: 0, fundingDelta: 0, quadrant: 'UNCLEAR', ...over,
});

test('trend setups need fresh positioning with them; reversals only need flow not to fight them', () => {
  assert.equal(flowVerdict(flow({ quadrant: 'FRESH_LONGS', takerZ: 0.5 }), 'LONG', false), 'CONFIRMS');
  assert.equal(flowVerdict(flow({ quadrant: 'FRESH_SHORTS' }), 'LONG', false), 'CONTRADICTS');
  assert.equal(flowVerdict(flow({ quadrant: 'SHORT_COVERING' }), 'LONG', false), 'NEUTRAL');
  assert.equal(flowVerdict(flow({ quadrant: 'FRESH_SHORTS', takerZ: 0 }), 'LONG', true), 'NEUTRAL');
  assert.equal(flowVerdict(flow({ takerZ: -2 }), 'LONG', true), 'CONTRADICTS');
  assert.equal(flowVerdict(flow({ quadrant: 'UNKNOWN', takerZ: null }), 'SHORT', false), 'UNKNOWN');
});

// ---- volume z ---------------------------------------------------------------------------------
const bars = (volumes: number[]): Candle[] => volumes.map((volume, i) => ({ openTime: i, open: 1, high: 1, low: 1, close: 1, volume }));

test('volume z is the latest bar against the prior 20, and null for short or flat history', () => {
  const z = latestVolumeZ(bars([...Array.from({ length: 20 }, (_, i) => 100 + (i % 2 ? 5 : -5)), 130]));
  assert.ok(z !== null && z > 4);
  assert.equal(latestVolumeZ(bars([1, 2, 3])), null);
  assert.equal(latestVolumeZ(bars(Array(25).fill(100))), null);
});

// ---- evidence + location ----------------------------------------------------------------------
const scenario = (over: Partial<SetupScenario> = {}): SetupScenario => ({
  id: 'sweep-XUSDT-LONG-1', kind: 'LIQUIDITY_SWEEP', direction: 'LONG', state: 'TRIGGERED', timeframe: '15m',
  entryLow: 99.9, entryHigh: 100.1, stopLoss: 98.9, target1: 103.5, trigger: 't', invalidation: 'i', flowHypothesis: 'f',
  expectedMove: { minMinutes: 30, maxMinutes: 60, thesisExpiryMinutes: 120, distanceAtr: 3 }, sourceTime: T0, rewardRisk: 3.4,
  lifecycle: { setupId: 'XUSDT|sweep-XUSDT-LONG-1', version: 1, createdAt: T0, expiresAt: T0 + 120 * MIN, highestState: 'TRIGGERED', entryState: 'IN_ENTRY_ZONE', missedCycles: 0 },
  locationAtEntry: { location: 'DISCOUNT', pct: 30 },
  evidence: { sweepLevel: 100, sweepExtreme: 99.4, reclaimClose: 100.3, depthAtr: 0.6, displacementAtr: 1.1, volumeZLatest: 1.5, structureShift: 'CHOCH', reclaimed: true },
  ...over,
});

const map = (over: Partial<SetupMap> = {}, scenarios: SetupScenario[] = [scenario()]): SetupMap => ({
  symbol: 'XUSDT', generatedAt: T0 + 10 * MIN, mark: 100, state: 'TRIGGERED', bias: 'BULLISH', regime: 'TREND_UP', volatility: 'MEDIUM',
  positionPct: 40, location: 'DISCOUNT', htfTrend: 'BULLISH', ltfTrend: 'BULLISH', lastBreak: null, nearestUpperLiquidity: null,
  nearestLowerLiquidity: null, crowding: null, openInterestExpansion: null, takerAggressionRatio: null, scenarios, noTradeReasons: [],
  flow: flow({ quadrant: 'FRESH_LONGS', takerZ: 1 }), ...over,
});

test('location at entry is measured against the dealing range at the planned entry, not the current price', () => {
  const state = { pricing: { high: 110, low: 90, equilibrium: 100, positionPct: 90, premium: true, discount: false } } as MarketState;
  assert.equal(locationAtEntry(state, { entryLow: 91, entryHigh: 93 })?.location, 'DISCOUNT');
  assert.equal(locationAtEntry(state, { entryLow: 107, entryHigh: 109 })?.location, 'PREMIUM');
  assert.equal(locationAtEntry(state, { entryLow: 99.5, entryHigh: 100.5 })?.location, 'EQUILIBRIUM');
  assert.equal(locationAtEntry({ pricing: { high: 5, low: 5 } } as MarketState, { entryLow: 5, entryHigh: 5 }), null);
});

test('sweep evidence reports depth, reclaim, displacement and shift from the same state', () => {
  const state = {
    timeframes: { '15m': { volumeZ: 2.2 } },
    liquidity: { ltf: { recentSweeps: [{ poolType: 'EQUAL_LOW', direction: 'SELL_SIDE', level: 100, sweepPrice: 99.4, close: 100.3, index: 1, time: T0, confirmed: true }] } },
    ltfStructure: { breaks: [{ type: 'CHOCH', direction: 'BULLISH', level: 100.5, index: 2, time: T0 + 15 * MIN, distanceAtr: 0.9 }], lastBreak: null },
  } as unknown as MarketState;
  const e = sweepEvidence(state, scenario({ evidence: undefined }), 1);
  assert.ok(Math.abs((e?.depthAtr ?? 0) - 0.6) < 1e-9);
  assert.equal(e?.displacementAtr, 0.9);
  assert.equal(e?.structureShift, 'CHOCH');
  assert.equal(e?.volumeZLatest, 2.2);
  assert.equal(e?.reclaimed, true);
  assert.equal(sweepEvidence(state, scenario({ kind: 'PULLBACK_RETEST' }), 1), null);
});

// ---- quality gate -----------------------------------------------------------------------------
test('a clean, in-zone, triggered, flow-confirmed setup is ENTRY_ELIGIBLE', () => {
  const q = assessScenario(scenario(), map(), COSTS);
  assert.equal(q.verdict, 'ENTRY_ELIGIBLE', JSON.stringify(q));
  assert.deepEqual(q.reasons, []);
});

test('a confirmed trigger whose entry is still ahead is WATCH, not eligible', () => {
  const s = scenario({ lifecycle: { ...scenario().lifecycle!, entryState: 'WAITING_ENTRY' } });
  assert.equal(assessScenario(s, map({}, [s]), COSTS).verdict, 'WATCH');
});

test('low cost-adjusted RR is NO_TRADE with a machine reason even when everything else is perfect', () => {
  const s = scenario({ target1: 100.15, rewardRisk: 0.15 });
  const q = assessScenario(s, map({}, [s]), COSTS);
  assert.equal(q.verdict, 'NO_TRADE');
  assert.ok(q.reasons.includes('COST_ADJUSTED_EDGE_TOO_LOW'));
});

test('contradicting flow is NO_TRADE; unknown flow only weakens', () => {
  const s = scenario();
  assert.ok(assessScenario(s, map({ flow: flow({ takerZ: -2 }) }), COSTS).reasons.includes('FLOW_NOT_CONFIRMED'));
  assert.equal(assessScenario(s, map({ flow: undefined }), COSTS).verdict, 'ENTRY_ELIGIBLE'); // one WEAK is tolerated
});

test('two weak checks are not enough confirmation to trade', () => {
  const s = scenario({ locationAtEntry: { location: 'EQUILIBRIUM', pct: 50 } });
  const q = assessScenario(s, map({ flow: undefined }, [s]), COSTS);
  assert.equal(q.verdict, 'WATCH');
  assert.deepEqual(q.reasons, ['INSUFFICIENT_CONFIRMATION']);
});

test('a sweep without evidence, or that failed to reclaim, fails the evidence check', () => {
  assert.ok(assessScenario(scenario({ evidence: undefined }), map(), COSTS).reasons.includes('INSUFFICIENT_CONFIRMATION'));
  const noReclaim = scenario({ evidence: { ...scenario().evidence!, reclaimed: false } });
  assert.equal(assessScenario(noReclaim, map({}, [noReclaim]), COSTS).verdict, 'NO_TRADE');
});

test('a trend setup against the HTF fails structure; a reversal only weakens', () => {
  const trend = scenario({ kind: 'PULLBACK_RETEST', evidence: undefined });
  assert.ok(assessScenario(trend, map({ htfTrend: 'BEARISH' }, [trend]), COSTS).reasons.includes('CONFLICTING_TIMEFRAMES'));
  assert.doesNotMatch(assessScenario(scenario(), map({ htfTrend: 'BEARISH' }), COSTS).reasons.join(), /CONFLICTING/);
});

test('a long entry taken in premium fails location for a pullback but not a breakout', () => {
  const premium = { location: 'PREMIUM' as const, pct: 80 };
  const pull = scenario({ kind: 'PULLBACK_RETEST', evidence: undefined, locationAtEntry: premium });
  assert.ok(assessScenario(pull, map({}, [pull]), COSTS).reasons.includes('ENTRY_LOCATION'));
  const brk = scenario({ kind: 'BREAKOUT_RETEST', evidence: undefined, locationAtEntry: premium });
  assert.doesNotMatch(assessScenario(brk, map({}, [brk]), COSTS).reasons.join(), /ENTRY_LOCATION/);
});

test('an expired setup is STALE_SETUP', () => {
  const s = scenario();
  const q = assessScenario(s, map({ generatedAt: T0 + 121 * MIN }, [s]), COSTS);
  assert.equal(q.verdict, 'NO_TRADE');
  assert.ok(q.reasons.includes('STALE_SETUP'));
});

// ---- thesis controller ------------------------------------------------------------------------
const thesisScenario = (direction: 'LONG' | 'SHORT', state: SetupScenario['state'], stop: number, expiresAt = T0 + 300 * MIN): SetupScenario =>
  scenario({ id: `s-${direction}-${state}`, kind: 'PULLBACK_RETEST', direction, state, stopLoss: stop, lifecycle: { ...scenario().lifecycle!, expiresAt, highestState: state } });

test('first thesis is adopted and its scenarios are authoritative', () => {
  const c = new ThesisController();
  const out = c.apply(map({}, [thesisScenario('LONG', 'ARMED', 98)]));
  assert.equal(out.scenarios[0].thesisRole, 'AUTHORITATIVE');
  assert.equal(out.thesisTransition, undefined);
});

test('an opposing hypothesis is withheld while the thesis stands', () => {
  const c = new ThesisController();
  c.apply(map({ generatedAt: T0 }, [thesisScenario('LONG', 'TRIGGERED', 98)]));
  const out = c.apply(map({ generatedAt: T0 + 15 * MIN, mark: 100.5 }, [thesisScenario('SHORT', 'TRIGGERED', 102)]));
  assert.equal(out.scenarios.length, 0);
  assert.equal(out.state, 'NO_TRADE');
  assert.deepEqual(out.withheldIds, ['s-SHORT-TRIGGERED']);
  assert.equal(out.thesisTransition, undefined);
});

test('a flip is allowed once the old invalidation is breached, and is reported', () => {
  const c = new ThesisController();
  c.apply(map({ generatedAt: T0 }, [thesisScenario('LONG', 'TRIGGERED', 98)]));
  const out = c.apply(map({ generatedAt: T0 + 15 * MIN, mark: 97.5 }, [thesisScenario('SHORT', 'ARMED', 100)]));
  assert.equal(out.thesisTransition?.reason, 'INVALIDATION_BREACHED');
  assert.equal(out.scenarios[0].thesisRole, 'AUTHORITATIVE');
});

test('a flip is allowed after expiry, or on an opposing trigger while the old thesis never triggered', () => {
  const expired = new ThesisController();
  expired.apply(map({ generatedAt: T0 }, [thesisScenario('LONG', 'TRIGGERED', 98, T0 + 30 * MIN)]));
  assert.equal(expired.apply(map({ generatedAt: T0 + 31 * MIN }, [thesisScenario('SHORT', 'FORMING', 102)])).thesisTransition?.reason, 'THESIS_EXPIRED');

  const opposing = new ThesisController();
  opposing.apply(map({ generatedAt: T0 }, [thesisScenario('LONG', 'ARMED', 98)]));
  assert.equal(opposing.apply(map({ generatedAt: T0 + 15 * MIN }, [thesisScenario('SHORT', 'TRIGGERED', 102)])).thesisTransition?.reason, 'OPPOSING_TRIGGER');
});

test('a thesis with no live scenarios is released only after the grace window', () => {
  const c = new ThesisController();
  c.apply(map({ generatedAt: T0 }, [thesisScenario('LONG', 'TRIGGERED', 98)]));
  for (let i = 1; i <= 3; i++) c.apply(map({ generatedAt: T0 + i * MIN }, []));
  assert.deepEqual(c.apply(map({ generatedAt: T0 + 4 * MIN }, [thesisScenario('SHORT', 'FORMING', 102)])).scenarios.length, 0);
  c.apply(map({ generatedAt: T0 + 5 * MIN }, []));
  assert.equal(c.apply(map({ generatedAt: T0 + 6 * MIN }, [thesisScenario('SHORT', 'FORMING', 102)])).scenarios[0]?.thesisRole, 'AUTHORITATIVE');
});

// ---- outcome ledger ---------------------------------------------------------------------------
function harness() {
  const ledger = new SetupLedger();
  const outcomes = new SetupOutcomeLedger(null, COSTS);
  const raw = (at: number, mark: number, scenarios: SetupScenario[]): SetupMap => ({ ...map({ generatedAt: at, mark }, scenarios), flow: flow({ quadrant: 'FRESH_LONGS', takerZ: 1 }) });
  const step = (at: number, mark: number, scenarios: SetupScenario[]) => {
    const { map: m, transitions } = ledger.apply(raw(at, mark, scenarios), 1);
    outcomes.observe({ ...m, scenarios: m.scenarios.map((s) => ({ ...s, quality: assessScenario(s, m, COSTS) })) }, transitions, at);
  };
  return { outcomes, step };
}
const pull = (over: Partial<SetupScenario> = {}) => scenario({ kind: 'PULLBACK_RETEST', evidence: undefined, id: 'pb', entryLow: 99.5, entryHigh: 100, stopLoss: 99, target1: 102, rewardRisk: 2, sourceTime: T0, lifecycle: undefined, ...over });

test('a setup that touches entry then reaches TP1 records a positive, cost-adjusted hypothetical R', () => {
  const { outcomes, step } = harness();
  step(T0, 101, [pull()]);
  step(T0 + 15 * MIN, 99.8, [pull()]); // inside entry zone
  step(T0 + 30 * MIN, 102.1, [pull()]); // target
  const r = outcomes.all()[0];
  assert.equal(r.outcome, 'TP1');
  assert.ok(r.entryTouchedAt !== null);
  assert.ok(r.netR! > 1.8 && r.netR! < 2, `netR ${r.netR}`);
  assert.ok((r.mfeR ?? 0) >= 2);
  assert.equal(r.features.quadrant, 'FRESH_LONGS');
});

test('a setup that touches entry then breaches the stop records a loss of about -1R minus costs', () => {
  const { outcomes, step } = harness();
  step(T0, 101, [pull()]);
  step(T0 + 15 * MIN, 99.8, [pull()]);
  step(T0 + 30 * MIN, 98.9, [pull()]);
  const r = outcomes.all()[0];
  assert.equal(r.outcome, 'SL');
  assert.ok(r.netR! < -1 && r.netR! > -1.5);
});

test('a setup that never reaches its entry is NOT_FILLED and carries no R', () => {
  const { outcomes, step } = harness();
  step(T0, 101.5, [pull()]);
  step(T0 + 15 * MIN, 101.4, [pull()]);
  step(T0 + 130 * MIN, 101.4, [pull()]); // expired
  const r = outcomes.all()[0];
  assert.equal(r.outcome, 'NOT_FILLED');
  assert.equal(r.netR, null);
});

test('an entry crossed between two samples still counts as touched', () => {
  const { outcomes, step } = harness();
  step(T0, 101, [pull()]);
  step(T0 + 15 * MIN, 98.5, [pull()]); // gapped through the zone and the stop
  const r = outcomes.all()[0];
  assert.ok(r.entryTouchedAt !== null);
  assert.equal(r.outcome, 'SL');
});

test('summaries group filled setups and report expectancy with a lower bound', () => {
  const { outcomes, step } = harness();
  step(T0, 101, [pull()]);
  step(T0 + 15 * MIN, 99.8, [pull()]);
  step(T0 + 30 * MIN, 102.1, [pull()]);
  const [group] = summarizeSetupOutcomes(outcomes.all(), (r) => r.kind);
  assert.equal(group.key, 'PULLBACK_RETEST');
  assert.equal(group.filled, 1);
  assert.equal(group.tp1Rate, 1);
  assert.equal(group.lcbNetR, null); // one sample has no variance: no lower bound is claimed
});

test('the setup card shows gate verdict, entry location, sweep evidence, flow deltas and a thesis flip', async () => {
  const { setupMapCard } = await import('../src/ops/setupCards.js');
  const s = { ...scenario(), quality: assessScenario(scenario(), map(), COSTS) };
  const html = setupMapCard(map({ thesisTransition: { from: 'SHORT', to: 'LONG', reason: 'INVALIDATION_BREACHED', at: T0 } }, [s]));
  assert.match(html, /Gate:<\/b> ENTRY_ELIGIBLE/);
  assert.match(html, /Location @ entry:<\/b> DISCOUNT 30%/);
  assert.match(html, /Sweep:<\/b> level 100/);
  assert.match(html, /Flow Δ15m:<\/b> FRESH LONGS/);
  assert.match(html, /SHORT superseded by LONG \(invalidation breached\)/);
  assert.match(html, /Location now/);
});
