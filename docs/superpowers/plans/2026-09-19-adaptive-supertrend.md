# Adaptive SuperTrend Entries + Regime-Aware Trailing Exits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an ML Adaptive SuperTrend entry strategy for crypto futures with dynamic regime-based trailing SL/TP, an LLM veto on entries, and per-symbol price/quantity precision.

**Architecture:** A pure indicator module (`adaptiveSuperTrend.ts`) feeds an entry agent that emits one signal per closed 15m candle flip. A pure `nextStops` function trails SL/TP each 8s loop and the paper engine triggers them. Ollama may veto entries after the risk gate. A small `symbolRules.ts` registry loaded from Binance exchangeInfo rounds order prices/quantities and formats the UI per symbol.

**Tech Stack:** TypeScript (ESM, strict), `binance` npm package, `ollama`, Node built-in test runner via `tsx --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-19-adaptive-supertrend-design.md`

## Global Constraints

- Never commit automatically; ask the user before any commit. No `Co-Authored-By` line in commit messages (user's global CLAUDE.md overrides the harness attribution reminder).
- Functions ≤ 30 lines, files ≤ 300 lines, nesting ≤ 3, parameters ≤ 4. `Orchestrator.ts` ends at 293 lines and `panels.tsx` at 298: do not add lines to either beyond what this plan shows.
- Comments explain WHY only. No new files beyond those listed in this plan: `src/binance/symbolRules.ts`, `src/binance/adaptiveSuperTrend.ts`, `src/agents/TrailingStopManager.ts`, `src/agents/AdaptiveSuperTrendAgent.ts`, and six files under `tests/`.
- Symbol universe is `config.symbols` from `.env` (`BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT`); nothing else may be traded.
- Paper mode only for dynamic exits and the adaptive agent; live mode registers neither.
- Prices and quantities use each symbol's own precision (`symbolRules.ts`); every other displayed figure is 2 decimals, except funding rates which stay at 4 decimals (2dp would hide real values — confirm with the user if 2dp is wanted).
- Tests live in `tests/`, run with `npm test` (`tsx --test tests/*.test.ts`); `tsconfig.json` still includes only `src`, so `npm run build` output layout is unchanged.
- Every code block below was executed in a scratch copy: 43 tests pass and `npx tsc --noEmit` is clean after Task 9. Copy blocks verbatim; do not "improve" them.

## File Structure

| File | Responsibility |
|---|---|
| `src/binance/symbolRules.ts` (new) | Per-symbol precision registry: round, format, load from exchangeInfo |
| `src/binance/adaptiveSuperTrend.ts` (new) | Pure indicator: Wilder ATR, K-Means volatility regime, SuperTrend bands |
| `src/agents/TrailingStopManager.ts` (new) | Pure `nextStops(position, state)` trailing rules |
| `src/agents/AdaptiveSuperTrendAgent.ts` (new) | Entry signals, per-symbol state, stop updates, veto snapshot |
| `src/binance/paperEngine.ts` | Injectable state path, `initialRisk`, `updateStops`, stop fills at market |
| `src/binance/client.ts` | `openTime` in klines (300 candles), `loadSymbolRules`, `updateStops`, order rounding |
| `src/agents/ExecutorAgent.ts` | Round qty/prices per symbol, refuse sub-lot orders |
| `src/ollama/advisor.ts` | `veto()` with 5s timeout, fail-open; `parseVerdict` |
| `src/runtime/Orchestrator.ts` | Register agent, per-agent cooldown, veto hook, trail pass, rules load |
| `src/ui/panels.tsx`, `src/store.ts` | Per-symbol precision in real-value cells; agent row |

---

### Task 1: Types, test script, kline `openTime`

**Files:**
- Modify: `src/types.ts`, `package.json`, `src/binance/client.ts`

**Interfaces:**
- Produces: `Candle.openTime: number`; `AgentId` includes `'ADAPTIVE-ST-ζ'`; `Position.initialRisk?: number`; `VetoSnapshot`; `npm test`.

- [ ] **Step 1: Apply the type and script changes**

`src/types.ts` and `package.json`:

```diff
--- a/src/types.ts
+++ b/src/types.ts
@@ -1,9 +1,10 @@
 export type Side = 'LONG' | 'SHORT';
 export type Mode = 'paper' | 'live';
-export type AgentId = 'FUNDING-ARB-α' | 'PAIRS-TRD-β' | 'MOMENTUM-γ' | 'RISK-MGR-δ' | 'EXECUTOR-ε';
+export type AgentId = 'FUNDING-ARB-α' | 'PAIRS-TRD-β' | 'MOMENTUM-γ' | 'RISK-MGR-δ' | 'EXECUTOR-ε' | 'ADAPTIVE-ST-ζ';
 export type SignalType = 'OPEN_LONG' | 'OPEN_SHORT' | 'OPEN_HEDGE' | 'CLOSE' | 'MONITOR' | 'ALERT';
 
 export interface Candle {
+  openTime: number;
   open: number;
   high: number;
   low: number;
@@ -49,9 +50,23 @@
   liqDistancePct: number | null;
   serverSl: string;
   serverTp: string;
+  initialRisk?: number; // |entry - first SL| in price units; the 1R used for breakeven trailing
   posType?: string; // e.g. 'PERP-SHORT' | 'LONG/SHORT' | 'LONG'
 }
 
+/** What the LLM sees when asked to veto an entry; all numbers come from deterministic code. */
+export interface VetoSnapshot {
+  symbol: string;
+  side: Side;
+  regime: 'HIGH' | 'MEDIUM' | 'LOW';
+  distanceFromLineAtr: number;
+  rsi: number;
+  fundingRate: number;
+  entry: number;
+  stopLoss: number;
+  takeProfit: number;
+}
+
 export interface LogEntry {
   ts: number;
   agent: AgentId | 'SYSTEM' | 'MANUAL';
--- a/package.json
+++ b/package.json
@@ -10,7 +10,8 @@
     "dev:paper": "MODE=paper tsx src/index.tsx",
     "dev:live": "MODE=live tsx src/index.tsx",
     "build": "tsc",
-    "start": "node dist/index.js"
+    "start": "node dist/index.js",
+    "test": "tsx --test tests/*.test.ts"
   },
   "dependencies": {
     "@inkjs/ui": "^2.0.0",
```

- [ ] **Step 2: Apply the kline changes to `src/binance/client.ts`**

```diff
--- a/src/binance/client.ts
+++ b/src/binance/client.ts
@@ -3,6 +3,10 @@
 import { PaperEngine } from './paperEngine.js';
 import type { AgentId, Candle, Position } from '../types.js';
 
+// 300 closed 15m candles cover the adaptive SuperTrend's ATR warm-up (10) + K-Means window (100) with margin
+const KLINE_INTERVAL = '15m';
+const KLINE_LIMIT = 300;
+
 export class BinanceService {
   private futures: USDMClient;
   private ws: WebsocketClient | null = null;
@@ -41,6 +45,7 @@
       limit,
     });
     return (rawKlines as any[]).map((k: any[]) => ({
+      openTime: Number(k[0]),
       open: Number(k[1]),
       high: Number(k[2]),
       low: Number(k[3]),
@@ -63,7 +68,7 @@
     const [rawTickers, rawMarks, ...rawKlines] = await Promise.all([
       this.futures.get24hrChangeStatistics(),
       this.futures.getMarkPrice(),
-      ...symbols.map((s) => this.getKlines(s, '15m', 60)),
+      ...symbols.map((s) => this.getKlines(s, KLINE_INTERVAL, KLINE_LIMIT)),
     ]);
     const tickers: Record<string, { price: number; changePct: number; high24h: number; low24h: number; volumeQuote: number }> = {};
     const marks: Record<string, number> = {};
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: no output. (If `Candle` literals elsewhere fail to compile, add `openTime` to them.)

Note: Momentum's EMA50 is now seeded over 300 candles instead of 60, so its values shift slightly; this is intended.

- [ ] **Checkpoint**

Run `git status --short` and `git diff --stat`. **Do not commit** — ask the user first (their rule: commit only on explicit approval, no `Co-Authored-By` line).

---

### Task 2: Per-symbol precision registry

**Files:**
- Create: `src/binance/symbolRules.ts`
- Test: `tests/symbolRules.test.ts`

**Interfaces:**
- Produces: `SymbolRules`, `setSymbolRules(symbol, rules)`, `getSymbolRules(symbol)`, `rulesFromExchangeInfo(info)`, `roundPrice(symbol, price): number` (nearest tick), `roundQty(symbol, qty): number` (floor to step), `formatPrice(symbol, price): string`, `formatQty(symbol, qty): string`. Unknown symbols default to 2dp price / 3dp quantity.

- [ ] **Step 1: Write the failing test** — `tests/symbolRules.test.ts`

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FuturesSymbolExchangeInfo } from 'binance';
import {
  formatPrice, formatQty, roundPrice, roundQty, rulesFromExchangeInfo, setSymbolRules,
} from '../src/binance/symbolRules.js';

test('should read precision, tick and step from exchange info', () => {
  const info = {
    symbol: 'BTCUSDT',
    pricePrecision: 2,
    quantityPrecision: 3,
    filters: [
      { filterType: 'PRICE_FILTER', minPrice: '0.1', maxPrice: '1000000', tickSize: '0.10' },
      { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '1000', stepSize: '0.001' },
    ],
  } as unknown as FuturesSymbolExchangeInfo;
  assert.deepEqual(rulesFromExchangeInfo(info), { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.1, stepSize: 0.001 });
});

test('should round prices to the symbol tick and quantities down to the step', () => {
  setSymbolRules('BTCUSDT', { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.1, stepSize: 0.001 });
  setSymbolRules('AVAXUSDT', { pricePrecision: 3, quantityPrecision: 0, tickSize: 0.001, stepSize: 1 });
  assert.equal(roundPrice('BTCUSDT', 81070.06), 81070.1);
  assert.equal(roundPrice('AVAXUSDT', 8.54321), 8.543);
  assert.equal(roundQty('BTCUSDT', 0.0129999), 0.012);
  assert.equal(roundQty('BTCUSDT', 0.3), 0.3);
  assert.equal(roundQty('AVAXUSDT', 117.9), 117);
});

test('should format with each symbol precision and fall back to 2dp price for unknown symbols', () => {
  setSymbolRules('BTCUSDT', { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.1, stepSize: 0.001 });
  setSymbolRules('AVAXUSDT', { pricePrecision: 3, quantityPrecision: 0, tickSize: 0.001, stepSize: 1 });
  assert.equal(formatPrice('BTCUSDT', 81070.1), '81,070.10');
  assert.equal(formatPrice('AVAXUSDT', 8.5), '8.500');
  assert.equal(formatQty('AVAXUSDT', 117), '117');
  assert.equal(formatQty('BTCUSDT', 0.012), '0.012');
  assert.equal(formatPrice('UNKNOWNUSDT', 1.5), '1.50');
});
```

- [ ] **Run it and confirm it fails**

Run: `npx tsx --test tests/symbolRules.test.ts`
Expected: FAIL (module or export not found)

- [ ] **Step 3: Implement** — `src/binance/symbolRules.ts`

```typescript
import type { FuturesSymbolExchangeInfo } from 'binance';

export interface SymbolRules {
  pricePrecision: number;
  quantityPrecision: number;
  tickSize: number;
  stepSize: number;
}

// Used until exchange info loads, and for symbols it does not list
const DEFAULT_RULES: SymbolRules = {
  pricePrecision: 2,
  quantityPrecision: 3,
  tickSize: 0.01,
  stepSize: 0.001,
};

// Absorbs float error such as 0.3 / 0.1 = 2.9999999999999996 before flooring to a step
const STEP_EPSILON = 1e-9;

const rulesBySymbol = new Map<string, SymbolRules>();

export function setSymbolRules(symbol: string, rules: SymbolRules): void {
  rulesBySymbol.set(symbol, rules);
}

export function getSymbolRules(symbol: string): SymbolRules {
  return rulesBySymbol.get(symbol) ?? DEFAULT_RULES;
}

/** Builds rules from a Binance USD-M exchangeInfo symbol entry. */
export function rulesFromExchangeInfo(info: FuturesSymbolExchangeInfo): SymbolRules {
  const priceFilter = info.filters.find((f) => f.filterType === 'PRICE_FILTER');
  const lotFilter = info.filters.find((f) => f.filterType === 'LOT_SIZE');
  return {
    pricePrecision: info.pricePrecision,
    quantityPrecision: info.quantityPrecision,
    tickSize: Number(priceFilter && 'tickSize' in priceFilter ? priceFilter.tickSize : 10 ** -info.pricePrecision),
    stepSize: Number(lotFilter && 'stepSize' in lotFilter ? lotFilter.stepSize : 10 ** -info.quantityPrecision),
  };
}

/** Nearest valid tick for the symbol; the exchange rejects prices off the tick grid. */
export function roundPrice(symbol: string, price: number): number {
  const { tickSize, pricePrecision } = getSymbolRules(symbol);
  return Number((Math.round(price / tickSize) * tickSize).toFixed(pricePrecision));
}

/** Rounds down to the lot step so an order never exceeds its intended size. */
export function roundQty(symbol: string, qty: number): number {
  const { stepSize, quantityPrecision } = getSymbolRules(symbol);
  return Number((Math.floor(qty / stepSize + STEP_EPSILON) * stepSize).toFixed(quantityPrecision));
}

export function formatPrice(symbol: string, price: number): string {
  const { pricePrecision } = getSymbolRules(symbol);
  return price.toLocaleString('en-US', { minimumFractionDigits: pricePrecision, maximumFractionDigits: pricePrecision });
}

export function formatQty(symbol: string, qty: number): string {
  const { quantityPrecision } = getSymbolRules(symbol);
  return qty.toFixed(quantityPrecision);
}
```

- [ ] **Run it and confirm it passes**

Run: `npx tsx --test tests/symbolRules.test.ts` then `npx tsc --noEmit`
Expected: all tests pass, tsc prints nothing

- [ ] **Checkpoint**

Run `git status --short` and `git diff --stat`. **Do not commit** — ask the user first (their rule: commit only on explicit approval, no `Co-Authored-By` line).

---

### Task 3: Adaptive SuperTrend indicator

**Files:**
- Create: `src/binance/adaptiveSuperTrend.ts`
- Test: `tests/adaptiveSuperTrend.test.ts`

**Interfaces:**
- Consumes: `Candle` (with `openTime`).
- Produces: `calculateAdaptiveSuperTrend(candles, options?) → AdaptiveSuperTrendBar[]` (first bar at index 108 with defaults: ATR warm-up 10 + training window 100), `wilderAtr`, `kMeans`, `nearestRegime`, `Regime`, `TrendDirection`, `TP_ATR_MULTIPLE`.

- [ ] **Step 1: Write the failing test** — `tests/adaptiveSuperTrend.test.ts`

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle } from '../src/types.js';
import {
  calculateAdaptiveSuperTrend, kMeans, nearestRegime, wilderAtr,
} from '../src/binance/adaptiveSuperTrend.js';

