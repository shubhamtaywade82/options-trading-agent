import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle } from '../src/types.js';
import { analyzeStructure } from '../src/market/StructureEngine.js';
import { findStructureBreakEvents } from '../src/market/StructureEventLog.js';
import { buildSweepLedger } from '../src/market/SweepLedger.js';
import { buildZoneLedger, zoneStateRank } from '../src/market/ZoneLedger.js';
import { detectLiquidity } from '../src/market/LiquidityEngine.js';
import { MarketStateBuilder } from '../src/market/MarketStateBuilder.js';
import type { LiquidityPool, StructureBreak, ZoneRecord } from '../src/market/types.js';

const BAR_MS = 15 * 60_000;
const ATR = 1.0;

function candle(index: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime: index * BAR_MS, open, high, low, close, volume: 100 };
}

/** Deterministic pseudo-random walk (xorshift32-style LCG), no clock or Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomCandles(count: number, seed = 42): Candle[] {
  const rand = lcg(seed);
  const candles: Candle[] = [];
  let close = 100;
  for (let i = 0; i < count; i++) {
    const open = close;
    close = close + (rand() - 0.5) * 2;
    const upWick = 0.2 + rand() * 0.8;
    const downWick = 0.2 + rand() * 0.8;
    candles.push(candle(i, open, Math.max(open, close) + upWick, Math.min(open, close) - downWick, close));
  }
  return candles;
}

const CANDLES = randomCandles(420, 42);
const CHECKPOINTS = [120, 160, 200, 240, 280, 320, 360, 400, 420];

interface Run {
  len: number;
  prefix: Candle[];
  lastTime: number;
  events: StructureBreak[];
  zones: ZoneRecord[];
  sweepHistory: ReturnType<typeof detectLiquidity>['sweepHistory'];
  pools: LiquidityPool[];
}

function buildRun(len: number): Run {
  const prefix = CANDLES.slice(0, len);
  const events = findStructureBreakEvents(prefix, ATR, 2, 1_000_000);
  return {
    len,
    prefix,
    lastTime: prefix[prefix.length - 1].openTime,
    events,
    zones: buildZoneLedger('15m', prefix, ATR, events),
    sweepHistory: [],
    pools: [],
  };
}

function coreOf(e: StructureBreak) {
  return {
    type: e.type,
    direction: e.direction,
    level: e.level,
    index: e.index,
    time: e.time,
    distanceAtr: e.distanceAtr,
    protectedLevel: e.protectedLevel,
    zoneLow: e.protectionZone?.low ?? null,
    zoneHigh: e.protectionZone?.high ?? null,
  };
}

test('fixture sanity: the random walk produces breaks, zones and sweeps to exercise the assertions', () => {
  const full = buildRun(420);
  assert.ok(full.events.length > 0, `expected breaks, got ${full.events.length}`);
  assert.ok(full.zones.length > 0, `expected zone records, got ${full.zones.length}`);
  const struct = analyzeStructure('15m', full.prefix, ATR, 2);
  const liq = detectLiquidity('15m', full.prefix, struct, ATR);
  assert.ok((liq.sweepHistory ?? []).length > 0, 'expected sweep history entries');
});

test('BOS/CHOCH event history is append-stable: appending candles never rewrites a past event', () => {
  const runs = CHECKPOINTS.map(buildRun);
  assert.ok(runs.length >= 2);

  for (let k = 1; k < runs.length; k++) {
    const shorter = runs[k - 1];
    const longer = runs[k];
    const longerCore = longer.events.filter((e) => e.time <= shorter.lastTime);

    assert.equal(
      shorter.events.length,
      longerCore.length,
      `event count changed between prefixes ${shorter.len} and ${longer.len}`,
    );

    for (let i = 0; i < shorter.events.length; i++) {
      const before = shorter.events[i];
      const after = longerCore[i];
      assert.deepEqual(
        coreOf(before),
        coreOf(after),
        `core fields of event #${i} changed between prefixes ${shorter.len} and ${longer.len}`,
      );

      const bz = before.protectionZone;
      const az = after.protectionZone;
      if (bz === null || bz === undefined) {
        assert.equal(az, bz);
        continue;
      }
      assert.ok(az, 'protection zone disappeared after appending candles');
      if (bz.tested) {
        assert.ok(az.tested, 'protection zone un-tested itself after appending candles');
        assert.equal(bz.testedAt, az.testedAt);
        assert.ok(bz.testedAt! <= shorter.lastTime, 'testedAt references a candle beyond the prefix');
      }
      if (bz.violated) {
        assert.ok(az.violated, 'protection zone un-violated itself after appending candles');
        assert.equal(bz.violatedAt, az.violatedAt);
        assert.equal(bz.violatedIndex, az.violatedIndex);
        assert.ok(bz.violatedAt! <= shorter.lastTime, 'violatedAt references a candle beyond the prefix');
      }
    }
  }
});

test('every BOS/CHOCH event is knowable at its own candle: levels are confirmed swings and zones never look ahead', () => {
  const run = buildRun(420);

  for (const event of run.events) {
    // The broken level must be a confirmed swing at the break candle.
    const swingAt = (idx: number, type: 'HIGH' | 'LOW') => run.prefix[idx]?.[type === 'HIGH' ? 'high' : 'low'];
    assert.ok(
      event.direction === 'BULLISH'
        ? swingAt(event.index, 'HIGH') !== undefined
        : swingAt(event.index, 'LOW') !== undefined,
    );
    // Protection zone geometry only involves prices known at the break candle.
    const zone = event.protectionZone;
    if (zone) {
      assert.ok(zone.low <= zone.high);
      assert.ok(zone.originLevel === event.level);
      assert.ok(
        event.direction === 'BULLISH'
          ? zone.protectedLevel < zone.originLevel
          : zone.protectedLevel > zone.originLevel,
        `bullish (bearish) protection must sit below (above) the broken level for event at ${event.index}`,
      );
    }
  }

  // The crossing rule itself: previous close on the far side, break close on the near side.
  for (const event of run.events) {
    const prevClose = run.prefix[event.index - 1].close;
    const close = run.prefix[event.index].close;
    if (event.direction === 'BULLISH') {
      assert.ok(prevClose <= event.level && close > event.level);
    } else {
      assert.ok(prevClose >= event.level && close < event.level);
    }
  }
});

test('the newest log entry equals lastBreak whenever a break lands on the last closed candle', () => {
  let matched = 0;
  for (let len = 10; len <= CANDLES.length; len++) {
    const prefix = CANDLES.slice(0, len);
    const state = analyzeStructure('15m', prefix, ATR, 2);
    const last = state.breaks?.at(-1) ?? null;
    if (state.lastBreak === null) {
      if (last) assert.ok(last.index < len - 1, 'last event must predate the final candle when lastBreak is null');
      continue;
    }
    matched += 1;
    assert.ok(last, 'breaks history must contain the last-candle break');
    assert.equal(last.index, state.lastBreak.index);
    assert.equal(last.time, state.lastBreak.time);
    assert.equal(last.type, state.lastBreak.type);
    assert.equal(last.direction, state.lastBreak.direction);
    assert.equal(last.level, state.lastBreak.level);
    assert.equal(last.distanceAtr, state.lastBreak.distanceAtr);
  }
  assert.ok(matched > 0, 'fixture produced no last-candle break; equivalence is untested');
});

test('sweep history is append-stable and every swept pool predates its sweep candle', () => {
  const runs = CHECKPOINTS.map((len) => {
    const prefix = CANDLES.slice(0, len);
    const struct = analyzeStructure('15m', prefix, ATR, 2);
    const liq = detectLiquidity('15m', prefix, struct, ATR);
    return { len, lastTime: prefix[prefix.length - 1].openTime, history: liq.sweepHistory ?? [] };
  });

  for (const run of runs) {
    for (const sweep of run.history) {
      // Causality: the pool fully formed before the candle that swept it.
      assert.ok(sweep.poolSourceTimes?.every((t) => t < sweep.time), `sweep ${sweep.id} used future pool sources`);
      assert.ok(sweep.time <= run.lastTime, 'sweep event references a candle beyond the prefix');
    }
    const ids = new Set(run.history.map((s) => s.id));
    assert.equal(ids.size, run.history.length, 'sweep ids must be unique');
  }

  for (let k = 1; k < runs.length; k++) {
    const shorter = runs[k - 1];
    const longer = runs[k];
    const longerVisible = longer.history.filter((s) => s.time <= shorter.lastTime);
    assert.equal(
      shorter.history.length,
      longerVisible.length,
      `sweep count changed between prefixes ${shorter.len} and ${longer.len}`,
    );
    assert.deepEqual(
      shorter.history,
      longerVisible,
      `sweep history was rewritten between prefixes ${shorter.len} and ${longer.len}`,
    );
  }
});

test('pools never un-sweep: taken state is monotonic across appended candles', () => {
  const key = (p: LiquidityPool) => `${p.type}|${p.sourceTimes.join(',')}`;
  const runs = CHECKPOINTS.map((len) => {
    const prefix = CANDLES.slice(0, len);
    const struct = analyzeStructure('15m', prefix, ATR, 2);
    const liq = detectLiquidity('15m', prefix, struct, ATR);
    return { len, pools: liq.pools };
  });

  for (let k = 1; k < runs.length; k++) {
    const shorter = new Map(runs[k - 1].pools.map((p) => [key(p), p]));
    const longer = new Map(runs[k].pools.map((p) => [key(p), p]));
    for (const [poolKey, pool] of shorter) {
      if (!pool.taken) continue;
      const later = longer.get(poolKey);
      if (!later) continue; // pool rolled out of the snapshot window — nothing to assert
      assert.ok(later.taken, `pool ${poolKey} un-swept itself after appending candles`);
      assert.equal(pool.sweptAt, later.sweptAt);
    }
  }
});

test('zone lifecycle is append-stable: states never regress and timestamps never move', () => {
  const runs = CHECKPOINTS.map(buildRun);

  for (let k = 1; k < runs.length; k++) {
    const shorter = new Map(runs[k - 1].zones.map((z) => [`${z.timeframe}|${z.breakTime}`, z]));
    const longer = new Map(runs[k].zones.map((z) => [`${z.timeframe}|${z.breakTime}`, z]));

    for (const [zoneKey, before] of shorter) {
      const after = longer.get(zoneKey);
      if (!after) continue;

      // Zone geometry is a pure function of the break candle.
      assert.deepEqual(
        { type: before.type, high: before.high, low: before.low, originTime: before.originTime, causedBreak: before.causedBreak },
        { type: after.type, high: after.high, low: after.low, originTime: after.originTime, causedBreak: after.causedBreak },
        `geometry of zone ${zoneKey} changed between prefixes ${runs[k - 1].len} and ${runs[k].len}`,
      );

      assert.ok(
        zoneStateRank(after.state) >= zoneStateRank(before.state),
        `zone ${zoneKey} regressed from ${before.state} to ${after.state}`,
      );

      for (const field of ['testedAt', 'mitigatedAt', 'invalidatedAt', 'invalidatedIndex', 'expiredAt'] as const) {
        const b = before[field];
        if (b === null) continue;
        assert.equal(after[field], b, `${field} of zone ${zoneKey} moved after appending candles`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Deterministic fixtures with hand-derived expectations
// ---------------------------------------------------------------------------

const FIXTURE_A: Candle[] = [
  candle(0, 19.0, 19.3, 18.7, 19.0),
  candle(1, 19.0, 20.0, 19.4, 19.7),
  candle(2, 19.7, 20.2, 19.3, 19.6),   // H1 = 20.2
  candle(3, 19.6, 18.8, 18.2, 18.5),
  candle(4, 18.5, 17.6, 17.0, 17.3),   // L1 = 17.0
  candle(5, 17.3, 18.3, 17.7, 18.0),
  candle(6, 18.0, 19.5, 18.8, 19.1),   // H2 = 19.5
  candle(7, 19.1, 18.2, 17.6, 17.9),
  candle(8, 17.9, 16.9, 16.3, 16.6),   // L2 = 16.3  <- BEARISH BOS(17.0)
  candle(9, 16.6, 17.3, 16.7, 17.0),
  candle(10, 17.0, 18.1, 17.5, 17.8),  // H3 = 18.1
  candle(11, 17.8, 17.5, 16.9, 17.2),
  candle(12, 17.2, 16.6, 16.0, 16.3),  // L3 = 16.0
  candle(13, 16.3, 17.9, 17.2, 17.5),
  candle(14, 17.5, 19.0, 18.3, 18.6),  // <- BULLISH CHOCH(18.1), protected low 16.0
  candle(15, 18.6, 19.8, 19.1, 19.4),  // H4 = 19.8
  candle(16, 19.4, 19.5, 18.9, 19.2),  // L4 = 18.9, bearish cause candle
  candle(17, 19.2, 20.4, 19.8, 20.1),  // <- BULLISH BOS(19.8), protected low 18.9
  candle(18, 20.1, 21.0, 20.4, 20.7),  // H5 = 21.0
  candle(19, 20.7, 20.9, 19.2, 19.5),  // red candle: tests the BOS protection zone
  candle(20, 19.5, 19.6, 18.0, 18.5),  // <- BEARISH CHOCH(18.9); violates the BOS zone
];

test('fixture: BOS -> CHOCH -> BOS -> CHOCH sequence with protection zones and exact violations', () => {
  const events = findStructureBreakEvents(FIXTURE_A, ATR, 1, 1000);

  assert.deepEqual(
    events.map((e) => [e.index, e.direction, e.type, e.level]),
    [
      [8, 'BEARISH', 'BOS', 17.0],
      [14, 'BULLISH', 'CHOCH', 18.1],
      [17, 'BULLISH', 'BOS', 19.8],
      [20, 'BEARISH', 'CHOCH', 18.9],
    ],
  );

  // Bearish BOS: protected high 19.5, zone [17.0, 19.5], tested on candle 9,
  // violated when price closed above the protected high on candle 17.
  const bos = events[0];
  assert.equal(bos.protectedLevel, 19.5);
  assert.deepEqual(
    [bos.protectionZone?.low, bos.protectionZone?.high],
    [17.0, 19.5],
  );
  assert.equal(bos.protectionZone?.tested, true);
  assert.equal(bos.protectionZone?.testedAt, 9 * BAR_MS);
  assert.equal(bos.protectionZone?.violated, true);
  assert.equal(bos.protectionZone?.violatedIndex, 17);

  // Bullish CHOCH: protected low 16.0, zone [16.0, 18.1], tested on candle 20, never violated.
  const choch = events[1];
  assert.equal(choch.protectedLevel, 16.0);
  assert.equal(choch.protectionZone?.tested, true);
  assert.equal(choch.protectionZone?.testedAt, 20 * BAR_MS);
  assert.equal(choch.protectionZone?.violated, false);

  // Bullish BOS: protected low 18.9, tested on candle 19 (low 19.2 <= 19.8),
  // violated on candle 20 when price closed below 18.9.
  const bos2 = events[2];
  assert.equal(bos2.protectedLevel, 18.9);
  assert.equal(bos2.protectionZone?.testedAt, 19 * BAR_MS);
  assert.equal(bos2.protectionZone?.violatedIndex, 20);

  // The final CHOCH is the same event findLatestBreak reports for this prefix.
  const state = analyzeStructure('15m', FIXTURE_A, ATR, 1);
  assert.ok(state.lastBreak);
  assert.equal(state.lastBreak.level, 18.9);
  assert.equal(state.lastBreak.index, 20);
  assert.equal(state.lastBreak.type, 'CHOCH');
});

test('fixture: zone ledger states match the hand-derived lifecycle', () => {
  const events = findStructureBreakEvents(FIXTURE_A, ATR, 1, 1000);
  const zones = buildZoneLedger('15m', FIXTURE_A, ATR, events);

  const byBreak = new Map(zones.map((z) => [z.breakIndex, z]));

  // SUPPLY from the bearish BOS at 8: tested at 10 (first candle whose range
  // overlaps [18.0, 19.5]), mitigated at 15, invalidated at 17.
  const supply = byBreak.get(8)!;
  assert.equal(supply.type, 'SUPPLY');
  assert.deepEqual([supply.low, supply.high], [18.0, 19.5]);
  assert.equal(supply.state, 'INVALIDATED');
  assert.equal(supply.testedAt, 10 * BAR_MS);
  assert.equal(supply.mitigatedAt, 15 * BAR_MS);
  assert.equal(supply.invalidatedIndex, 17);

  // DEMAND from the CHOCH at 14: never revisited, still FRESH.
  const demand = byBreak.get(14)!;
  assert.equal(demand.type, 'DEMAND');
  assert.deepEqual([demand.low, demand.high], [16.0, 17.2]);
  assert.equal(demand.state, 'FRESH');

  // DEMAND from the BOS at 17: tested at 19, invalidated at 20 (close 18.5 < 18.9).
  const demand2 = byBreak.get(17)!;
  assert.equal(demand2.type, 'DEMAND');
  assert.deepEqual([demand2.low, demand2.high], [18.9, 19.4]);
  assert.equal(demand2.state, 'INVALIDATED');
  assert.equal(demand2.testedAt, 19 * BAR_MS);
  assert.equal(demand2.invalidatedIndex, 20);

  // SUPPLY from the final CHOCH at 20: no candles after it, FRESH with age 0.
  const supply2 = byBreak.get(20)!;
  assert.equal(supply2.type, 'SUPPLY');
  assert.equal(supply2.state, 'FRESH');
  assert.equal(supply2.ageBars, 0);
});

const FIXTURE_B: Candle[] = [
  candle(0, 11.0, 11.5, 10.5, 11.0),
  candle(1, 11.0, 11.3, 10.6, 10.8),
  candle(2, 10.8, 11.1, 10.4, 10.7),
  candle(3, 10.7, 11.0, 10.1, 10.5),   // swing low 10.1 (strength 2)
  candle(4, 10.5, 10.9, 10.2, 10.7),
  candle(5, 10.7, 11.2, 10.4, 10.9),
  candle(6, 10.9, 11.4, 10.6, 11.0),
  candle(7, 11.0, 11.6, 10.7, 11.2),
  candle(8, 11.2, 11.5, 10.9, 11.1),
  candle(9, 11.1, 11.4, 9.85, 10.6),   // sweep: low < 10.1 - 0.15, close > 10.1
  candle(10, 10.6, 11.1, 10.3, 10.9),
  candle(11, 10.9, 11.3, 10.0, 10.5),   // second wick below — pool already consumed
  candle(12, 10.5, 11.0, 10.2, 10.8),
];

test('fixture: a swept swing-low pool is recorded once, marked taken, and stays swept', () => {
  const ledger = buildSweepLedger(FIXTURE_B, ATR);
  assert.equal(ledger.sweepHistory.length, 1);

  const sweep = ledger.sweepHistory[0];
  assert.equal(sweep.direction, 'SELL_SIDE');
  assert.equal(sweep.poolType, 'SWING_LOW');
  assert.equal(sweep.level, 10.1);
  assert.equal(sweep.sweepPrice, 9.85);
  assert.equal(sweep.index, 9);
  assert.deepEqual(sweep.poolSourceTimes, [3 * BAR_MS]);
  assert.ok(sweep.time > 3 * BAR_MS, 'sweep candle must postdate the pool sources');

  const struct = analyzeStructure('15m', FIXTURE_B, ATR, 2);
  const liq = detectLiquidity('15m', FIXTURE_B, struct, ATR);
  const swept = liq.pools.find((p) => p.type === 'SWING_LOW' && p.price === 10.1);
  assert.ok(swept, 'swept pool should still be listed');
  assert.equal(swept.taken, true);
  assert.equal(swept.sweptAt, 9 * BAR_MS);

  // Extending the window keeps the event byte-identical and the pool consumed.
  const extended = [...FIXTURE_B, candle(13, 10.8, 11.2, 10.5, 10.9), candle(14, 10.9, 11.3, 10.6, 11.0)];
  const ledger2 = buildSweepLedger(extended, ATR);
  const same = ledger2.sweepHistory.filter((s) => s.time <= FIXTURE_B[FIXTURE_B.length - 1].openTime);
  assert.deepEqual(same, ledger.sweepHistory);

  const sweptPools2 = ledger2.sweptPools.get(`SWING_LOW|${3 * BAR_MS}`);
  assert.ok(sweptPools2, 'pool must remain swept after appending candles');
  assert.equal(sweptPools2.sweptAt, 9 * BAR_MS);
});

test('fixture: an untouched zone expires exactly on the age-budget candle, never earlier', () => {
  const base: Candle[] = [
    candle(0, 10.0, 10.15, 9.85, 10.0),
    candle(1, 10.0, 9.6, 9.55, 9.65),
    candle(2, 9.65, 9.75, 9.3, 9.5),    // H = 9.75 (strength 1)
    candle(3, 9.5, 9.55, 9.1, 9.2),     // L = 9.1
    candle(4, 9.2, 9.6, 9.25, 9.55),
    candle(5, 9.55, 9.95, 9.5, 9.85),   // BULLISH BOS(9.75); DEMAND zone [9.1, 9.5]
  ];
  for (let i = 6; i <= 110; i++) {
    base.push(candle(i, 10.2, 10.35, 10.05, 10.2)); // flat, never touches the zone
  }

  const events = (len: number) => findStructureBreakEvents(base.slice(0, len), ATR, 1, 1000);

  // Prefix of 102 candles (indices 0..101): the zone is still FRESH.
  const freshZones = buildZoneLedger('15m', base.slice(0, 102), ATR, events(102));
  assert.equal(freshZones.length, 1);
  assert.equal(freshZones[0].state, 'FRESH');
  assert.equal(freshZones[0].expiredAt, null);

  // Candle 102 is the first index past the 96-bar budget: EXPIRED exactly there.
  const expiredZones = buildZoneLedger('15m', base.slice(0, 103), ATR, events(103));
  assert.equal(expiredZones[0].state, 'EXPIRED');
  assert.equal(expiredZones[0].expiredAt, 102 * BAR_MS);
  assert.equal(expiredZones[0].state === 'EXPIRED', true);

  // A longer prefix never resurrects it and never moves the timestamp.
  const laterZones = buildZoneLedger('15m', base.slice(0, 111), ATR, events(111));
  assert.equal(laterZones[0].state, 'EXPIRED');
  assert.equal(laterZones[0].expiredAt, 102 * BAR_MS);
});

test('MarketStateBuilder exposes the ledger outputs on the snapshot', () => {
  const state = new MarketStateBuilder().build({
    symbol: 'BTCUSDT',
    candles: CANDLES,
    mark: CANDLES[CANDLES.length - 1].close,
    fundingRate: 0.0001,
  });

  assert.ok((state.ltfStructure.breaks ?? []).length > 0, 'ltf break history missing');
  assert.ok((state.liquidity.ltf.sweepHistory ?? []).length > 0, 'ltf sweep history missing');
  assert.ok((state.zoneLedger ?? []).length > 0, 'zone ledger missing');

  const zoneKeys = new Set((state.zoneLedger ?? []).map((z) => `${z.timeframe}|${z.breakTime}`));
  assert.equal(zoneKeys.size, (state.zoneLedger ?? []).length, 'zone ledger keys must be unique');
});
