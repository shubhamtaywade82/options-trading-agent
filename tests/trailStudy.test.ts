import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { Candle } from '../src/domain/types.js';
import type { OptionBar, ResearchDataset, ResearchSession } from '../src/research/dataset.js';
import { replayDataset, type CostModel, type ReplayConfig } from '../src/research/replay.js';
import { SeededRng } from '../src/research/rng.js';
import { STUDY_GRID } from '../src/research/trailGrid.js';
import { capture, dailyDeltas, holm, pairedBootstrap, realityCheck, walkForward, walkForwardFolds } from '../src/research/trailStats.js';
import { exitPath, freezeEntries, type StudyOptions } from '../src/research/trailStudy.js';
import { shiftDateKey } from '../src/time/ist.js';
import { bar, istEpoch } from './support/fixtures.js';

const COSTS: CostModel = { halfSpreadPct: 0.5, stopSlippagePct: 0.5 };
const SESSION_MINUTES = Array.from({ length: 75 }, (_, i) => 9 * 60 + 15 + i * 5);

const CONFIG: ReplayConfig = {
  barMinutes: 5,
  warmupSessions: 1,
  posture: 'scout',
  enabledStrategies: ['range'],
  strategy: {
    orbMinutes: 15,
    barMinutes: 5,
    supertrendPeriod: 10,
    supertrendMultiplier: 3,
    emaFast: 9,
    emaSlow: 21,
    entryStartMinute: 9 * 60 + 30,
    entryEndMinute: 14 * 60 + 30,
    sessionOpenMinute: 9 * 60 + 15,
  },
  contextGate: false,
  structureExit: true,
  strikeOffsetSteps: 0,
  entryLimitBufferPct: 0,
  expiryDayEntryCutoffMinute: 13 * 60,
  exits: {
    stopLossPct: 30,
    targetRr: 2,
    maxHoldMinutes: 60,
    flattenByMinute: 15 * 60 + 5,
    cooldownSeconds: 0,
    trailingJumpPct: 15,
    breakevenAtRr: 1,
    runnerMode: false,
  },
  capital: { inr: 1_000_000, maxRiskPerTradePct: 2, maxDailyLossPct: 50, maxTradesPerDay: 3, maxLotsPerOrder: 15 },
};

function premiumAt(spot: number, strike: number, call: boolean): number {
  const moneyness = call ? spot - strike : strike - spot;
  return Math.max(1, Math.max(0, moneyness) + 60 * Math.exp(-Math.abs(moneyness) / 300));
}

function optionBars(spot: readonly Candle[], strike: number, call: boolean): OptionBar[] {
  return spot.map((candle) => {
    const at = (value: number): number => Number(premiumAt(value, strike, call).toFixed(2));
    const [high, low] = call ? [at(candle.high), at(candle.low)] : [at(candle.low), at(candle.high)];
    return bar(candle.time, at(candle.open), high, low, at(candle.close));
  });
}

/** Seeded random-walk sessions with premiums for every strike: enough range breaks to trade most days. */
function syntheticDataset(days: number, seed: number): ResearchDataset {
  const rng = new SeededRng(seed);
  const sessions: ResearchSession[] = [];
  let price = 23_000;
  for (let d = 0; d < days; d += 1) {
    const date = shiftDateKey('2026-10-12', d);
    const spot = SESSION_MINUTES.map((minute) => {
      const open = price;
      price += (rng.next() - 0.5) * 30 + (d % 2 === 0 ? 1.5 : -1.5);
      const high = Math.max(open, price) + rng.next() * 8;
      const low = Math.min(open, price) - rng.next() * 8;
      return bar(istEpoch(date, `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`), open, high, low, price);
    });
    const centre = Math.round(price / 50) * 50;
    const calls: Record<string, OptionBar[]> = {};
    const puts: Record<string, OptionBar[]> = {};
    for (let strike = centre - 1500; strike <= centre + 1500; strike += 50) {
      calls[String(strike)] = optionBars(spot, strike, true);
      puts[String(strike)] = optionBars(spot, strike, false);
    }
    sessions.push({ date, lotSize: 65, tickSize: 0.05, strikeStep: 50, spot, calls, puts });
  }
  return { version: 1, underlying: 'NIFTY', optionSegment: 'NSE_FNO', barMinutes: 5, source: { kind: 'fixture' }, sessions };
}

const DATASET = syntheticDataset(24, 3);
const BASELINE = replayDataset(DATASET, CONFIG, COSTS);
const ENTRIES = freezeEntries(DATASET, BASELINE.trades, CONFIG.warmupSessions);
const KEEP: StudyOptions = { target: 'KEEP', structureExit: CONFIG.structureExit };