const BAR_MS = 15 * 60_000;

function candle(index: number, close: number, halfRange = 1): Candle {
  return { openTime: index * BAR_MS, open: close, high: close + halfRange, low: close - halfRange, close, volume: 1 };
}

/** 120 flat bars, 20 rising by 1, 20 falling by 1: constant true range of 2 throughout. */
function upThenDownCloses(): number[] {
  const closes = new Array(120).fill(100);
  for (let i = 1; i <= 20; i++) closes.push(100 + i);
  for (let i = 1; i <= 20; i++) closes.push(120 - i);
  return closes;
}

test('should compute Wilder ATR with SMA seed then recursive smoothing', () => {
  const candles = Array.from({ length: 10 }, (_, i) => candle(i, 10));
  candles.push({ openTime: 10 * BAR_MS, open: 10, high: 22, low: 10, close: 10, volume: 1 });
  const atr = wilderAtr(candles, 10);
  assert.ok(Number.isNaN(atr[8]));
  assert.equal(atr[9], 2);
  assert.ok(Math.abs(atr[10] - 3) < 1e-12);
});

test('should converge K-Means to the cluster means', () => {
  const values = [1, 1, 1, 5, 5, 5, 9, 9, 9];
  assert.deepEqual(kMeans(values, { HIGH: 7, MEDIUM: 5, LOW: 3 }), { HIGH: 9, MEDIUM: 5, LOW: 1 });
});

test('should keep the previous centroid when a cluster is empty', () => {
  assert.deepEqual(kMeans([4, 4, 4], { HIGH: 6, MEDIUM: 4, LOW: 2 }), { HIGH: 6, MEDIUM: 4, LOW: 2 });
});

test('should assign an equidistant value to the higher-volatility cluster', () => {
  assert.equal(nearestRegime(5, { HIGH: 6, MEDIUM: 4, LOW: 2 }), 'HIGH');
});

test('should emit no bars until ATR and the training window both exist', () => {
  const closes = upThenDownCloses();
  assert.equal(calculateAdaptiveSuperTrend(closes.slice(0, 108).map((c, i) => candle(i, c))).length, 0);
  const bars = calculateAdaptiveSuperTrend(closes.slice(0, 109).map((c, i) => candle(i, c)));
  assert.equal(bars.length, 1);
  assert.equal(bars[0].direction, 'BEARISH');
  assert.equal(bars[0].trendShift, null);
});

test('should fire exactly one shift per crossing and use the assigned ATR for the band', () => {
  const bars = calculateAdaptiveSuperTrend(upThenDownCloses().map((c, i) => candle(i, c)));
  const shifts = bars.filter((b) => b.trendShift).map((b) => b.trendShift);
  assert.deepEqual(shifts, ['BULLISH', 'BEARISH']);
  const first = bars[0];
  assert.equal(first.assignedAtr, 2);
  assert.equal(first.superTrend, first.candle.close + 3 * first.assignedAtr);
});

test('should never loosen the lower band while bullish', () => {
  const bars = calculateAdaptiveSuperTrend(upThenDownCloses().map((c, i) => candle(i, c)));
  const bullish = bars.filter((b) => b.direction === 'BULLISH');
  for (let i = 1; i < bullish.length; i++) {
    if (bullish[i].candle.openTime - bullish[i - 1].candle.openTime === BAR_MS) {
      assert.ok(bullish[i].superTrend >= bullish[i - 1].superTrend);
    }
  }
});

test('should report a regime shift only on the bar where the regime changes', () => {
  // Alternating 20-bar calm/volatile blocks move ATR inside the 100-bar training window
  const candles = Array.from({ length: 260 }, (_, i) => candle(i, 100, Math.floor(i / 20) % 2 === 1 ? 6 : 1));
  const bars = calculateAdaptiveSuperTrend(candles);
  bars.forEach((bar, i) => {
    const expected = i > 0 && bars[i - 1].regime !== bar.regime ? bar.regime : null;
    assert.equal(bar.regimeShift, expected);
  });
  assert.ok(bars.filter((b) => b.regimeShift !== null).length >= 4);
});
```

- [ ] **Run it and confirm it fails**

Run: `npx tsx --test tests/adaptiveSuperTrend.test.ts`
Expected: FAIL (module or export not found)

- [ ] **Step 3: Implement** — `src/binance/adaptiveSuperTrend.ts`

```typescript
// TypeScript port of AlgoAlpha's "Machine Learning Adaptive SuperTrend" (Pine, MPL-2.0).
// SuperTrend bands use the K-Means volatility centroid instead of the raw ATR.
import type { Candle } from '../types.js';

export type Regime = 'HIGH' | 'MEDIUM' | 'LOW';
export type TrendDirection = 'BULLISH' | 'BEARISH';
export type Centroids = Record<Regime, number>;

export interface AdaptiveSuperTrendOptions {
  atrLength: number;
  factor: number;
  trainingPeriod: number;
}

export interface AdaptiveSuperTrendBar {
  candle: Candle;
  atr: number;
  centroids: Centroids;
  regime: Regime;
  assignedAtr: number;
  superTrend: number;
  direction: TrendDirection;
  trendShift: TrendDirection | null;
  regimeShift: Regime | null;
}

const DEFAULT_OPTIONS: AdaptiveSuperTrendOptions = { atrLength: 10, factor: 3, trainingPeriod: 100 };
const MAX_KMEANS_ITERATIONS = 100;
const INITIAL_PERCENTILES: Centroids = { HIGH: 0.75, MEDIUM: 0.5, LOW: 0.25 };

/** TP distance in assigned-ATR units per regime (LOW is only used by the trailing cap). */
export const TP_ATR_MULTIPLE: Record<Regime, number> = { LOW: 2, MEDIUM: 3, HIGH: 4 };

// Order is the tie priority: an equidistant value joins the higher-volatility cluster
const REGIMES: Regime[] = ['HIGH', 'MEDIUM', 'LOW'];

/** Wilder-smoothed ATR (Pine ta.atr); NaN until `period` true ranges exist. */
export function wilderAtr(candles: Candle[], period: number): number[] {
  const atr = new Array<number>(candles.length).fill(NaN);
  let trSum = 0;
  candles.forEach((c, i) => {
    const previousClose = i > 0 ? candles[i - 1].close : c.close;
    const trueRange = Math.max(c.high - c.low, Math.abs(c.high - previousClose), Math.abs(c.low - previousClose));
    if (i < period) trSum += trueRange;
    if (i === period - 1) atr[i] = trSum / period;
    if (i >= period) atr[i] = (atr[i - 1] * (period - 1) + trueRange) / period;
  });
  return atr;
}

export function nearestRegime(value: number, centroids: Centroids): Regime {
  let best: Regime = 'HIGH';
  for (const regime of REGIMES) {
    if (Math.abs(value - centroids[regime]) < Math.abs(value - centroids[best])) best = regime;
  }
  return best;
}

/** 3-cluster K-Means over volatility values; an empty cluster keeps its previous centroid. */
export function kMeans(values: number[], initial: Centroids): Centroids {
  let centroids = initial;
  for (let iteration = 0; iteration < MAX_KMEANS_ITERATIONS; iteration++) {
    const sums: Centroids = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    const counts: Centroids = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const value of values) {
      const regime = nearestRegime(value, centroids);
      sums[regime] += value;
      counts[regime] += 1;
    }
    const next = { ...centroids };
    for (const regime of REGIMES) {
      if (counts[regime] > 0) next[regime] = sums[regime] / counts[regime];
    }
    const converged = REGIMES.every((regime) => next[regime] === centroids[regime]);
    centroids = next;
    if (converged) break;
  }
  return centroids;
}

function initialCentroids(window: number[]): Centroids {
  const lower = Math.min(...window);
  const upper = Math.max(...window);
  const at = (percentile: number) => lower + (upper - lower) * percentile;
  return { HIGH: at(INITIAL_PERCENTILES.HIGH), MEDIUM: at(INITIAL_PERCENTILES.MEDIUM), LOW: at(INITIAL_PERCENTILES.LOW) };
}

interface BandState {
  upper: number;
  lower: number;
  line: number;
  direction: TrendDirection;
}

function nextBandState(candle: Candle, previousClose: number, assignedAtr: number, factor: number, previous: BandState | null): BandState {
  const hl2 = (candle.high + candle.low) / 2;
  let upper = hl2 + factor * assignedAtr;
  let lower = hl2 - factor * assignedAtr;
  if (!previous) return { upper, lower, line: upper, direction: 'BEARISH' };

  if (!(lower > previous.lower || previousClose < previous.lower)) lower = previous.lower;
  if (!(upper < previous.upper || previousClose > previous.upper)) upper = previous.upper;

  const direction: TrendDirection = previous.direction === 'BEARISH'
    ? (candle.close > upper ? 'BULLISH' : 'BEARISH')
    : (candle.close < lower ? 'BEARISH' : 'BULLISH');
  return { upper, lower, line: direction === 'BULLISH' ? lower : upper, direction };
}

/** Runs the indicator over closed candles; the first bar is emitted once ATR and the training window both exist. */
export function calculateAdaptiveSuperTrend(
  candles: Candle[],
  options: Partial<AdaptiveSuperTrendOptions> = {},
): AdaptiveSuperTrendBar[] {
  const { atrLength, factor, trainingPeriod } = { ...DEFAULT_OPTIONS, ...options };
  const atrSeries = wilderAtr(candles, atrLength);
  const bars: AdaptiveSuperTrendBar[] = [];
  let state: BandState | null = null;

  for (let i = atrLength + trainingPeriod - 2; i < candles.length; i++) {
    if (!(atrSeries[i] > 0)) continue;
    const window = atrSeries.slice(i - trainingPeriod + 1, i + 1);
    const centroids = kMeans(window, initialCentroids(window));
    const regime = nearestRegime(atrSeries[i], centroids);
    const assignedAtr = centroids[regime];
    const next = nextBandState(candles[i], candles[i - 1].close, assignedAtr, factor, state);
    const previous = bars.at(-1);
    bars.push({
      candle: candles[i],
      atr: atrSeries[i],
      centroids,
      regime,
      assignedAtr,
      superTrend: next.line,
      direction: next.direction,
      trendShift: previous && previous.direction !== next.direction ? next.direction : null,
      regimeShift: previous && previous.regime !== regime ? regime : null,
    });
    state = next;
  }
  return bars;
}
```

- [ ] **Run it and confirm it passes**

Run: `npx tsx --test tests/adaptiveSuperTrend.test.ts` then `npx tsc --noEmit`
Expected: all tests pass, tsc prints nothing

> Fidelity caveat: verified by invariants and hand-computed values only. Exact agreement with TradingView needs a golden export (about 150 bars plus the indicator's SuperTrend and centroid columns) from the user; add it as `tests/adaptiveSuperTrend.golden.test.ts` when provided.

- [ ] **Checkpoint**

Run `git status --short` and `git diff --stat`. **Do not commit** — ask the user first (their rule: commit only on explicit approval, no `Co-Authored-By` line).

---

### Task 4: Paper engine — initial risk, `updateStops`, market-fill stops

**Files:**
- Modify: `src/binance/paperEngine.ts`
- Test: `tests/paperEngine.test.ts`

**Interfaces:**
- Produces: `new PaperEngine(filePath?)`, `updateStops(symbol, strategy, stopLoss, takeProfit): void`, positions carry `initialRisk`; a breached stop now fills at the current mark.

- [ ] **Step 1: Write the failing test** — `tests/paperEngine.test.ts`

```typescript
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PaperEngine } from '../src/binance/paperEngine.js';

const base = { symbol: 'BTCUSDT', leverage: 5, strategy: 'MOMENTUM-γ' as const };
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

// Each engine persists to its own temp file so tests never touch data/paper-state.json
function freshEngine(): PaperEngine {
  return new PaperEngine(path.join(mkdtempSync(path.join(tmpdir(), 'paper-')), 'state.json'));
}

test('should merge same-side fills into one position with weighted-average entry', () => {
  const engine = freshEngine();
  engine.openPosition({ ...base, side: 'BUY', qty: 1, entryPrice: 100, stopLoss: 90, takeProfit: 130 });
  engine.openPosition({ ...base, side: 'BUY', qty: 3, entryPrice: 120, stopLoss: 105 });
  const [pos] = engine.getPositions();
  assert.equal(engine.getPositions().length, 1);
  near(pos.entry, 115);
  near(pos.qty, 4);
  assert.equal(pos.serverSl, '105');
  assert.equal(pos.serverTp, '130');
  near(pos.initialRisk!, 10);
});

test('should book realized PnL at the TP level and remove the position', () => {
  const engine = freshEngine();
  engine.openPosition({ ...base, side: 'BUY', qty: 4, entryPrice: 115, stopLoss: 90, takeProfit: 130 });
  engine.markAll({ BTCUSDT: 125 });
  near(engine.getAccount().equity, 100_040);
  const exits = engine.markAll({ BTCUSDT: 131 });
  assert.match(exits[0], /TAKE PROFIT/);
  assert.equal(engine.getPositions().length, 0);
  near(engine.getAccount().equity, 100_060);
});

test('should fill a breached stop at the market, not at the stop level', () => {
  const engine = freshEngine();
  engine.openPosition({ ...base, side: 'SELL', qty: 2, entryPrice: 100, stopLoss: 105, takeProfit: 90 });
  const exits = engine.markAll({ BTCUSDT: 106 });
  assert.match(exits[0], /STOP LOSS/);
  near(engine.getAccount().equity, 100_000 - 12);
});

test('should liquidate a 10x long at entry * (1 - 0.1 + 0.005)', () => {
  const engine = freshEngine();
  engine.openPosition({ ...base, leverage: 10, side: 'BUY', qty: 1, entryPrice: 100 });
  near(engine.getPositions()[0].liqDistancePct!, 9.5);
  const exits = engine.markAll({ BTCUSDT: 90 });
  assert.match(exits[0], /LIQUIDATED/);
  near(engine.getAccount().equity, 100_000 - 9.5);
});

test('should net an opposite fill and flip the remainder', () => {
  const engine = freshEngine();
  engine.openPosition({ ...base, side: 'BUY', qty: 2, entryPrice: 100 });
  engine.openPosition({ ...base, side: 'SELL', qty: 1, entryPrice: 110 });
  near(engine.getPositions()[0].qty, 1);
  near(engine.getAccount().equity, 100_010);
  engine.openPosition({ ...base, side: 'SELL', qty: 3, entryPrice: 110 });
  const [pos] = engine.getPositions();
  assert.equal(pos.side, 'SHORT');
  near(pos.qty, 2);
});

test('should keep strategies separate and close only the requested one', () => {
  const engine = freshEngine();
  engine.openPosition({ ...base, side: 'BUY', qty: 1, entryPrice: 100 });
  engine.openPosition({ ...base, strategy: 'ADAPTIVE-ST-ζ', side: 'SELL', qty: 1, entryPrice: 100 });
  assert.equal(engine.getPositions().length, 2);
  engine.openPosition({ ...base, side: 'SELL', qty: 1, entryPrice: 100, reduceOnly: true });
  assert.deepEqual(engine.getPositions().map((p) => p.strategy), ['ADAPTIVE-ST-ζ']);
});

test('should replace SL/TP through updateStops and ignore unknown positions', () => {
  const engine = freshEngine();
  engine.openPosition({ ...base, side: 'BUY', qty: 1, entryPrice: 100, stopLoss: 94, takeProfit: 112 });
  engine.updateStops('BTCUSDT', 'MOMENTUM-γ', 97, 115);
  assert.equal(engine.getPositions()[0].serverSl, '97');
  assert.equal(engine.getPositions()[0].serverTp, '115');
  engine.updateStops('ETHUSDT', 'MOMENTUM-γ', 1, 2);
  assert.equal(engine.getPositions().length, 1);
});