describe('fixed-entry study', () => {
  it('should have enough baseline trades to make the checks meaningful', () => {
    assert.ok(ENTRIES.length >= 15, `only ${ENTRIES.length} entries`);
    assert.ok(new Set(ENTRIES.map((entry) => entry.trade.exitReason)).size >= 3, 'baseline exits are all one kind');
    assert.ok(ENTRIES.some((entry) => entry.trade.finalStopPrice > entry.trade.initialStopPrice), 'no baseline trade trailed its stop');
  });

  it('should reproduce the replay exits exactly for the baseline policy', () => {
    const comparable = ENTRIES.filter((entry) => entry.trade.exitReason !== 'DAILY_LOSS');
    for (const entry of comparable) {
      const replayed = exitPath(entry, { kind: 'B1' }, KEEP, CONFIG, COSTS);
      assert.deepEqual(
        { exitTime: replayed.exitTime, exitPrice: replayed.exitPrice, exitReason: replayed.exitReason, net: replayed.netPnlInr },
        { exitTime: entry.trade.exitTime, exitPrice: entry.trade.exitPrice, exitReason: entry.trade.exitReason, net: entry.trade.netPnlInr },
        `${entry.trade.date} ${entry.trade.optionType} ${entry.trade.strike}`,
      );
    }
  });

  it('should give every policy the same opportunity for the same entry', () => {
    for (const entry of ENTRIES.slice(0, 5)) {
      const opportunities = new Set(STUDY_GRID.map((spec) => exitPath(entry, { kind: 'TRAIL', spec }, KEEP, CONFIG, COSTS).opportunityInr));
      assert.equal(opportunities.size, 1);
    }
  });

  it('should let a trail change some outcomes compared with no trail', () => {
    const none = ENTRIES.map((entry) => exitPath(entry, { kind: 'NONE' }, { ...KEEP, structureExit: false }, CONFIG, COSTS).netPnlInr);
    const giveback = ENTRIES.map(
      (entry) => exitPath(entry, { kind: 'TRAIL', spec: { kind: 'GIVEBACK', activationR: 0.5, giveback: 0.3 } }, { ...KEEP, structureExit: false }, CONFIG, COSTS).netPnlInr,
    );
    assert.notDeepEqual(none, giveback);
  });
});

describe('trail statistics', () => {
  it('should report undefined capture when no trade had an opportunity', () => {
    const trade = { date: 'd', entryTime: 0, exitTime: 1, exitPrice: 1, exitReason: 'STOP_LOSS' as const, netPnlInr: -10, riskInr: 10, r: -1, opportunityInr: 0, trailFallback: undefined };
    assert.equal(capture([trade]), undefined);
  });

  it('should find no difference when a policy is compared with itself', () => {
    const trades = ENTRIES.map((entry) => exitPath(entry, { kind: 'B1' }, KEEP, CONFIG, COSTS));
    const deltas = dailyDeltas(BASELINE.dates, trades, trades);
    const result = pairedBootstrap(deltas, { iterations: 500, seed: 19 });
    assert.equal(result.meanDelta, 0);
    assert.ok(result.ci95.low <= 0 && result.ci95.high >= 0);
  });

  it('should refuse to pair policies with different entries', () => {
    const trades = ENTRIES.map((entry) => exitPath(entry, { kind: 'B1' }, KEEP, CONFIG, COSTS));
    assert.throws(() => dailyDeltas(BASELINE.dates, trades, trades.slice(1)));
  });

  it('should match a hand-computed Holm adjustment', () => {
    assert.deepEqual(holm([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06]);
  });

  it('should not flag a winner among policies that are pure noise', () => {
    const rng = new SeededRng(19);
    const noise = Array.from({ length: 10 }, () => Array.from({ length: 120 }, () => rng.next() - 0.5));
    assert.ok(realityCheck(noise, { iterations: 500, seed: 19 }) > 0.05);
  });

  it('should flag a policy with a clear, consistent improvement', () => {
    const rng = new SeededRng(23);
    const noise = Array.from({ length: 5 }, () => Array.from({ length: 120 }, () => (rng.next() - 0.5) * 0.1));
    const better = Array.from({ length: 120 }, () => 0.2 + (rng.next() - 0.5) * 0.1);
    assert.ok(realityCheck([...noise, better], { iterations: 500, seed: 19 }) < 0.05);
  });

  it('should select on training months only and score the selection on the test month', () => {
    const months = ['2026-04', '2026-05', '2026-06'];
    const dates = months.map((month) => `${month}-10`);
    const trade = (date: string, net: number) => ({
      date, entryTime: Date.parse(date), exitTime: 0, exitPrice: 1, exitReason: 'STOP_LOSS' as const, netPnlInr: net, riskInr: 100, r: net / 100, opportunityInr: 200, trailFallback: undefined,
    });
    const baseline = dates.map((date) => trade(date, 0));
    // A wins in training (Apr–May) and loses in June; B is the reverse. The fold must pick A and report June's loss.
    const policyA = { id: 'A', trades: dates.map((date, i) => trade(date, i < 2 ? 100 : -50)) };
    const policyB = { id: 'B', trades: dates.map((date, i) => trade(date, i < 2 ? 10 : 150)) };
    const result = walkForward({ dates, baseline, policies: [policyA, policyB], trainMonths: 2 });
    assert.deepEqual(result.folds, [{ test: '2026-06', selected: 'A' }]);
    assert.deepEqual(result.selected.map((t) => t.netPnlInr), [-50]);
  });

  it('should build rolling folds whose test month never overlaps its training months', () => {
    const folds = walkForwardFolds(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'], 4);
    assert.deepEqual(folds.map((fold) => fold.test), ['2026-08', '2026-09']);
    for (const fold of folds) {
      assert.ok(!fold.train.includes(fold.test));
    }
  });
});