test('should reject a fill when no price is available', () => {
  assert.throws(() => freshEngine().openPosition({ ...base, symbol: 'XRPUSDT', side: 'BUY', qty: 1 }), /no price/);
});
```

- [ ] **Run it and confirm it fails**

Run: `npx tsx --test tests/paperEngine.test.ts`
Expected: FAIL (module or export not found)

- [ ] **Step 3: Apply the engine changes**

```diff
--- a/src/binance/paperEngine.ts
+++ b/src/binance/paperEngine.ts
@@ -53,7 +53,8 @@
     return { price: liqPrice, reason: 'LIQUIDATED' };
   }
   if (stopLoss > 0 && (pos.mark - stopLoss) * direction <= 0) {
-    return { price: stopLoss, reason: 'STOP LOSS' };
+    // A stop already breached fills at the market: filling at the stop level would credit a phantom gain
+    return { price: pos.mark, reason: 'STOP LOSS' };
   }
   if (takeProfit > 0 && (pos.mark - takeProfit) * direction >= 0) {
     return { price: takeProfit, reason: 'TAKE PROFIT' };
@@ -67,10 +68,9 @@
   // Wallet balance: starting cash plus realized PnL (name kept for saved-state compatibility)
   private startEquity = 100_000;
   private lastPrices: Record<string, number> = {};
-  private filePath = path.resolve('data/paper-state.json');
   private saveTimer: NodeJS.Timeout | null = null;
 
-  constructor() {
+  constructor(private readonly filePath = path.resolve('data/paper-state.json')) {
     this.loadState();
   }
 
@@ -178,6 +178,7 @@
       entry: price,
       qty,
       mark: price,
+      initialRisk: params.stopLoss ? Math.abs(price - params.stopLoss) : undefined,
       upnl: 0,
       upnlPct: 0,
       leverage: params.leverage,
@@ -190,6 +191,15 @@
     return pos;
   }
 
+  /** Replaces SL/TP on the symbol+strategy position; the next markAll triggers on them. */
+  updateStops(symbol: string, strategy: AgentId, stopLoss: number, takeProfit: number): void {
+    const pos = this.positions.find((p) => p.symbol === symbol && p.strategy === strategy);
+    if (!pos) return;
+    pos.serverSl = String(stopLoss);
+    pos.serverTp = String(takeProfit);
+    this.persist();
+  }
+
   private syncEquity(): void {
     this.equity = this.startEquity + this.positions.reduce((sum, pos) => sum + pos.upnl, 0);
   }
```

- [ ] **Run it and confirm it passes**

Run: `npx tsx --test tests/paperEngine.test.ts` then `npx tsc --noEmit`
Expected: all tests pass, tsc prints nothing

- [ ] **Checkpoint**

Run `git status --short` and `git diff --stat`. **Do not commit** — ask the user first (their rule: commit only on explicit approval, no `Co-Authored-By` line).

---

### Task 5: Trailing stop manager

**Files:**
- Create: `src/agents/TrailingStopManager.ts`
- Test: `tests/trailingStopManager.test.ts`

**Interfaces:**
- Consumes: `TP_ATR_MULTIPLE`, `AdaptiveSuperTrendBar` (Task 3); `Position.initialRisk` (Task 1).
- Produces: `nextStops(position, state: TrailState): StopLevels | null` (null = no change), `StopLevels`, `TrailState`.

- [ ] **Step 1: Write the failing test** — `tests/trailingStopManager.test.ts`

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Position } from '../src/types.js';
import { nextStops, type TrailState } from '../src/agents/TrailingStopManager.js';

function longPosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'BTCUSDT_ADAPTIVE-ST-ζ', symbol: 'BTCUSDT', side: 'LONG', strategy: 'ADAPTIVE-ST-ζ',
    entry: 100, qty: 1, mark: 105, upnl: 5, upnlPct: 5, leverage: 5, marginType: 'ISOLATED',
    liqDistancePct: null, serverSl: '94', serverTp: '112', initialRisk: 6, ...overrides,
  };
}

const medium = (superTrend: number): TrailState => ({ superTrend, regime: 'MEDIUM', assignedAtr: 2 });

test('should ratchet the stop up to the SuperTrend line', () => {
  assert.deepEqual(nextStops(longPosition(), medium(97)), { stopLoss: 97, takeProfit: 112 });
});

test('should never loosen the stop', () => {
  assert.equal(nextStops(longPosition(), medium(90)), null);
});

test('should lock breakeven once price has moved 1R', () => {
  assert.deepEqual(nextStops(longPosition({ mark: 106 }), medium(95)), { stopLoss: 100, takeProfit: 112 });
});

test('should extend the target and lock gains when price nears it', () => {
  // mark 111.5 is 0.5 from TP (<= 0.5 ATR = 1): TP +1 ATR, SL floors at oldTP - 1 ATR
  assert.deepEqual(nextStops(longPosition({ mark: 111.5 }), medium(95)), { stopLoss: 110, takeProfit: 114 });
});

test('should cap the target near price in LOW regime while in profit', () => {
  const state: TrailState = { superTrend: 97, regime: 'LOW', assignedAtr: 2 };
  assert.deepEqual(nextStops(longPosition(), state), { stopLoss: 97, takeProfit: 109 });
});

test('should leave the target alone in LOW regime while losing', () => {
  const state: TrailState = { superTrend: 90, regime: 'LOW', assignedAtr: 2 };
  assert.equal(nextStops(longPosition({ mark: 98 }), state), null);
});

test('should mirror every rule for shorts', () => {
  const short = longPosition({ side: 'SHORT', mark: 95, serverSl: '106', serverTp: '88' });
  assert.deepEqual(nextStops(short, medium(103)), { stopLoss: 103, takeProfit: 88 });
  const nearTarget = { ...short, mark: 88.5 };
  assert.deepEqual(nextStops(nearTarget, medium(105)), { stopLoss: 90, takeProfit: 86 });
});

test('should be idempotent: applying the result and calling again changes nothing', () => {
  const position = longPosition({ mark: 111.5 });
  const first = nextStops(position, medium(95))!;
  const applied = { ...position, serverSl: String(first.stopLoss), serverTp: String(first.takeProfit) };
  assert.equal(nextStops(applied, medium(95)), null);
});

test('should skip positions whose stops are not numeric', () => {
  assert.equal(nextStops(longPosition({ serverSl: '—' }), medium(97)), null);
});
```

- [ ] **Run it and confirm it fails**

Run: `npx tsx --test tests/trailingStopManager.test.ts`
Expected: FAIL (module or export not found)

- [ ] **Step 3: Implement** — `src/agents/TrailingStopManager.ts`

```typescript
import type { Position } from '../types.js';
import { TP_ATR_MULTIPLE, type AdaptiveSuperTrendBar } from '../binance/adaptiveSuperTrend.js';

export interface StopLevels {
  stopLoss: number;
  takeProfit: number;
}

export type TrailState = Pick<AdaptiveSuperTrendBar, 'superTrend' | 'regime' | 'assignedAtr'>;

// Extend the TP once price is within this many assigned ATRs of it, by TP_EXTENSION_ATR
const TP_TRIGGER_ATR = 0.5;
const TP_EXTENSION_ATR = 1;

/**
 * Regime-aware trailing stops for a trade opened on an Adaptive SuperTrend flip.
 * Returns the new levels, or null when nothing changes. Pure and idempotent: calling it
 * again with the returned levels yields null. `direction` is +1 for longs, -1 for shorts.
 */
export function nextStops(position: Position, state: TrailState): StopLevels | null {
  const currentStop = Number(position.serverSl);
  const currentTarget = Number(position.serverTp);
  if (!(currentStop > 0) || !(currentTarget > 0)) return null;

  const direction = position.side === 'LONG' ? 1 : -1;
  const tighter = (a: number, b: number) => (direction === 1 ? Math.max(a, b) : Math.min(a, b));
  const { mark, entry } = position;
  const atr = state.assignedAtr;

  let stopLoss = tighter(currentStop, state.superTrend);
  let takeProfit = currentTarget;

  const oneR = position.initialRisk ?? 0;
  if (oneR > 0 && (mark - entry) * direction >= oneR) stopLoss = tighter(stopLoss, entry);

  if ((takeProfit - mark) * direction <= TP_TRIGGER_ATR * atr) {
    stopLoss = tighter(stopLoss, takeProfit - direction * atr);
    takeProfit += direction * TP_EXTENSION_ATR * atr;
  }

  if (state.regime === 'LOW' && (mark - entry) * direction > 0) {
    const cap = mark + direction * TP_ATR_MULTIPLE.LOW * atr;
    takeProfit = direction === 1 ? Math.min(takeProfit, cap) : Math.max(takeProfit, cap);
  }

  return stopLoss === currentStop && takeProfit === currentTarget ? null : { stopLoss, takeProfit };
}
```

- [ ] **Run it and confirm it passes**

Run: `npx tsx --test tests/trailingStopManager.test.ts` then `npx tsc --noEmit`
Expected: all tests pass, tsc prints nothing

- [ ] **Checkpoint**

Run `git status --short` and `git diff --stat`. **Do not commit** — ask the user first (their rule: commit only on explicit approval, no `Co-Authored-By` line).

---

### Task 6: Per-agent cooldown and the Adaptive SuperTrend agent

**Files:**
- Modify: `src/agents/BaseAgent.ts`
- Create: `src/agents/AdaptiveSuperTrendAgent.ts`
- Test: `tests/adaptiveSuperTrendAgent.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 3, 5.
- Produces: BTC anchor rule (alt flips must agree with BTCUSDT's current SuperTrend direction; BTC unfiltered; no BTC read means no alt entry; filter off if BTCUSDT is not in `config.symbols`); `BaseAgent.cooldownMs`, `DEFAULT_COOLDOWN_MS`; `AdaptiveSuperTrendAgent` with `id 'ADAPTIVE-ST-ζ'`, `stateFor(symbol)`, `stopUpdates(positions): StopUpdate[]`, `vetoSnapshot(signal, ctx): VetoSnapshot | null`, `StopUpdate`.

- [ ] **Step 1: Write the failing test** — `tests/adaptiveSuperTrendAgent.test.ts`

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import { AdaptiveSuperTrendAgent } from '../src/agents/AdaptiveSuperTrendAgent.js';
import type { MarketContext } from '../src/agents/BaseAgent.js';
import { config } from '../src/config.js';
import type { Candle, Position } from '../src/types.js';

const symbol = config.symbols[0];
const BAR_MS = 15 * 60_000;

// 120 flat bars then a steady climb: constant true range 2, so the bullish flip lands on bar 126
function candles(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = i < 120 ? 100 : 100 + (i - 119);
    return { openTime: i * BAR_MS, open: close, high: close + 1, low: close - 1, close, volume: 1 };
  });
}

function context(count: number, mark: number): MarketContext {
  return { candles: { [symbol]: candles(count) }, funding: {}, marks: { [symbol]: mark }, spot: {}, equity: 100_000 };
}

const agent = () => new AdaptiveSuperTrendAgent({} as BinanceService);

test('should emit one long entry on a closed-candle flip, with SL on the SuperTrend line', async () => {
  // 128 candles: the last (index 127) is still forming, so the flip on index 126 is the last closed bar
  const signals = await agent().run(context(128, 107));
  assert.equal(signals.length, 1);
  const [signal] = signals;
  assert.equal(signal.type, 'OPEN_LONG');
  assert.equal(signal.entry, 107);
  assert.ok(signal.stopLoss! < 107);
  assert.ok(signal.takeProfit! > 107);
});

test('should not repaint: a flip on the still-forming candle emits nothing', async () => {
  assert.equal((await agent().run(context(127, 107))).length, 0);
});

test('should handle each closed candle once', async () => {
  const instance = agent();
  assert.equal((await instance.run(context(128, 107))).length, 1);
  assert.equal((await instance.run(context(128, 107))).length, 0);
});

test('should drop a stale flip when price already crossed the stop line', async () => {
  assert.equal((await agent().run(context(128, 50))).length, 0);
});

// ETH climbs exactly like BTC in `context`, so BTC's own state decides whether the ETH flip is allowed
function twoSymbolContext(btcCandles: Candle[]): MarketContext {
  return {
    candles: { BTCUSDT: btcCandles, ETHUSDT: candles(128) },
    funding: {}, marks: { BTCUSDT: 107, ETHUSDT: 107 }, spot: {}, equity: 100_000,
  };
}

test('should allow an alt flip that agrees with the BTC anchor', async () => {
  const signals = await agent().run(twoSymbolContext(candles(128)));
  assert.deepEqual(signals.map((s) => s.symbol).sort(), ['BTCUSDT', 'ETHUSDT']);
});

test('should skip an alt flip while BTC has not flipped the same way', async () => {
  const flatBtc = candles(128).map((c, i) => ({ ...c, open: 100, high: 101, low: 99, close: 100, openTime: i * BAR_MS }));
  const signals = await agent().run(twoSymbolContext(flatBtc));
  assert.deepEqual(signals, []);
});

test('should not use the shared fill cooldown', () => {
  assert.equal(agent().cooldownMs, 0);
});

test('should trail an open position with rounded stops and skip unchanged ones', async () => {
  const instance = agent();
  await instance.run(context(128, 107));
  const state = instance.stateFor(symbol)!;
  const position: Position = {
    id: 'p', symbol, side: 'LONG', strategy: 'ADAPTIVE-ST-ζ', entry: 107, qty: 1, mark: 108, upnl: 1, upnlPct: 1,
    leverage: 5, marginType: 'ISOLATED', liqDistancePct: null, serverSl: String(state.superTrend - 10), serverTp: '130', initialRisk: 6,
  };
  const [update] = instance.stopUpdates([position]);
  assert.equal(update.stopLoss, Math.round(state.superTrend * 100) / 100);
  assert.deepEqual(instance.stopUpdates([{ ...position, serverSl: String(update.stopLoss) }]), []);
});
```

- [ ] **Run it and confirm it fails**

Run: `npx tsx --test tests/adaptiveSuperTrendAgent.test.ts`
Expected: FAIL (module or export not found)

- [ ] **Step 3: Add `cooldownMs` to `BaseAgent`**

```diff
--- a/src/agents/BaseAgent.ts
+++ b/src/agents/BaseAgent.ts
@@ -11,8 +11,13 @@
   positions?: Position[];
 }
 
+// Momentum re-fires every 8s tick while the forming 15m candle stays across EMA50
+export const DEFAULT_COOLDOWN_MS = 15 * 60_000;
+
 export abstract class BaseAgent extends EventEmitter {
   abstract readonly id: string;
+  /** Minimum gap between fills for one symbol; agents that dedupe per candle themselves set 0. */
+  readonly cooldownMs: number = DEFAULT_COOLDOWN_MS;
   abstract readonly strategy: string;
   status: 'RUNNING' | 'PAUSED' | 'WATCHING' = 'RUNNING';
 
```

- [ ] **Step 4: Implement** — `src/agents/AdaptiveSuperTrendAgent.ts`

```typescript
import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { Position, Signal, VetoSnapshot } from '../types.js';
import { calculateAdaptiveSuperTrend, TP_ATR_MULTIPLE, type AdaptiveSuperTrendBar, type TrendDirection } from '../binance/adaptiveSuperTrend.js';
import { rsi } from '../binance/indicators.js';
import { roundPrice } from '../binance/symbolRules.js';
import { nextStops } from './TrailingStopManager.js';
import { config } from '../config.js';

// BTC leads the alts: an alt flip that fights BTC's trend is skipped, while BTC itself is unfiltered
const ANCHOR_SYMBOL = 'BTCUSDT';
const ENTRY_CONFIDENCE = 0.75;
const RSI_PERIOD = 14;

export interface StopUpdate {
  symbol: string;
  strategy: Position['strategy'];
  stopLoss: number;
  takeProfit: number;
}

/** Enters on Adaptive SuperTrend flips (closed candles only) and trails stops by volatility regime. */
export class AdaptiveSuperTrendAgent extends BaseAgent {
  readonly id = 'ADAPTIVE-ST-ζ' as const;
  readonly strategy = 'ml_adaptive_supertrend';
  // One signal per closed candle is enforced below, so the shared fill cooldown would only swallow the next flip
  override readonly cooldownMs = 0;
  private latest = new Map<string, AdaptiveSuperTrendBar>();
  private lastHandledOpenTime = new Map<string, number>();

  protected async analyze(ctx: MarketContext): Promise<Signal[]> {
    const signals: Signal[] = [];
    // The anchor must be analysed first so its state is current when the alts are checked
    const anchorFirst = [...config.symbols].sort((a, b) => Number(b === ANCHOR_SYMBOL) - Number(a === ANCHOR_SYMBOL));
    for (const symbol of anchorFirst) {
      const signal = this.analyzeSymbol(symbol, ctx);
      if (signal) signals.push(signal);
    }
    return signals;
  }

  /** Latest closed-candle indicator state for a symbol, if enough history has loaded. */
  stateFor(symbol: string): AdaptiveSuperTrendBar | undefined {
    return this.latest.get(symbol);
  }

  private analyzeSymbol(symbol: string, ctx: MarketContext): Signal | null {
    // The last candle is still forming; using it would repaint flips
    const closed = (ctx.candles[symbol] ?? []).slice(0, -1);
    const lastClosed = closed.at(-1);
    if (!lastClosed || this.lastHandledOpenTime.get(symbol) === lastClosed.openTime) return null;

    const bar = calculateAdaptiveSuperTrend(closed).at(-1);
    const mark = ctx.marks[symbol];
    if (!bar || !mark) return null;
    this.latest.set(symbol, bar);
    this.lastHandledOpenTime.set(symbol, lastClosed.openTime);
    // LOW-volatility flips are mostly chop
    if (!bar.trendShift || bar.regime === 'LOW') return null;
    if (!this.agreesWithAnchor(symbol, bar.trendShift)) return null;
    return this.entrySignal(symbol, bar, mark);
  }

  private agreesWithAnchor(symbol: string, direction: TrendDirection): boolean {
    if (symbol === ANCHOR_SYMBOL || !config.symbols.includes(ANCHOR_SYMBOL)) return true;
    // Unknown anchor state also blocks: no BTC read means no alt entry
    return this.latest.get(ANCHOR_SYMBOL)?.direction === direction;
  }

  private entrySignal(symbol: string, bar: AdaptiveSuperTrendBar, mark: number): Signal | null {
    const isLong = bar.trendShift === 'BULLISH';
    const stopIsOnRiskSide = isLong ? bar.superTrend < mark : bar.superTrend > mark;
    // Price already crossed the line since the candle closed: the setup is stale
    if (!stopIsOnRiskSide) return null;

    const targetDistance = TP_ATR_MULTIPLE[bar.regime] * bar.assignedAtr;
    return this.signal({
      symbol,
      type: isLong ? 'OPEN_LONG' : 'OPEN_SHORT',
      confidence: ENTRY_CONFIDENCE,
      entry: mark,
      stopLoss: bar.superTrend,
      takeProfit: isLong ? mark + targetDistance : mark - targetDistance,
      reason: `ST flip ${bar.trendShift} in ${bar.regime} volatility (ATR ${bar.assignedAtr.toFixed(4)})`,
    });
  }

  /** New SL/TP for this agent's open positions, rounded to the symbol tick; unchanged positions are omitted. */
  stopUpdates(positions: Position[]): StopUpdate[] {
    const updates: StopUpdate[] = [];
    for (const position of positions) {
      const state = position.strategy === this.id ? this.latest.get(position.symbol) : undefined;
      const next = state && nextStops(position, state);
      if (!next) continue;
      const stopLoss = roundPrice(position.symbol, next.stopLoss);
      const takeProfit = roundPrice(position.symbol, next.takeProfit);
      if (stopLoss === Number(position.serverSl) && takeProfit === Number(position.serverTp)) continue;
      updates.push({ symbol: position.symbol, strategy: position.strategy, stopLoss, takeProfit });
    }
    return updates;
  }

  /** Context handed to the LLM veto; null for signals from other agents. */
  vetoSnapshot(signal: Signal, ctx: MarketContext): VetoSnapshot | null {
    const bar = this.latest.get(signal.symbol);
    if (signal.agent !== this.id || !bar || !signal.entry || !signal.stopLoss || !signal.takeProfit) return null;
    const closes = (ctx.candles[signal.symbol] ?? []).map((c) => c.close);
    return {
      symbol: signal.symbol,
      side: signal.type === 'OPEN_LONG' ? 'LONG' : 'SHORT',
      regime: bar.regime,
      distanceFromLineAtr: Math.abs(signal.entry - bar.superTrend) / bar.assignedAtr,
      rsi: rsi(closes, RSI_PERIOD).at(-1) ?? 50,
      fundingRate: ctx.funding[signal.symbol] ?? 0,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
    };
  }
}
```

- [ ] **Run it and confirm it passes**

Run: `npx tsx --test tests/adaptiveSuperTrendAgent.test.ts` then `npx tsc --noEmit`
Expected: all tests pass, tsc prints nothing

- [ ] **Checkpoint**

Run `git status --short` and `git diff --stat`. **Do not commit** — ask the user first (their rule: commit only on explicit approval, no `Co-Authored-By` line).

---

### Task 7: Executor rounding and client wiring

**Files:**
- Modify: `src/agents/ExecutorAgent.ts`, `src/binance/client.ts`
- Test: `tests/executorAgent.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4.
- Produces: executor rounds quantity down to the lot step and SL/TP/entry to the tick, and throws below one lot; `BinanceService.loadSymbolRules(symbols)`, `BinanceService.updateStops(symbol, strategy, sl, tp)` (paper only, throws in live); live orders use `roundQty`/`roundPrice`.

- [ ] **Step 1: Write the failing test** — `tests/executorAgent.test.ts`

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import { setSymbolRules } from '../src/binance/symbolRules.js';
import { ExecutorAgent } from '../src/agents/ExecutorAgent.js';
import { config } from '../src/config.js';
import type { RiskDecision, Signal } from '../src/types.js';

const symbol = config.symbols[0];
const risk: RiskDecision = { approved: true, positionSizeUsdt: 1000, leverage: 5, marginType: 'ISOLATED', liqBufferAtr: 3, reason: '' };

function signal(overrides: Partial<Signal>): Signal {
  return { id: 's', agent: 'ADAPTIVE-ST-ζ', symbol, type: 'OPEN_LONG', confidence: 0.75, reason: '', ts: 0, ...overrides };
}

function stubService() {
  const captured: Record<string, unknown>[] = [];
  const service = {
    openFuturesPosition: async (params: Record<string, unknown>) => { captured.push(params); return { orderId: 1, status: 'FILLED' }; },
    getPremiumIndex: async () => ({ markPrice: 250, fundingRate: 0 }),
  } as unknown as BinanceService;
  return { captured, executor: new ExecutorAgent(service) };
}

test('should round quantity down to the step and prices to the tick', async () => {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 1, tickSize: 0.05, stepSize: 0.1 });
  const { captured, executor } = stubService();
  const log = await executor.execute(signal({ entry: 100.03, stopLoss: 94.02, takeProfit: 112.49 }), risk);
  assert.equal(log.level, 'success');
  assert.deepEqual(
    { qty: captured[0].qty, entryPrice: captured[0].entryPrice, stopLoss: captured[0].stopLoss, takeProfit: captured[0].takeProfit, strategy: captured[0].strategy },
    { qty: 9.9, entryPrice: 100.05, stopLoss: 94, takeProfit: 112.5, strategy: 'ADAPTIVE-ST-ζ' },
  );
});

test('should size a funding hedge off the live mark and short it', async () => {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001 });
  const { captured, executor } = stubService();
  await executor.execute(signal({ type: 'OPEN_HEDGE', agent: 'FUNDING-ARB-α' }), risk);
  assert.equal(captured[0].side, 'SELL');
  assert.equal(captured[0].qty, 4);
});

test('should refuse symbols outside config.symbols', async () => {
  const { captured, executor } = stubService();
  const log = await executor.execute(signal({ symbol: 'BTCUSDTETHUSDT', entry: 30 }), risk);
  assert.equal(log.level, 'error');
  assert.equal(captured.length, 0);
});

test('should refuse an order smaller than one lot', async () => {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 0, tickSize: 0.01, stepSize: 1 });
  const { captured, executor } = stubService();
  const log = await executor.execute(signal({ entry: 5000 }), risk);
  assert.equal(log.level, 'error');
  assert.equal(captured.length, 0);
});
```

- [ ] **Run it and confirm it fails**

Run: `npx tsx --test tests/executorAgent.test.ts`
Expected: FAIL (module or export not found)

- [ ] **Step 3: Apply the executor changes**

```diff
--- a/src/agents/ExecutorAgent.ts
+++ b/src/agents/ExecutorAgent.ts
@@ -2,6 +2,7 @@
 import type { Signal, RiskDecision, LogEntry } from '../types.js';
 import type { BinanceService } from '../binance/client.js';
 import { config } from '../config.js';
+import { formatQty, roundPrice, roundQty } from '../binance/symbolRules.js';
 
 export class ExecutorAgent extends BaseAgent {
   readonly id = 'EXECUTOR-ε' as const;
@@ -22,7 +23,11 @@
       }
       // OPEN_HEDGE carries only a USDT notional, so size it off the live mark
       const entryPrice = signal.entry ?? (await this.binance.getPremiumIndex(signal.symbol)).markPrice;
-      const qty = risk.positionSizeUsdt / entryPrice;
+      const qty = roundQty(signal.symbol, risk.positionSizeUsdt / entryPrice);
+      if (qty <= 0) {
+        throw new Error(`${risk.positionSizeUsdt.toFixed(2)} USDT is below one lot of ${signal.symbol} at ${entryPrice}`);
+      }
+      const round = (price?: number) => (price === undefined ? undefined : roundPrice(signal.symbol, price));
       // Funding harvest earns by shorting the perp when funding is positive
       const isShort = signal.type === 'OPEN_SHORT' || signal.type === 'OPEN_HEDGE';
       const side = isShort ? 'SELL' : 'BUY';
@@ -33,15 +38,15 @@
         qty,
         leverage: risk.leverage,
         strategy: signal.agent,
-        stopLoss: signal.stopLoss,
-        takeProfit: signal.takeProfit,
-        entryPrice: signal.entry,
+        stopLoss: round(signal.stopLoss),
+        takeProfit: round(signal.takeProfit),
+        entryPrice: round(signal.entry),
       });
 
       return {
         ts: Date.now(),
         agent: this.id,
-        msg: `FILLED ${side} ${signal.symbol} qty=${qty.toFixed(4)} orderId=${res.orderId} SL=${signal.stopLoss ?? '—'} server-side ✓`,
+        msg: `FILLED ${side} ${signal.symbol} qty=${formatQty(signal.symbol, qty)} orderId=${res.orderId} SL=${signal.stopLoss ?? '—'} server-side ✓`,
         level: 'success',
       };
     } catch (err: any) {
```

- [ ] **Step 4: Apply the client changes**

```diff
--- a/src/binance/client.ts
+++ b/src/binance/client.ts
@@ -1,6 +1,7 @@
 import { USDMClient, WebsocketClient } from 'binance';
 import { config } from '../config.js';
 import { PaperEngine } from './paperEngine.js';
+import { roundPrice, roundQty, rulesFromExchangeInfo, setSymbolRules } from './symbolRules.js';
 import type { AgentId, Candle, Position } from '../types.js';
 
 // 300 closed 15m candles cover the adaptive SuperTrend's ATR warm-up (10) + K-Means window (100) with margin
@@ -38,6 +39,14 @@
     };
   }
 
+  /** Loads per-symbol price/quantity precision so orders and the UI use each contract's own decimals. */
+  async loadSymbolRules(symbols: string[]): Promise<void> {
+    const info = await this.futures.getExchangeInfo();
+    for (const entry of info.symbols) {
+      if (symbols.includes(entry.symbol)) setSymbolRules(entry.symbol, rulesFromExchangeInfo(entry));
+    }
+  }
+
   async getKlines(symbol: string, interval = '15m', limit = 200): Promise<Candle[]> {
     const rawKlines = await this.futures.getKlines({
       symbol,
@@ -140,7 +149,7 @@
       symbol: params.symbol,
       side: params.side,
       type: 'MARKET',
-      quantity: Number(params.qty.toFixed(6)),
+      quantity: roundQty(params.symbol, params.qty),
       reduceOnly: params.reduceOnly ? 'true' : 'false',
     });
 
@@ -166,6 +175,12 @@
     await this.cancelAll(pos.symbol);
   }
 
+  /** Paper only: live mode keeps exchange-side protection orders (netting per symbol is unresolved). */
+  updateStops(symbol: string, strategy: AgentId, stopLoss: number, takeProfit: number): void {
+    if (config.mode !== 'paper') throw new Error('Dynamic stop updates are paper-only');
+    this.paper.updateStops(symbol, strategy, stopLoss, takeProfit);
+  }
+
   /** Paper only: marks to market and returns log lines for SL/TP/liquidation exits. */
   markAll(prices: Record<string, number>): string[] {
     return config.mode === 'paper' ? this.paper.markAll(prices) : [];
@@ -183,7 +198,7 @@
         symbol: params.symbol,
         side: exitSide,
         type: 'STOP_MARKET',
-        stopPrice: Number(params.stopLoss.toFixed(2)),
+        stopPrice: roundPrice(params.symbol, params.stopLoss),
         closePosition: 'true',
       });
     }
@@ -192,7 +207,7 @@
         symbol: params.symbol,
         side: exitSide,
         type: 'TAKE_PROFIT_MARKET',
-        stopPrice: Number(params.takeProfit.toFixed(2)),
+        stopPrice: roundPrice(params.symbol, params.takeProfit),
         closePosition: 'true',
       });
     }
```

- [ ] **Run it and confirm it passes**

Run: `npx tsx --test tests/executorAgent.test.ts` then `npx tsc --noEmit`
Expected: all tests pass, tsc prints nothing

- [ ] **Checkpoint**

Run `git status --short` and `git diff --stat`. **Do not commit** — ask the user first (their rule: commit only on explicit approval, no `Co-Authored-By` line).

---

### Task 8: LLM veto

**Files:**
- Modify: `src/ollama/advisor.ts`
- Test: `tests/advisor.test.ts`

**Interfaces:**
- Consumes: `VetoSnapshot` (Task 1).
- Produces: `OllamaAdvisor.veto(snapshot): Promise<VetoVerdict>` (5s timeout; offline, error, or malformed reply → `PROCEED`), `parseVerdict(text)`, `VetoVerdict`.

- [ ] **Step 1: Write the failing test** — `tests/advisor.test.ts`

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVerdict } from '../src/ollama/advisor.js';

test('should return VETO with the model reason', () => {
  assert.deepEqual(parseVerdict('{"verdict":"VETO","reason":"extended entry"}'), { verdict: 'VETO', reason: 'extended entry' });
});

test('should proceed on an explicit PROCEED', () => {
  assert.equal(parseVerdict('{"verdict":"PROCEED","reason":"clean"}').verdict, 'PROCEED');
});

test('should proceed when the reply is not JSON or has an unknown verdict', () => {
  assert.equal(parseVerdict('sure, go ahead').verdict, 'PROCEED');
  assert.equal(parseVerdict('{"verdict":"MAYBE"}').verdict, 'PROCEED');
});
```

- [ ] **Run it and confirm it fails**

Run: `npx tsx --test tests/advisor.test.ts`
Expected: FAIL (module or export not found)

- [ ] **Step 3: Apply the advisor changes**

```diff
--- a/src/ollama/advisor.ts
+++ b/src/ollama/advisor.ts
@@ -1,11 +1,36 @@
 import { Ollama } from 'ollama';
 import { config } from '../config.js';
-import type { Position, LogEntry } from '../types.js';
+import type { Position, LogEntry, VetoSnapshot } from '../types.js';
+
+export interface VetoVerdict {
+  verdict: 'PROCEED' | 'VETO';
+  reason: string;
+}
+
+const VETO_TIMEOUT_MS = 5000;
+
+/** Parses the model's JSON reply; anything unusable proceeds, because deterministic code owns the entry. */
+export function parseVerdict(text: string): VetoVerdict {
+  try {
+    const parsed = JSON.parse(text);
+    const reason = String(parsed.reason ?? '');
+    return parsed.verdict === 'VETO' ? { verdict: 'VETO', reason } : { verdict: 'PROCEED', reason };
+  } catch {
+    return { verdict: 'PROCEED', reason: 'unparseable model reply' };
+  }
+}
+
+function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
+  return new Promise((resolve, reject) => {
+    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
+    promise.then(resolve, reject).finally(() => clearTimeout(timer));
+  });
+}
 
 /**
- * LLM advisory layer via Ollama.
- * Non-blocking: enriches logs with narrative context.
- * NEVER makes trading decisions — deterministic agents own execution.
+ * LLM layer via Ollama.
+ * advise/ask enrich logs only. veto() may block an entry the deterministic agents proposed,
+ * but can never originate one; when Ollama is offline, slow or malformed, the entry proceeds.
  */
 export class OllamaAdvisor {
   private client: Ollama;
@@ -29,6 +54,22 @@
     }
   }
 
+  async veto(snapshot: VetoSnapshot): Promise<VetoVerdict> {
+    if (!this.available) return { verdict: 'PROCEED', reason: 'advisor offline' };
+    const prompt = `You review a proposed crypto futures entry. Snapshot: ${JSON.stringify(snapshot)}. ` +
+      'Reply with JSON only: {"verdict":"PROCEED"|"VETO","reason":"<max 15 words>"}. ' +
+      'VETO only for a concrete reason such as an overextended entry or crowded funding.';
+    try {
+      const res = await withTimeout(
+        this.client.generate({ model: config.ollama.model, prompt, format: 'json', stream: false }),
+        VETO_TIMEOUT_MS,
+      );
+      return parseVerdict(res.response);
+    } catch (err) {
+      return { verdict: 'PROCEED', reason: `advisor error: ${(err as Error).message}` };
+    }
+  }
+
   async advise(positions: Position[], signals: string[]): Promise<LogEntry | null> {
     if (!this.available) return null;
     try {
```

- [ ] **Run it and confirm it passes**

Run: `npx tsx --test tests/advisor.test.ts` then `npx tsc --noEmit`
Expected: all tests pass, tsc prints nothing

- [ ] **Checkpoint**

Run `git status --short` and `git diff --stat`. **Do not commit** — ask the user first (their rule: commit only on explicit approval, no `Co-Authored-By` line).

---

### Task 9: Orchestrator wiring, store row, UI precision

**Files:**
- Modify: `src/runtime/Orchestrator.ts`, `src/binance/indicators.ts`, `src/store.ts`, `src/ui/panels.tsx`

**Interfaces:**
- Consumes: everything above.
- Produces: the adaptive agent registered (paper only), per-agent cooldown, veto after the risk gate, trail pass every loop, symbol precision loaded before the first loop (falls back to 2dp with a warn log), `pairZScore` moved into `indicators.ts` to keep `Orchestrator.ts` under 300 lines.

- [ ] **Step 1: Apply the indicator helper (moved out of the orchestrator)**

```diff
--- a/src/binance/indicators.ts
+++ b/src/binance/indicators.ts
@@ -37,6 +37,15 @@
   return standardDeviation === 0 ? 0 : (values[values.length - 1] - mean) / standardDeviation;
 }
 
+/** Z-score of the latest A/B close ratio over the trailing `period` candles; 0 until enough history. */
+export function pairZScore(candlesA: Candle[], candlesB: Candle[], period = 30): number {
+  const length = Math.min(candlesA.length, candlesB.length);
+  if (length < period) return 0;
+  const ratios: number[] = [];
+  for (let i = length - period; i < length; i++) ratios.push(candlesA[i].close / candlesB[i].close);
+  return zscore(ratios, period);
+}
+
 export function sparkline(values: number[], len = 12): string {
   if (!values.length) return '';
   const slice = values.slice(-len);
```

- [ ] **Step 2: Apply the orchestrator changes**

```diff
--- a/src/runtime/Orchestrator.ts
+++ b/src/runtime/Orchestrator.ts
@@ -1,24 +1,26 @@
 import { EventEmitter } from 'node:events';
 import type { Signal, LogEntry, AppState, Position, StrategyMetrics, MarketPriceInfo, Candle } from '../types.js';
-import type { MarketContext } from '../agents/BaseAgent.js';
+import { DEFAULT_COOLDOWN_MS, type BaseAgent, type MarketContext } from '../agents/BaseAgent.js';
 import { BinanceService } from '../binance/client.js';
 import { FundingArbAgent } from '../agents/FundingArbAgent.js';
 import { MomentumAgent } from '../agents/MomentumAgent.js';
+import { AdaptiveSuperTrendAgent } from '../agents/AdaptiveSuperTrendAgent.js';
 import { RiskAgent } from '../agents/RiskAgent.js';
 import { ExecutorAgent } from '../agents/ExecutorAgent.js';
 import { OllamaAdvisor } from '../ollama/advisor.js';
-import { atr, zscore, sparkline } from '../binance/indicators.js';
+import { atr, pairZScore, sparkline } from '../binance/indicators.js';
+import { formatPrice } from '../binance/symbolRules.js';
 import { config } from '../config.js';
 
-// Momentum re-fires every 8s tick while the forming 15m candle stays across EMA50
-const SIGNAL_COOLDOWN_MS = 15 * 60_000;
-
 export class Orchestrator extends EventEmitter {
   private binance = new BinanceService();
-  private agents = [
+  private adaptive = new AdaptiveSuperTrendAgent(this.binance);
+  private agents: BaseAgent[] = [
     new FundingArbAgent(this.binance),
     // PairsAgent disabled: it signals a BTC/ETH ratio, which is not an exchange symbol; re-enable once it emits two legs
     new MomentumAgent(this.binance),
+    // Live one-way mode nets opposite same-symbol positions, so per-strategy dynamic stops are paper-only for now
+    ...(config.mode === 'paper' ? [this.adaptive] : []),
   ];
   private risk = new RiskAgent(this.binance);
   private executor = new ExecutorAgent(this.binance);
@@ -32,7 +34,10 @@
 
   start() {
     this.log('SYSTEM', `Orchestrator started in ${config.mode.toUpperCase()} mode`, 'info');
-    this.loop();
+    if (config.mode === 'live') this.log('SYSTEM', `${this.adaptive.id} disabled: dynamic exits are paper-only`, 'warn');
+    this.binance.loadSymbolRules(config.symbols)
+      .catch((err: Error) => this.log('SYSTEM', `Symbol precision load failed (${err.message}); using 2dp defaults`, 'warn'))
+      .finally(() => this.loop());
     this.timer = setInterval(() => this.loop(), 8000);
     this.stopWs = this.binance.startRealtimeStream(config.symbols, (sym, price) => {
       this.handleRealtimeTick(sym, price);
@@ -115,6 +120,7 @@
 
       const signals = await this.collectSignals(ctx);
       await this.processSignals(signals, ctx);
+      this.trailStops(ctx.positions ?? []);
       await this.consultAdvisor(signals, ctx.positions ?? []);
       await this.emitState(ctx);
     } catch (err: any) {
@@ -138,17 +144,40 @@
 
   private async processSignals(signals: Signal[], ctx: MarketContext): Promise<void> {
     for (const signal of signals) {
-      const cooldownKey = `${signal.symbol}:${signal.agent}`;
-      if (Date.now() - (this.lastFilledAt.get(cooldownKey) ?? 0) < SIGNAL_COOLDOWN_MS) continue;
+      if (this.isCoolingDown(signal)) continue;
 
       const decision = this.risk.gate(signal, ctx);
-      if (decision.approved) {
-        const log = await this.executor.execute(signal, decision);
-        this.log(log.agent, log.msg, log.level);
-        if (log.level === 'success') this.lastFilledAt.set(cooldownKey, Date.now());
-      } else {
+      if (!decision.approved) {
         this.log('RISK-MGR-δ', `REJECTED ${signal.symbol}: ${decision.reason}`, 'warn');
+        continue;
       }
+      if (await this.isVetoed(signal, ctx)) continue;
+
+      const log = await this.executor.execute(signal, decision);
+      this.log(log.agent, log.msg, log.level);
+      if (log.level === 'success') this.lastFilledAt.set(`${signal.symbol}:${signal.agent}`, Date.now());
+    }
+  }
+
+  private isCoolingDown(signal: Signal): boolean {
+    const cooldownMs = this.agents.find((a) => a.id === signal.agent)?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
+    const lastFill = this.lastFilledAt.get(`${signal.symbol}:${signal.agent}`) ?? 0;
+    return Date.now() - lastFill < cooldownMs;
+  }
+
+  private async isVetoed(signal: Signal, ctx: MarketContext): Promise<boolean> {
+    const snapshot = this.adaptive.vetoSnapshot(signal, ctx);
+    if (!snapshot) return false;
+    const { verdict, reason } = await this.advisor.veto(snapshot);
+    if (verdict === 'VETO') this.log(signal.agent, `VETOED ${signal.type} ${signal.symbol}: ${reason}`, 'warn');
+    return verdict === 'VETO';
+  }
+
+  private trailStops(positions: Position[]): void {
+    for (const update of this.adaptive.stopUpdates(positions)) {
+      this.binance.updateStops(update.symbol, update.strategy, update.stopLoss, update.takeProfit);
+      const { symbol, stopLoss, takeProfit } = update;
+      this.log(update.strategy, `TRAIL ${symbol} SL ${formatPrice(symbol, stopLoss)} TP ${formatPrice(symbol, takeProfit)}`, 'info');
     }
   }
 
@@ -214,23 +243,13 @@
       fundingSolRate: solFund,
       fundingSolApr: solFund * 3 * 365 * 100,
       nextFundingCountdown: `${hours}h${mins}m`,
-      zscoreBtcEth: this.calcPairZScore(btcCandles, ethCandles),
-      zscoreSolAvax: this.calcPairZScore(solCandles, avaxCandles),
+      zscoreBtcEth: pairZScore(btcCandles, ethCandles),
+      zscoreSolAvax: pairZScore(solCandles, avaxCandles),
       btcAtr: btcCandles.length ? atr(btcCandles, 14) : 0,
       avaxAtr: avaxCandles.length ? atr(avaxCandles, 14) : 0,
     };
   }
 
-  private calcPairZScore(cA: Candle[], cB: Candle[]): number {
-    const len = Math.min(cA.length, cB.length);
-    if (len < 30) return 0;
-    const ratios: number[] = [];
-    for (let i = len - 30; i < len; i++) {
-      ratios.push(cA[i].close / cB[i].close);
-    }
-    return zscore(ratios, 30);
-  }
-
   private async emitState(ctx: MarketContext & {
     tickers: Record<string, { price: number; changePct: number; high24h?: number; low24h?: number; volumeQuote?: number }>;
     strategyMetrics: StrategyMetrics;
```

- [ ] **Step 3: Apply the store and UI changes**

```diff
--- a/src/store.ts
+++ b/src/store.ts
@@ -124,6 +124,7 @@
     { id: 'PAIRS-TRD-β', status: 'PAUSED', strategy: 'stat_pairs_zscore', positions: 2, winRate: 71.4, pnl: 12840, progress: 68 },
     { id: 'MOMENTUM-γ', status: 'RUNNING', strategy: 'atr_vol_momentum', positions: 2, winRate: 64.8, pnl: 6210, progress: 54 },
     { id: 'RISK-MGR-δ', status: 'WATCHING', strategy: 'liq_guard_isolated', positions: 0, winRate: 100, pnl: 0, progress: 42 },
+    { id: 'ADAPTIVE-ST-ζ', status: config.mode === 'paper' ? 'RUNNING' : 'PAUSED', strategy: 'ml_adaptive_supertrend', positions: 0, winRate: 0, pnl: 0, progress: 0 },
     { id: 'EXECUTOR-ε', status: 'RUNNING', strategy: 'binance_router', positions: 0, winRate: 100, pnl: 0, progress: 95 },
   ],
   logs: [
--- a/src/ui/panels.tsx
+++ b/src/ui/panels.tsx
@@ -4,6 +4,10 @@
 import cliTruncate from 'cli-truncate';
 import stringWidth from 'string-width';
 import type { AgentState, Position, LogEntry, MarketPriceInfo, StrategyMetrics } from '../types.js';
+import { formatPrice, formatQty } from '../binance/symbolRules.js';
+
+// Prices and quantities use each symbol's own precision; every other figure is 2dp
+const usd = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
 
 export interface CockpitProps {
   mode: string; time: string; equity: number; upnl: number; marginUsed: number;
@@ -47,20 +51,20 @@
 }
 
 export function renderCol1Lines(p: CockpitProps, width = 40, rowCount = 29): string[] {
-  const marginPct = ((p.marginUsed / (p.equity || 1)) * 100).toFixed(1);
+  const marginPct = ((p.marginUsed / (p.equity || 1)) * 100).toFixed(2);
   const rows: string[] = [
-    padLine(' ' + chalk.gray('Equity  ') + chalk.white.bold(`$${p.equity.toLocaleString('en-US', { minimumFractionDigits: 2 })}`) + chalk.gray(' (paper)'), width),
+    padLine(' ' + chalk.gray('Equity  ') + chalk.white.bold(`$${usd(p.equity)}`) + chalk.gray(' (paper)'), width),
     padLine(' ' + chalk.green('+$27,766 (+27.77% total)'), width),
     padLine(' ' + chalk.gray('uPnL    ') + chalk.green.bold(`+$${p.upnl.toFixed(2)}`), width),
-    padLine(' ' + chalk.gray('Margin  ') + chalk.white(`$${p.marginUsed.toLocaleString()}`) + chalk.gray(` (${marginPct}% used)`), width),
-    padLine(' ' + chalk.gray('Free    ') + chalk.white(`$${Math.max(0, p.equity - p.marginUsed).toLocaleString()}`), width),
+    padLine(' ' + chalk.gray('Margin  ') + chalk.white(`$${usd(p.marginUsed)}`) + chalk.gray(` (${marginPct}% used)`), width),
+    padLine(' ' + chalk.gray('Free    ') + chalk.white(`$${usd(Math.max(0, p.equity - p.marginUsed))}`), width),
     padLine(' ' + chalk.gray('Lev cap 3x │ Mode ') + chalk.yellow('ISOLATED'), width),
   ];
   const isCompact = (rowCount - rows.length) < 20;
   for (const a of p.agents.slice(0, 5)) {
     const icon = a.status === 'RUNNING' ? chalk.green('●') : chalk.yellow('◐');
     const bar = Math.max(0, Math.min(12, Math.floor(a.progress / 8.3)));
-    rows.push(padLine(`  ${icon} ${chalk.cyan.bold(a.id)} ${chalk.green(a.status)}${isCompact ? ` ${chalk.green(`+$${(a.pnl / 1000).toFixed(1)}k`)}` : ''}`, width));
+    rows.push(padLine(`  ${icon} ${chalk.cyan.bold(a.id)} ${chalk.green(a.status)}${isCompact ? ` ${chalk.green(`+$${(a.pnl / 1000).toFixed(2)}k`)}` : ''}`, width));
     if (!isCompact) {
       rows.push(padLine(`   ${chalk.gray(a.strategy)}`, width));
       rows.push(padLine(`   ${chalk.gray(`pos ${a.positions} win ${a.winRate}% pnl `)}${chalk.green(`+$${(a.pnl / 1000).toFixed(2)}k`)}`, width));
@@ -74,31 +78,31 @@
 function fmtVol(v?: number): string {
   if (!v) return '$0';
   if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
-  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
-  return '$' + (v / 1e3).toFixed(0) + 'K';
+  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
+  return '$' + (v / 1e3).toFixed(2) + 'K';
 }
 
-function fmtRange(low?: number, high?: number): string {
+function fmtRange(symbol: string, low?: number, high?: number): string {
   if (!low || !high) return '—';
-  const f = (n: number) => n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'k' : '$' + n.toFixed(2);
-  return `${f(low)} - ${f(high)}`;
+  return `$${formatPrice(symbol, low)} - $${formatPrice(symbol, high)}`;
 }
 
 function renderAssetRow(sym: string, info: MarketPriceInfo | undefined, width: number, isWide: boolean): string[] {
   const p = info?.price ?? (sym === 'BTC' ? 81070 : sym === 'ETH' ? 2626 : sym === 'SOL' ? 111.6 : 8.54);
   const chg = info?.changePct ?? 0;
-  const pStr = (p >= 1000 ? `$${p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${p.toFixed(2)}`).padStart(11);
+  const pair = `${sym}USDT`;
+  const pStr = `$${formatPrice(pair, p)}`.padStart(11);
   const chgCol = chg >= 0 ? chalk.green : chalk.red;
   const chgStr = chgCol(((chg >= 0 ? '+' : '') + chg.toFixed(2) + '%').padStart(8));
   const spark = info?.sparkline ? chgCol(info.sparkline) : '';
 
   if (isWide) {
-    const range = fmtRange(info?.low24h, info?.high24h).padEnd(19);
+    const range = fmtRange(pair, info?.low24h, info?.high24h).padEnd(23);
     const vol = fmtVol(info?.volumeQuote).padStart(10);
     const l = ` ${chalk.yellow.bold(sym.padEnd(5))} ${chalk.white(pStr)}  ${chgStr}  ${chalk.gray('│ ')}${chalk.white(range)} ${chalk.gray('│ ')}${chalk.cyan(vol)}  ${chalk.gray('│ ')}${spark}`;
     return [padLine(l, width)];
   }
-  const range = (info?.low24h && info?.high24h ? (info.low24h >= 1000 ? `$${(info.low24h / 1000).toFixed(1)}k-$${(info.high24h / 1000).toFixed(1)}k` : `$${info.low24h.toFixed(2)}-$${info.high24h.toFixed(2)}`) : '—').padEnd(15);
+  const range = fmtRange(pair, info?.low24h, info?.high24h).padEnd(15);
   const vol = ('Vol ' + fmtVol(info?.volumeQuote)).padStart(11);
   const l1 = ` ${chalk.yellow.bold(sym.padEnd(4))} ${chalk.white(pStr.trim().padStart(9))} ${chgStr} ${chalk.gray('│ ')}${spark}`;
   const l2 = `   ${chalk.gray('24h')} ${chalk.white(range)} ${chalk.gray('│ ')}${chalk.cyan(vol)}`;
@@ -115,14 +119,14 @@
   const cd = metrics?.nextFundingCountdown ?? '7h58m';
   const totalVol = (spotPrices?.BTC?.volumeQuote ?? 15.8e9) + (spotPrices?.ETH?.volumeQuote ?? 4.2e9) + (spotPrices?.SOL?.volumeQuote ?? 1.8e9) + (spotPrices?.AVAX?.volumeQuote ?? 240e6);
   const syms = ['BTC', 'ETH', 'SOL', 'AVAX'] as const;
-  const isWide = width >= 72;
+  const isWide = width >= 76;
 
   const rows: string[] = [
     padLine(` ${chalk.gray('USDM Funding 8h: ')}${chalk.green(`+${fund}%`)}${chalk.gray(' │ settle in ')}${chalk.cyan.bold(cd)}`, width),
     padLine(` ${chalk.gray('─'.repeat(Math.max(10, width - 2)))}`, width),
   ];
   if (isWide) {
-    rows.push(padLine(` ${chalk.gray('ASSET'.padEnd(5))} ${chalk.gray('PRICE'.padStart(11))}  ${chalk.gray('24h CHG'.padStart(8))}  ${chalk.gray('│ 24h RANGE'.padEnd(21))} ${chalk.gray('│ 24h VOLUME'.padStart(12))}  ${chalk.gray('│ 15m TREND')}`, width));
+    rows.push(padLine(` ${chalk.gray('ASSET'.padEnd(5))} ${chalk.gray('PRICE'.padStart(11))}  ${chalk.gray('24h CHG'.padStart(8))}  ${chalk.gray('│ 24h RANGE'.padEnd(25))} ${chalk.gray('│ 24h VOLUME'.padStart(12))}  ${chalk.gray('│ 15m TREND')}`, width));
     rows.push(padLine(` ${chalk.gray('─'.repeat(Math.max(10, width - 2)))}`, width));
   }
   rows.push(...syms.flatMap((s) => renderAssetRow(s, spotPrices?.[s], width, isWide)));
@@ -147,9 +151,9 @@
     const type = chalk.gray((pos.posType ?? pos.side).padEnd(11));
     const sign = pos.upnl >= 0 ? '+' : '';
     const pnlCol = pos.upnl >= 0 ? chalk.green : chalk.red;
-    const pnlStr = pnlCol(`${sign}$${pos.upnl.toFixed(0)}`);
+    const pnlStr = pnlCol(`${sign}$${pos.upnl.toFixed(2)}`);
     const line = isWide
-      ? ` ${cur} ${sym} ${type} ${chalk.gray('e ')}${chalk.white(pos.entry.toFixed(1).padEnd(7))} ${chalk.gray('sz ')}${chalk.white(pos.qty.toFixed(1))} ${pnlStr}`
+      ? ` ${cur} ${sym} ${type} ${chalk.gray('e ')}${chalk.white(formatPrice(pos.symbol, pos.entry).padEnd(7))} ${chalk.gray('sz ')}${chalk.white(formatQty(pos.symbol, pos.qty))} ${pnlStr}`
       : ` ${cur} ${sym} ${type} ${pnlStr}`;
     rows.push(padLine(line, width));
   }
@@ -166,12 +170,12 @@
 }
 
 export function renderCol4Lines(p: CockpitProps, width = 30, rowCount = 29): string[] {
-  const marginPct = ((p.marginUsed / (p.equity || 1)) * 100).toFixed(1);
+  const marginPct = ((p.marginUsed / (p.equity || 1)) * 100).toFixed(2);
   const rows: string[] = [
     padLine(` ${chalk.cyan.bold('ACCOUNT & MARGIN')}`, width),
     padLine(`   ${chalk.gray('Unrealized ')}${chalk.green.bold(`+$${p.upnl.toFixed(2)}`)}`, width),
-    padLine(`   ${chalk.gray('Margin     ')}${chalk.white(`$${p.marginUsed.toLocaleString()}`)}${chalk.gray(` (${marginPct}%)`)}`, width),
-    padLine(`   ${chalk.gray('Free       ')}${chalk.white(`$${Math.max(0, p.equity - p.marginUsed).toLocaleString()}`)}`, width),
+    padLine(`   ${chalk.gray('Margin     ')}${chalk.white(`$${usd(p.marginUsed)}`)}${chalk.gray(` (${marginPct}%)`)}`, width),
+    padLine(`   ${chalk.gray('Free       ')}${chalk.white(`$${usd(Math.max(0, p.equity - p.marginUsed))}`)}`, width),
     padLine(` ${chalk.gray('─'.repeat(Math.max(10, width - 2)))}`, width),
     padLine(` ${chalk.cyan.bold('RISK-MGR-δ METRICS')}`, width),
     padLine(`   ${chalk.gray('VaR(95%)   ')}${chalk.red('-$1,842 1.8%')}`, width),
@@ -218,7 +222,7 @@
 
 export function renderDetailLines(p: Position | undefined, width: number = 128): string[] {
   const pos = p ?? { symbol: 'ETH/USDT', side: 'SHORT' as const, posType: 'PERP-SHORT', strategy: 'FUNDING-ARB-α' as const, entry: 2630.0, qty: 2.0, mark: 2626.2, upnl: 7.6, upnlPct: 0.14, leverage: 5 };
-  const l1 = ' ' + chalk.yellow.bold(`${pos.symbol} ${pos.posType ?? pos.side}`) + ' · ' + chalk.cyan(pos.strategy) + chalk.gray(' │ entry ') + chalk.white(`$${pos.entry.toLocaleString()}`) + chalk.gray(' │ size ') + chalk.white(pos.qty.toFixed(1)) + chalk.gray(' │ mark ') + chalk.white(`$${pos.mark.toLocaleString()}`) + chalk.gray(' │ uPnL ') + chalk.green(`+$${pos.upnl.toFixed(2)} (+${pos.upnlPct.toFixed(2)}%)`) + chalk.gray(' │ lev ') + chalk.yellow(`${pos.leverage}x ISOLATED`);
+  const l1 = ' ' + chalk.yellow.bold(`${pos.symbol} ${pos.posType ?? pos.side}`) + ' · ' + chalk.cyan(pos.strategy) + chalk.gray(' │ entry ') + chalk.white(`$${formatPrice(pos.symbol, pos.entry)}`) + chalk.gray(' │ size ') + chalk.white(formatQty(pos.symbol, pos.qty)) + chalk.gray(' │ mark ') + chalk.white(`$${formatPrice(pos.symbol, pos.mark)}`) + chalk.gray(' │ uPnL ') + chalk.green(`+$${pos.upnl.toFixed(2)} (+${pos.upnlPct.toFixed(2)}%)`) + chalk.gray(' │ lev ') + chalk.yellow(`${pos.leverage}x ISOLATED`);
   const l2 = ' ' + chalk.gray('liq dist ') + chalk.cyan('18.2%') + chalk.gray(' │ server SL ') + chalk.white('2750 (STOP_MARKET)') + chalk.gray(' │ server TP ') + chalk.white('fund') + chalk.gray(' │ maint margin ') + chalk.green('OK ✓') + chalk.gray(' │ liq buffer ') + chalk.green('>2x ATR ✓');
   return boxLines('POSITION DETAIL (selected)', [l1, l2], width);
 }
```

- [ ] **Step 4: Verify size and types**

Run: `wc -l src/runtime/Orchestrator.ts src/ui/panels.tsx` — expected 293 and 298 (both ≤ 300).
Run: `npx tsc --noEmit && npm test`
Expected: tsc prints nothing; `ℹ tests 43`, `ℹ pass 43`, `ℹ fail 0`.

- [ ] **Checkpoint**

Run `git status --short` and `git diff --stat`. **Do not commit** — ask the user first (their rule: commit only on explicit approval, no `Co-Authored-By` line).

---

### Task 10: Reset, rebuild, observe

**Files:** none (runtime verification)

- [ ] **Step 1: Stop the running bot and reset paper state**

`dist/` is stale and the running process rewrites the state file every tick, so stop it first:

```bash
pkill -f "node dist/index.js"
cd ~/projects/crypto-trading/crypto-trading-agent
echo '{"version":1,"savedAt":0,"equity":100000,"startEquity":100000,"positions":[]}' > data/paper-state.json
```

- [ ] **Step 2: Build and start**

Run: `npm run build && npm start` (or `npm run dev:paper`, which runs `src/` directly).
Expected: no `BTCUSDTETHUSDT` rows; log shows no "Symbol precision load failed" warning (if it appears, prices fall back to 2dp — check network and rerun).

- [ ] **Step 3: Observe a session**

- Cockpit shows `ADAPTIVE-ST-ζ` in the fleet; positions show each symbol's own decimals (e.g. BTC `81,252.90`, XRP `2.3456`).
- On a closed-candle flip outside LOW volatility: one `ST flip …` log, then either `VETOED …` (Ollama) or one `FILLED …` and one position with SL/TP set.
- Within the trade: `TRAIL <symbol> SL … TP …` lines only when a level changes; exits log `STOP LOSS` / `TAKE PROFIT` / `LIQUIDATED`.
- Flips are rare on 15m; if none appear in a session, the agent test in Task 6 is the evidence for the entry path.

- [ ] **Checkpoint**

Run `git status --short` and `git diff --stat`. **Do not commit** — ask the user first (their rule: commit only on explicit approval, no `Co-Authored-By` line).


## Out of Scope (v1)

Live-mode dynamic exits (needs one-way netting and stop-replacement design); fees and funding accrual; total-exposure cap across positions; two-leg pairs execution; streaming kline engine.

## Known Gaps Found in the Cockpit (recommend a separate plan)

The TUI still shows hardcoded mock content that is not wired to live data: fleet header "5 active" and "POSITIONS (6 open)"; the "+$27,766 (+27.77% total)" equity line; the asset list is fixed to BTC/ETH/SOL/AVAX instead of `config.symbols`; the POSITION ACTIONS list ("Close ETH/USDT SHORT", "Close SOL/USDT SHORT", "Close BTC/ETH pairs"); the position detail second line (liq dist 18.2%, SL 2750, TP fund, maint margin OK); VaR/Exposure/MaxDD/Liq buffer/Corr/Sharpe; the strategy-metrics rows (z-scores, "1.8x ✓", "+$127.40 est", AVAX ATR); the "Today 142 decisions … +$27,766 PnL" strip; footer "api weight 247/1200"; the market-regime "BULLISH (all 4 above EMA50)" and "+10.95% APR" lines; the store seeds fake positions, agents, logs and metrics that the orchestrator never overwrites (agents, perf stats); and empty log rows are padded with a fake "Close ETH/USDT SHORT → market close" line.
