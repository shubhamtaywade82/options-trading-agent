# Cockpit Real Data + Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every value in the TUI cockpit come from live or persisted data (no mock, dummy or fallback demo values) and close the seven parked review items.

**Architecture:** The paper engine keeps a persisted trade journal. A pure `performance.ts` derives win rate, drawdown, Sharpe, VaR and correlation from it. A pure `telemetry.ts` assembles the full `AppState` slice each loop so `Orchestrator.ts` stays small. `panels.tsx` is split into focused UI modules that render only that state, with `—` or "waiting for data" when a value does not exist.

**Tech Stack:** TypeScript (ESM, strict), ink, chalk, `binance` npm package, Node built-in test runner via `tsx --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-19-cockpit-real-data-and-hardening-design.md` (binding). Earlier work: `docs/superpowers/plans/2026-09-19-adaptive-supertrend.md` (already implemented, uncommitted).

## Global Constraints

- Never commit or stage; leave everything uncommitted (the user's rule: ask before committing; no `Co-Authored-By`).
- Functions ≤ 30 lines, files ≤ 300 lines, nesting ≤ 3, parameters ≤ 4. Comments explain WHY only. New files only those named in this plan.
- Symbol universe is `config.symbols` from `.env`; nothing is hard-coded to BTC/ETH/SOL/AVAX. Tests must not read the environment's symbol list except through `config.symbols`.
- Prices and quantities use per-symbol precision (`src/binance/symbolRules.ts`: `formatPrice`, `formatQty`); every other displayed figure is 2 decimals, except funding rates (4 decimals).
- Tests live in `tests/`, run with `npm test` (`tsx --test tests/*.test.ts`); tests must use temp files and never touch `data/paper-state.json` (a live bot uses it). Do not start the app.
- Baseline before this plan: `npx tsc --noEmit` clean, `npm test` = 44 pass, `Orchestrator.ts` = 297 lines, `panels.tsx` = 298 lines.
- No mock data anywhere in the cockpit path. Forbidden literals in rendered output (asserted by a guard test in Task 12): `27,766`, `142`, `96.4`, `2.84`, `1,842`, `18.7`, `0.91`, `247/1200`, `AVAX`, `ETH/USDT`, `SOL/USDT`, `BTC/ETH pairs`, `127.40`, `2750`, `7h58m`, `1.8x`, `2.1x`.

## File Structure

| File | Responsibility |
|---|---|
| `src/binance/symbolRules.ts` | + `minQty`, `minNotional` |
| `src/agents/ExecutorAgent.ts`, `src/binance/client.ts` | functions ≤ 30 lines; min-size guards; `getApiWeight`, `getWsStatus` |
| `src/agents/TrailingStopManager.ts`, `src/agents/AdaptiveSuperTrendAgent.ts` | TP-cap hysteresis; anchor freshness |
| `src/ollama/advisor.ts` | injectable client, re-ping, unknown-verdict warn |
| `src/binance/paperEngine.ts` | persisted trade journal, `initialEquity` |
| `src/binance/performance.ts` (new) | pure performance statistics |
| `src/runtime/telemetry.ts` (new) | pure `buildTelemetry` |
| `src/runtime/Orchestrator.ts` | counters, telemetry emit, promise safety |
| `src/types.ts`, `src/store.ts`, `src/config.ts` | new state shape, empty store, `LOOP_INTERVAL_MS` |
| `src/ui/format.ts`, `src/ui/accountPanels.ts`, `src/ui/marketPanels.ts` (new), `src/ui/panels.tsx` | split UI, real-data rendering |

---

### Task 1: Minimum order size rules and Executor refactor

**Files:**
- Modify: `src/binance/symbolRules.ts`, `src/agents/ExecutorAgent.ts`
- Test: `tests/symbolRules.test.ts`, `tests/executorAgent.test.ts` (append)

**Interfaces:**
- Produces: `SymbolRules` gains `minQty: number` and `minNotional: number`; `DEFAULT_RULES` uses `0` for both (no limit). `rulesFromExchangeInfo` reads `LOT_SIZE.minQty` and the futures `MIN_NOTIONAL` filter's `notional` (`0` when absent). Executor throws (returned as an `error` LogEntry, no order) when `qty < minQty` or `qty × entryPrice < minNotional`. `ExecutorAgent.execute` and every helper ≤ 30 lines, behavior otherwise unchanged (symbol whitelist, hedge sizing off mark, SELL for hedge, rounding, sub-lot refusal, strategy passthrough).

- [ ] **Step 1: Append failing tests**

`tests/symbolRules.test.ts` — extend the first test's fixture and add:

```typescript
test('should read minQty and minNotional from exchange info, defaulting to no limit', () => {
  const withMin = {
    symbol: 'XRPUSDT', pricePrecision: 4, quantityPrecision: 1,
    filters: [
      { filterType: 'PRICE_FILTER', minPrice: '0.0001', maxPrice: '1000', tickSize: '0.0001' },
      { filterType: 'LOT_SIZE', minQty: '0.1', maxQty: '100000', stepSize: '0.1' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
    ],
  } as unknown as FuturesSymbolExchangeInfo;
  assert.deepEqual(rulesFromExchangeInfo(withMin), { pricePrecision: 4, quantityPrecision: 1, tickSize: 0.0001, stepSize: 0.1, minQty: 0.1, minNotional: 5 });
  const bare = { symbol: 'X', pricePrecision: 2, quantityPrecision: 3, filters: [] } as unknown as FuturesSymbolExchangeInfo;
  const rules = rulesFromExchangeInfo(bare);
  assert.equal(rules.minQty, 0);
  assert.equal(rules.minNotional, 0);
});
```
(Update the existing `deepEqual` in the first test and every `setSymbolRules(..., {...})` literal in `tests/*.test.ts` to include `minQty: 0, minNotional: 0`.)

`tests/executorAgent.test.ts` — add:

```typescript
test('should refuse an order below the symbol minimum quantity', async () => {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001, minQty: 20, minNotional: 0 });
  const { captured, executor } = stubService();
  const log = await executor.execute(signal({ entry: 100 }), risk); // 1000 USDT / 100 = qty 10
  assert.equal(log.level, 'error');
  assert.match(log.msg, /minimum quantity/);
  assert.equal(captured.length, 0);
});

test('should refuse an order below the symbol minimum notional', async () => {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001, minQty: 0, minNotional: 5000 });
  const { captured, executor } = stubService();
  const log = await executor.execute(signal({ entry: 100 }), risk); // notional 1000
  assert.equal(log.level, 'error');
  assert.match(log.msg, /minimum notional/);
  assert.equal(captured.length, 0);
});
```

- [ ] **Step 2:** Run `npx tsx --test tests/symbolRules.test.ts tests/executorAgent.test.ts`. Expected: FAIL (`minQty` undefined / no refusal).
- [ ] **Step 3:** Implement in `symbolRules.ts` and refactor `ExecutorAgent.execute` (extract e.g. `buildOrder(signal, risk)` for validation + sizing + rounding, and a `fillMessage` helper) so each function ≤ 30 lines.
- [ ] **Step 4:** Run `npx tsx --test tests/symbolRules.test.ts tests/executorAgent.test.ts` then `npx tsc --noEmit` and `npm test`. Expected: all pass, tsc silent.
- [ ] **Step 5: Checkpoint** — `git status --short`; do not commit.

---

### Task 2: Split `BinanceService.openFuturesPosition`

**Files:** Modify: `src/binance/client.ts`

**Interfaces:** Produces: no signature change. `openFuturesPosition` and every helper ≤ 30 lines (extract the live-order path, e.g. `submitLiveOrder(params)`, keeping the non-positive-quantity guard first and the paper branch unchanged).

- [ ] **Step 1:** Refactor. Behavior identical: paper delegates to the engine; live sets leverage, sets ISOLATED margin (ignoring the already-isolated error), submits the market order with `roundQty`, then places protective orders with `roundPrice`.
- [ ] **Step 2:** Run `npx tsc --noEmit && npm test`. Expected: silent / all pass. Then list function lengths in the file (e.g. `awk` over `client.ts`) and confirm none exceeds 30 lines.
- [ ] **Step 3: Checkpoint** — no commit.

---

### Task 3: TP-cap hysteresis and anchor freshness

**Files:**
- Modify: `src/agents/TrailingStopManager.ts`, `src/agents/AdaptiveSuperTrendAgent.ts`
- Test: `tests/trailingStopManager.test.ts`, `tests/adaptiveSuperTrendAgent.test.ts` (append)

**Interfaces:** Produces: LOW-regime cap applies only when `(takeProfit - cap) × direction > TP_TRIGGER_ATR × assignedAtr` (long: TP more than 0.5 ATR above the cap; mirror for shorts); an alt flip is allowed only when the anchor state's `candle.openTime >= ` the alt's last closed candle `openTime` **and** directions agree.

- [ ] **Step 1: Append failing tests**

`tests/trailingStopManager.test.ts`:
```typescript
test('should not re-tighten the LOW cap for a change smaller than half an ATR', () => {
  const state: TrailState = { superTrend: 90, regime: 'LOW', assignedAtr: 2 };
  // cap = 105 + 2*2 = 109; TP 109.5 is only 0.5 above it (<= 0.5 ATR = 1)
  assert.equal(nextStops(longPosition({ serverTp: '109.5' }), state), null);
});
```
`tests/adaptiveSuperTrendAgent.test.ts` — first change the existing `candles` helper to `function candles(count: number, flatBars = 120)` with `close = i < flatBars ? 100 : 100 + (i - flatBars + 1)` (the flip then lands on bar `flatBars + 6`; all existing calls keep working), then append:
```typescript
test('should skip an alt flip when the BTC state is older than the alt candle', async () => {
  const instance = agent();
  // Loop 1: BTC flips bullish on closed bar 126; ETH stays flat (no flip)
  await instance.run({ ...twoSymbolContext(candles(128)), candles: { BTCUSDT: candles(128), ETHUSDT: candles(128, 500) } });
  // Loop 2: BTC data is missing; ETH flips bullish on closed bar 127 (flat until bar 121)
  const later = twoSymbolContext(candles(128));
  later.candles = { ETHUSDT: candles(129, 121) };
  assert.deepEqual(await instance.run(later), []);
});
```
Without the freshness rule the stale bullish BTC state (bar 126) would allow the ETH long, so this test fails first.
- [ ] **Step 2:** Run both files. Expected: the two new tests FAIL.
- [ ] **Step 3:** Implement both changes (a named constant reuse for the 0.5-ATR trigger; pass the alt's `lastClosed.openTime` into `agreesWithAnchor`).
- [ ] **Step 4:** Run both test files, `npx tsc --noEmit`, `npm test`. Expected: pass.
- [ ] **Step 5: Checkpoint** — no commit.

---

### Task 4: Advisor resilience

**Files:** Modify: `src/ollama/advisor.ts`; Test: `tests/advisor.test.ts` (append)

**Interfaces:** Produces: `new OllamaAdvisor(client = new Ollama({ host }))` where the client type is `Pick<Ollama, 'list' | 'generate'>`; while offline `veto()` re-pings at most every `PING_INTERVAL_MS = 60_000`; `parseVerdict` returns reason `advisor sent an unknown verdict "<x>"` (verdict `PROCEED`) for valid JSON whose `verdict` is neither `PROCEED` nor `VETO`.

- [ ] **Step 1: Append failing tests**

```typescript
import { mock } from 'node:test';
import { OllamaAdvisor } from '../src/ollama/advisor.js';

const snapshot = { symbol: 'BTCUSDT', side: 'LONG' as const, regime: 'HIGH' as const, distanceFromLineAtr: 1, rsi: 55, fundingRate: 0.0001, entry: 100, stopLoss: 95, takeProfit: 112 };

test('should flag an unknown verdict as a fail-open reason', () => {
  const result = parseVerdict('{"verdict":"MAYBE"}');
  assert.equal(result.verdict, 'PROCEED');
  assert.match(result.reason, /^advisor sent an unknown verdict/);
});

test('should re-ping an offline advisor after the interval and then use the model', async () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  let online = false;
  const client = {
    list: async () => { if (!online) throw new Error('down'); return {} as never; },
    generate: async () => ({ response: '{"verdict":"VETO","reason":"extended"}' }) as never,
  };
  const advisor = new OllamaAdvisor(client);
  await new Promise((resolve) => setImmediate(resolve)); // constructor ping settles offline
  assert.equal((await advisor.veto(snapshot)).reason, 'advisor offline');
  online = true;
  mock.timers.setTime(61_000);
  assert.equal((await advisor.veto(snapshot)).verdict, 'VETO');
  mock.timers.reset();
});
```
- [ ] **Step 2:** Run `npx tsx --test tests/advisor.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement (record `lastPingAt`; `veto` re-pings when `!available && Date.now() - lastPingAt >= PING_INTERVAL_MS`).
- [ ] **Step 4:** Run the file, `npx tsc --noEmit`, `npm test`. Expected: pass (existing tests untouched).
- [ ] **Step 5: Checkpoint** — no commit.

---

### Task 5: Orchestrator promise safety and paper-only trailing

**Files:** Modify: `src/runtime/Orchestrator.ts`

**Interfaces:** Produces: no rejected promise can escape `start()` — both the initial `loadSymbolRules(...).then(loop)` chain and the `setInterval` callback end in a handler that logs `Loop crashed: <message>` at `error` level via `this.log`; the trailing pass (`trailStops(await getPositions())`) runs only when `config.mode === 'paper'`. File stays ≤ 300 lines (currently 297 — if the change does not fit, report instead of moving code; Task 10 frees lines).

- [ ] **Step 1:** Implement with the fewest lines (e.g. one private `runLoop()` that calls `this.loop()` and catches; use it at both call sites).
- [ ] **Step 2:** `npx tsc --noEmit && npm test && wc -l src/runtime/Orchestrator.ts`. Expected: silent, all pass, ≤ 300.
- [ ] **Step 3: Checkpoint** — no commit.

---

### Task 6: Persisted trade journal in the paper engine

**Files:** Modify: `src/types.ts`, `src/binance/paperEngine.ts`; Test: `tests/paperEngine.test.ts` (append)

**Interfaces:**
- Produces in `types.ts`:
```typescript
export type ExitReason = 'CLOSE' | 'FLIP' | 'STOP LOSS' | 'TAKE PROFIT' | 'LIQUIDATED';
export interface TradeRecord {
  symbol: string; strategy: AgentId; side: Side; entry: number; exit: number;
  qty: number; pnl: number; reason: ExitReason; closedAt: number;
}
```
- Produces in `PaperEngine`: `getTrades(): TradeRecord[]` (copy, oldest first); `getAccount()` returns `{ equity, marginUsed, initialEquity }` with `initialEquity = 100_000` (one named constant, also used for the initial `equity`/`startEquity`); the journal is persisted in the state file as `closedTrades` (cap `MAX_TRADES = 1000`, oldest dropped) and loaded (missing/invalid → `[]`).
- A record is written wherever `reduce()` books realized PnL, with `reason`: `'CLOSE'` for a `reduceOnly` fill, `'FLIP'` for the close half of an opposite-side entry, and `exit.reason` (`'STOP LOSS' | 'TAKE PROFIT' | 'LIQUIDATED'`) for `markAll` exits. `pnl = (exit − entry) × closedQty × direction`; a partial reduce records the closed quantity only. `dropUnlistedSymbols` records nothing.

- [ ] **Step 1: Append failing tests**

```typescript
test('should journal every realized close with its reason and pnl', () => {
  const engine = freshEngine();
  engine.openPosition({ ...base, side: 'BUY', qty: 2, entryPrice: 100, stopLoss: 90, takeProfit: 130 });
  engine.openPosition({ ...base, side: 'SELL', qty: 1, entryPrice: 110, reduceOnly: true }); // partial manual close
  engine.markAll({ BTCUSDT: 131 }); // take profit on the remaining 1
  const [manual, tp] = engine.getTrades();
  assert.deepEqual({ reason: manual.reason, qty: manual.qty, exit: manual.exit, pnl: manual.pnl }, { reason: 'CLOSE', qty: 1, exit: 110, pnl: 10 });
  assert.deepEqual({ reason: tp.reason, qty: tp.qty, exit: tp.exit, pnl: tp.pnl }, { reason: 'TAKE PROFIT', qty: 1, exit: 130, pnl: 30 });
  assert.equal(engine.getAccount().initialEquity, 100_000);
});

test('should mark the close half of a flip as FLIP', () => {
  const engine = freshEngine();
  engine.openPosition({ ...base, side: 'BUY', qty: 1, entryPrice: 100 });
  engine.openPosition({ ...base, side: 'SELL', qty: 1, entryPrice: 90 });
  assert.equal(engine.getTrades()[0].reason, 'FLIP');
  assert.equal(engine.getTrades()[0].pnl, -10);
});

test('should persist the journal across restarts', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'paper-')), 'state.json');
  const first = new PaperEngine(file);
  first.openPosition({ ...base, side: 'BUY', qty: 1, entryPrice: 100 });
  first.openPosition({ ...base, side: 'SELL', qty: 1, entryPrice: 105, reduceOnly: true });
  await new Promise((resolve) => setTimeout(resolve, 400)); // debounced persist
  assert.equal(new PaperEngine(file).getTrades().length, 1);
});
```
- [ ] **Step 2:** Run `npx tsx --test tests/paperEngine.test.ts`. Expected: FAIL (`getTrades` missing).
- [ ] **Step 3:** Implement. `reduce` gains a `reason` parameter (keep ≤ 4 params; the engine has a private `now()`-free path — use `Date.now()` for `closedAt`).
- [ ] **Step 4:** `npx tsx --test tests/paperEngine.test.ts && npx tsc --noEmit && npm test`. Expected: pass.
- [ ] **Step 5: Checkpoint** — no commit.

---

### Task 7: Performance statistics

**Files:** Create: `src/binance/performance.ts`; Test: `tests/performance.test.ts`

**Interfaces:** Produces:
```typescript
export interface StrategyPerformance { closed: number; wins: number; pnl: number }
export interface PerformanceSummary {
  totalPnl: number; totalPnlPct: number; closedTrades: number;
  winRate: number | null; maxDrawdownPct: number; sharpe: number | null;
  var95: number | null; liquidations: number;
  byStrategy: Record<string, StrategyPerformance>;
}
export function summarizePerformance(trades: TradeRecord[], initialEquity: number, currentEquity: number, now: number): PerformanceSummary
export function simpleReturns(closes: number[]): number[]        // (c[i]-c[i-1])/c[i-1]
export function correlation(a: number[], b: number[]): number | null // Pearson, aligned tails, null if < 30 pairs or zero variance
```
Rules (spec-binding): `totalPnl = currentEquity − initialEquity`, `totalPnlPct = totalPnl / initialEquity × 100`; win = `pnl > 0`; `winRate = wins/closed×100` or `null`; `maxDrawdownPct` from the curve `[initialEquity, …cumulative after each trade in closedAt order…, currentEquity]`, ≤ 0; `sharpe` from UTC-day returns (day pnl ÷ equity at day start), zero-filled from the first trade day through `now`'s day, needs ≥ 5 days and non-zero sample std, else `null`, value `mean/std × √365`; `var95` = `min(0, sorted[floor(0.05 × n)])` of per-trade pnl, needs ≥ 20 trades else `null`; `liquidations` counts `reason === 'LIQUIDATED'`.

- [ ] **Step 1: Write the failing test** — `tests/performance.test.ts`

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TradeRecord } from '../src/types.js';
import { correlation, simpleReturns, summarizePerformance } from '../src/binance/performance.js';

const DAY = 86_400_000;
const trade = (pnl: number, closedAt: number, overrides: Partial<TradeRecord> = {}): TradeRecord => ({
  symbol: 'BTCUSDT', strategy: 'ADAPTIVE-ST-ζ', side: 'LONG', entry: 100, exit: 100 + pnl, qty: 1, pnl, reason: 'CLOSE', closedAt, ...overrides,
});
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('should report nulls and zeros for an empty journal', () => {
  const s = summarizePerformance([], 100_000, 100_000, 0);
  assert.deepEqual({ w: s.winRate, sh: s.sharpe, v: s.var95, dd: s.maxDrawdownPct, pnl: s.totalPnl, n: s.closedTrades }, { w: null, sh: null, v: null, dd: 0, pnl: 0, n: 0 });
});

test('should compute totals, win rate, per-strategy stats and liquidations', () => {
  const trades = [trade(100, 1), trade(-50, 2, { strategy: 'MOMENTUM-γ' }), trade(-30, 3, { reason: 'LIQUIDATED' })];
  const s = summarizePerformance(trades, 100_000, 100_020, 10);
  near(s.totalPnl, 20);
  near(s.totalPnlPct, 0.02);
  near(s.winRate!, 100 / 3);
  assert.equal(s.liquidations, 1);
  assert.deepEqual(s.byStrategy['ADAPTIVE-ST-ζ'], { closed: 2, wins: 1, pnl: 70 });
  assert.deepEqual(s.byStrategy['MOMENTUM-γ'], { closed: 1, wins: 0, pnl: -50 });
});

test('should measure the largest peak-to-trough drawdown on the realized curve', () => {
  // curve: 100000, 100100, 100050, 100020 (peak 100100, trough 100020)
  const s = summarizePerformance([trade(100, 1), trade(-50, 2), trade(-30, 3)], 100_000, 100_020, 10);
  near(s.maxDrawdownPct, ((100_020 - 100_100) / 100_100) * 100);
});

test('should return sharpe only with five calendar days of data', () => {
  const day = (n: number, pnl: number) => trade(pnl, n * DAY + 1000);
  const four = summarizePerformance([day(0, 100), day(1, 50), day(2, 80), day(3, 20)], 100_000, 100_250, 3 * DAY + 5000);
  assert.equal(four.sharpe, null);
  const five = summarizePerformance([day(0, 100), day(1, 50), day(2, 80), day(3, 20), day(4, 60)], 100_000, 100_310, 4 * DAY + 5000);
  assert.ok(five.sharpe! > 0);
});

test('should return var95 only with 20 trades and floor it at zero', () => {
  const few = summarizePerformance(Array.from({ length: 19 }, (_, i) => trade(-i, i)), 100_000, 99_000, 100);
  assert.equal(few.var95, null);
  const twenty = Array.from({ length: 20 }, (_, i) => trade(i + 1, i)); // all winners
  assert.equal(summarizePerformance(twenty, 100_000, 100_210, 100).var95, 0);
  const losing = Array.from({ length: 20 }, (_, i) => trade(-(i + 1), i)); // -1 … -20
  assert.equal(summarizePerformance(losing, 100_000, 99_790, 100).var95, -19); // ascending -20,-19,…: index floor(0.05 × 20) = 1
});

test('should compute simple returns and Pearson correlation', () => {
  assert.deepEqual(simpleReturns([100, 110, 99]), [0.1, -0.1]);
  const a = Array.from({ length: 40 }, (_, i) => Math.sin(i / 3));
  near(correlation(a, a)!, 1);
  near(correlation(a, a.map((x) => -x))!, -1);
  assert.equal(correlation(a.slice(0, 10), a.slice(0, 10)), null);
  assert.equal(correlation(new Array(40).fill(1), a), null);
});
```
- [ ] **Step 2:** Run `npx tsx --test tests/performance.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `src/binance/performance.ts` per the rules above (pure, no I/O, functions ≤ 30 lines each).
- [ ] **Step 4:** Run the file, `npx tsc --noEmit`, `npm test`. Expected: pass.
- [ ] **Step 5: Checkpoint** — no commit.

---

### Task 8: State shape, empty store, config constant, client hooks

**Files:** Modify: `src/types.ts`, `src/store.ts`, `src/config.ts`, `src/binance/client.ts`, `src/runtime/Orchestrator.ts` (interval constant only), `src/ui/panels.tsx` / `src/ui/App.tsx` only where the compiler forces a rename.

**Interfaces:** Produces, in `types.ts`:
```typescript
export type WsStatus = 'connected' | 'reconnecting' | 'down';
export interface AgentState {
  id: AgentId; status: 'RUNNING' | 'PAUSED' | 'WATCHING'; strategy: string;
  positions: number; winRate: number | null; pnl: number;
}
export interface FundingInfo { rate: number; apr: number }              // apr in % (rate × 3 × 365 × 100)
export interface AdaptiveInfo { direction: 'BULLISH' | 'BEARISH'; regime: 'HIGH' | 'MEDIUM' | 'LOW'; superTrend: number; distanceAtr: number }
export interface StrategyMetrics {
  fundingBySymbol: Record<string, FundingInfo>;
  nextFundingCountdown: string | null;
  estNextFundingUsd: number;
  zscoreBtcEth: number | null;
  atrBySymbol: Record<string, number>;
  adaptive: Record<string, AdaptiveInfo>;
  momentumAboveEma50: { up: number; total: number };
}
```
and `AppState` fields (replace the old mock-backed optional ones): `initialEquity: number; totalPnl: number; totalPnlPct: number; successRate: number | null; sharpe: number | null; maxDd: number; var95: number | null; liqEvents: number; sessionDecisions: number; sessionExecuted: number; sessionMonitored: number; apiWeight: number; wsStatus: WsStatus; exposurePct: number; minLiqDistancePct: number | null; corrBtcEth: number | null; strategyMetrics: StrategyMetrics | null`. Remove `todayDecisions/todayExecuted/todayMonitored/liqBufferAtr` and `AgentState.progress`, and the old `StrategyMetrics` fields.
- `config.ts`: `export const LOOP_INTERVAL_MS = 8000;` (Orchestrator uses it instead of the literal `8000`).
- `BinanceService`: `getApiWeight(): number` (`this.futures.getRateLimitStates()['x-mbx-used-weight-1m']`, `0` if unavailable) and `getWsStatus(): WsStatus` — driven by the websocket client's `open`/`reconnected` → `connected`, `reconnecting` → `reconnecting`, `close` → `down`; initial `down`.
- `store.ts`: initial state contains **no mock data**: empty `positions`, `agents`, `logs`, `spotPrices`, `funding: {}`, zeros/`null` for every metric, `strategyMetrics: null`, `wsStatus: 'down'`, `initialEquity: 100_000`, `equity: 100_000`, `mode: config.mode`.

- [ ] **Step 1:** Make the type changes, then fix every compile error the removal causes by the smallest edit (UI call sites that read removed fields may render `—` placeholders for now; Tasks 11–12 finish the UI). Add `LOOP_INTERVAL_MS`, `getApiWeight`, `getWsStatus`, and the empty store.
- [ ] **Step 2:** `npx tsc --noEmit && npm test`. Expected: silent, all pass.
- [ ] **Step 3: Checkpoint** — no commit.

---

### Task 9: Telemetry builder

**Files:** Create: `src/runtime/telemetry.ts`; Test: `tests/telemetry.test.ts`

**Interfaces:** Consumes: `summarizePerformance`, `correlation`, `simpleReturns` (Task 7); types (Task 8); `ema`, `atr` from `src/binance/indicators.ts`; `AdaptiveSuperTrendBar`.
Produces:
```typescript
export interface AgentRuntime { id: AgentId; status: 'RUNNING' | 'PAUSED' | 'WATCHING'; strategy: string }
export interface SessionCounters { decisions: number; executed: number; monitored: number }
export interface TelemetryInput {
  account: { equity: number; marginUsed: number; initialEquity: number };
  positions: Position[]; trades: TradeRecord[];
  candles: Record<string, Candle[]>; funding: Record<string, number>; nextFundingTime: number;
  adaptive: Record<string, AdaptiveSuperTrendBar | undefined>;
  agents: AgentRuntime[]; counters: SessionCounters;
  apiWeight: number; wsStatus: WsStatus; now: number;
}
export type Telemetry = Pick<AppState, 'initialEquity' | 'totalPnl' | 'totalPnlPct' | 'successRate' | 'sharpe' | 'maxDd' | 'var95' | 'liqEvents' | 'sessionDecisions' | 'sessionExecuted' | 'sessionMonitored' | 'apiWeight' | 'wsStatus' | 'exposurePct' | 'minLiqDistancePct' | 'corrBtcEth' | 'agents' | 'strategyMetrics'>;
export function buildTelemetry(input: TelemetryInput): Telemetry
```
Rules: perf fields from `summarizePerformance(trades, initialEquity, equity, now)` (`maxDd` = `maxDrawdownPct`, `liqEvents` = `liquidations`, `successRate` = `winRate`); `exposurePct = Σ qty×mark ÷ equity × 100` (0 when equity ≤ 0); `minLiqDistancePct` = min non-null `liqDistancePct` else `null`; `corrBtcEth = correlation(returns(BTCUSDT closes), returns(ETHUSDT closes))` (null if either series missing); counters copied to `session*`; `agents[i]` = runtime + `positions` (open count by `strategy`) + `winRate` (`byStrategy` closed/wins → % or `null`) + `pnl` (realized by strategy + Σ upnl of that strategy's open positions); `strategyMetrics`: `fundingBySymbol[sym] = { rate, apr: rate×3×365×100 }`; `nextFundingCountdown` = `"<h>h<m>m"` from `nextFundingTime − now` (floor, min 0) or `null` when `nextFundingTime <= 0`; `estNextFundingUsd` = Σ over `FUNDING-ARB-α` positions of `qty × mark × rate(symbol)` × (`SHORT` → +1, `LONG` → −1); `zscoreBtcEth` = `pairZScore(BTC candles, ETH candles)` or `null` if either missing/short (< 30 candles); `atrBySymbol[sym] = atr(candles, 14)` for symbols with candles; `adaptive[sym]` from bars (`distanceAtr = |lastClose − superTrend| / assignedAtr`, last close = the bar's `candle.close`); `momentumAboveEma50 = { up: symbols whose last close > last EMA50, total: symbols with ≥ 50 candles }`.

- [ ] **Step 1: Write the failing test** — `tests/telemetry.test.ts`

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle, Position, TradeRecord } from '../src/types.js';
import { buildTelemetry, type TelemetryInput } from '../src/runtime/telemetry.js';

const closes = (values: number[]): Candle[] => values.map((c, i) => ({ openTime: i, open: c, high: c + 1, low: c - 1, close: c, volume: 1 }));
const position = (over: Partial<Position>): Position => ({
  id: 'p', symbol: 'ETHUSDT', side: 'SHORT', strategy: 'FUNDING-ARB-α', entry: 100, qty: 10, mark: 100, upnl: 5, upnlPct: 0.5,
  leverage: 5, marginType: 'ISOLATED', liqDistancePct: 18.5, serverSl: '—', serverTp: 'fund', ...over,
});
const trade = (pnl: number, strategy: TradeRecord['strategy']): TradeRecord =>
  ({ symbol: 'ETHUSDT', strategy, side: 'LONG', entry: 1, exit: 1, qty: 1, pnl, reason: 'CLOSE', closedAt: 1 });

function input(over: Partial<TelemetryInput> = {}): TelemetryInput {
  return {
    account: { equity: 100_100, marginUsed: 200, initialEquity: 100_000 },
    positions: [position({}), position({ symbol: 'BTCUSDT', strategy: 'ADAPTIVE-ST-ζ', side: 'LONG', liqDistancePct: 9.5, qty: 1, mark: 1000, upnl: 0 })],
    trades: [trade(100, 'ADAPTIVE-ST-ζ'), trade(-40, 'ADAPTIVE-ST-ζ')],
    candles: { BTCUSDT: closes(Array.from({ length: 60 }, (_, i) => 100 + i)), ETHUSDT: closes(Array.from({ length: 60 }, (_, i) => 50 + i / 2)) },
    funding: { BTCUSDT: 0.0001, ETHUSDT: 0.0002 },
    nextFundingTime: 3 * 3_600_000 + 25 * 60_000, now: 0,
    adaptive: {},
    agents: [{ id: 'FUNDING-ARB-α', status: 'RUNNING', strategy: 'funding_rate_harvest' }, { id: 'ADAPTIVE-ST-ζ', status: 'RUNNING', strategy: 'ml_adaptive_supertrend' }],
    counters: { decisions: 7, executed: 3, monitored: 4 }, apiWeight: 12, wsStatus: 'connected', ...over,
  };
}

test('should derive account, risk and counter fields from real inputs', () => {
  const t = buildTelemetry(input());
  assert.equal(t.totalPnl, 100);
  assert.equal(t.initialEquity, 100_000);
  assert.equal(t.successRate, 50);
  assert.equal(t.minLiqDistancePct, 9.5);
  assert.equal(t.exposurePct, ((10 * 100 + 1 * 1000) / 100_100) * 100);
  assert.deepEqual([t.sessionDecisions, t.sessionExecuted, t.sessionMonitored, t.apiWeight, t.wsStatus], [7, 3, 4, 12, 'connected']);
  assert.ok(Math.abs(t.corrBtcEth! - 1) < 1e-9); // both series are linear
});

test('should build per-agent state from positions and the journal', () => {
  const [funding, adaptive] = buildTelemetry(input()).agents;
  assert.deepEqual({ p: funding.positions, w: funding.winRate, pnl: funding.pnl }, { p: 1, w: null, pnl: 5 });
  assert.deepEqual({ p: adaptive.positions, w: adaptive.winRate, pnl: adaptive.pnl }, { p: 1, w: 50, pnl: 60 });
});

test('should compute funding APR, countdown and the funding estimate', () => {
  const m = buildTelemetry(input()).strategyMetrics!;
  assert.ok(Math.abs(m.fundingBySymbol.BTCUSDT.apr - 0.0001 * 3 * 365 * 100) < 1e-9);
  assert.equal(m.nextFundingCountdown, '3h25m');
  assert.ok(Math.abs(m.estNextFundingUsd - 10 * 100 * 0.0002) < 1e-9); // short earns positive funding
  assert.deepEqual(m.momentumAboveEma50, { up: 2, total: 2 });
});

test('should return nulls instead of demo values when data is missing', () => {
  const t = buildTelemetry(input({ candles: {}, funding: {}, nextFundingTime: 0, positions: [], trades: [] }));
  assert.equal(t.corrBtcEth, null);
  assert.equal(t.minLiqDistancePct, null);
  assert.equal(t.successRate, null);
  assert.equal(t.strategyMetrics!.nextFundingCountdown, null);
  assert.equal(t.strategyMetrics!.zscoreBtcEth, null);
  assert.deepEqual(t.strategyMetrics!.fundingBySymbol, {});
});
```
- [ ] **Step 2:** Run `npx tsx --test tests/telemetry.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `src/runtime/telemetry.ts` (pure; split into small helpers so each function ≤ 30 lines; reuse `pairZScore` and `atr`/`ema` from `indicators.ts`).
- [ ] **Step 4:** Run the file, `npx tsc --noEmit`, `npm test`. Expected: pass.
- [ ] **Step 5: Checkpoint** — no commit.

---

### Task 10: Orchestrator emits real telemetry

**Files:** Modify: `src/runtime/Orchestrator.ts`; (`src/binance/client.ts` only if a getter is missing)

**Interfaces:** Consumes: `buildTelemetry` (Task 9), `getTrades()`/`getAccount().initialEquity` (Task 6), `getApiWeight`/`getWsStatus` (Task 8). Produces: every `emitState` (8 s loop) spreads `buildTelemetry({...})` into the emitted state; `flushRealtimeTick` keeps emitting equity/positions/uPnL/prices only. Session counters live in the orchestrator: `decisions` incremented for each signal reaching `risk.gate`; `executed` on a successful fill; `monitored` when the gate rejects, the veto blocks, or the cooldown skips a signal. Agent runtime list = `[...this.agents, this.risk, this.executor]` plus a constant disabled entry for `PAIRS-TRD-β` (`status: 'PAUSED'`, strategy `stat_pairs_zscore`), with `ADAPTIVE-ST-ζ` present as `PAUSED` in live mode. `computeStrategyMetrics` and the old metric plumbing are deleted (their content now lives in `telemetry.ts`). `PaperEngine` trades are read through `BinanceService` (add `getTrades()` there, `[]` in live mode; `getAccount()` returns `initialEquity` = current equity in live mode).

- [ ] **Step 1:** Implement. Keep `Orchestrator.ts` ≤ 300 lines (deleting `computeStrategyMetrics` frees ~40 lines).
- [ ] **Step 2:** `npx tsc --noEmit && npm test && wc -l src/runtime/Orchestrator.ts`. Expected: silent, all pass, ≤ 300.
- [ ] **Step 3:** Smoke (no network needed): write a throwaway script in the scratchpad that builds `buildTelemetry` from fixture data and prints the `Telemetry` keys — only if the implementer needs it; otherwise skip.
- [ ] **Step 4: Checkpoint** — no commit.

---

### Task 11: Split `panels.tsx` (pure refactor)

**Files:** Create: `src/ui/format.ts`, `src/ui/accountPanels.ts`, `src/ui/marketPanels.ts`; Modify: `src/ui/panels.tsx`, `src/ui/App.tsx` (only if imports must change); Test: `tests/cockpit.test.ts` (baseline)

**Interfaces:** Produces:
- `format.ts`: `padLine`, `boxLines`, `usd`, `fmtVol`, `fmtRange` (moved verbatim).
- `accountPanels.ts`: `renderHeaderLines`, `renderCol1Lines`, `renderCol3Lines`, `renderCol4Lines`, `renderPerfLines`, `renderFooterLines`.
- `marketPanels.ts`: `renderCol2Lines` (+ `renderAssetRow`), `renderMetricsLines`, `renderDetailLines`, `renderLogLines`.
- `panels.tsx`: `CockpitProps`, `computeColWidths`, `computeRowHeights`, `renderCockpitTable`, `ResizeWarning`, `renderCockpit`; re-exports what `App.tsx` imports today (`renderCockpit`, `ResizeWarning`).
No behavior change: rendered output is byte-identical to before the split for the same props.

- [ ] **Step 1: Write the baseline test** — `tests/cockpit.test.ts`

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderCockpit, type CockpitProps } from '../src/ui/panels.js';

export const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');

export function baseProps(overrides: Partial<CockpitProps> = {}): CockpitProps {
  return {
    mode: 'paper', time: '12:00:00', equity: 100_000, upnl: 0, marginUsed: 0, positions: [], selPos: 0,
    agents: [], logs: [], spotPrices: {}, isSyncing: false, totalWidth: 160, totalHeight: 58, ...overrides,
  } as CockpitProps;
}

test('should render a full-width cockpit without throwing for an empty state', () => {
  const lines = renderCockpit(baseProps());
  assert.ok(lines.length >= 28);
  for (const line of lines) assert.ok(strip(line).length > 0);
});
```
(`CockpitProps` will change in Task 12; keep this helper as the single place tests build props.)
- [ ] **Step 2:** Run `npx tsx --test tests/cockpit.test.ts` — expected PASS before the split (baseline). Save the rendered output of a fixed props object to a scratch file for comparison.
- [ ] **Step 3:** Perform the split (move code verbatim; fix imports; keep each file ≤ 300 lines).
- [ ] **Step 4:** Re-run the baseline test, `npx tsc --noEmit`, `npm test`; diff the rendered output against the saved scratch output — must be identical. `wc -l src/ui/*.ts*` all ≤ 300.
- [ ] **Step 5: Checkpoint** — no commit.

---

### Task 12: Real data in every cockpit cell, plus the no-mock guard

**Files:** Modify: `src/ui/panels.tsx`, `src/ui/accountPanels.ts`, `src/ui/marketPanels.ts`, `src/ui/format.ts`, `src/ui/App.tsx`; Test: `tests/cockpit.test.ts` (extend)

**Interfaces:** Consumes: the `AppState` shape from Task 8, emitted by Task 10. `CockpitProps` is rebuilt from `AppState`: `mode, time, equity, upnl, marginUsed, positions, selPos, agents, logs, spotPrices, isSyncing, totalWidth, totalHeight` plus `initialEquity, totalPnl, totalPnlPct, successRate, sharpe, maxDd, var95, liqEvents, sessionDecisions, sessionExecuted, sessionMonitored, apiWeight, wsStatus, exposurePct, minLiqDistancePct, corrBtcEth, funding, strategyMetrics`. `App.tsx` passes them from the store (remove `fundingRate: funding['ETHUSDT']`).

**Exact cell rules** (formatting: USD with `usd()`, prices/quantities with `formatPrice`/`formatQty` using the position's or asset's `<SYM>USDT`; unavailable → `—`):
1. **Header** (`renderHeaderLines`): right side `●{running} ag` where `running` = agents with status `RUNNING`, then `●auto`.
2. **Fleet title** `AGENT FLEET ({running} active)`; **positions title** `POSITIONS ({n} open)` (n = `positions.length`, always the number, also in narrow layout).
3. **Col 1**: `Equity  $<usd(equity)> (<mode>)`; second line `±$<usd(|totalPnl|)> (±<pct 2dp>% total)` in green/red (`+$0.00 (+0.00% total)` at zero); `uPnL`; `Margin  $<usd> (<2dp>% used)`; `Free`; `Lev <min>-<max>x │ Margin ISOLATED` from `config.risk.minLeverage/maxLeverage`. Fleet rows for `agents` (all of them, up to 6): `● <id> <status>` (`●` RUNNING, `◐` otherwise), strategy, `pos <positions> win <winRate 2dp% or —> pnl ±$<usd(pnl)>`, and a 12-cell bar drawn from `winRate` (empty when `null`) with the percentage text or `—`.
4. **Col 2**: funding header `USDM Funding 8h: <mean rate across strategyMetrics.fundingBySymbol, 4dp %, signed> │ settle in <nextFundingCountdown or —>`; table rows for `config.symbols` (short name = symbol without `USDT`), price via `formatPrice`, no fallback prices (`—` when the asset has no data), 24h range via `fmtRange`, volume via `fmtVol`; **MARKET REGIME & VOLATILITY**: `Turnover │ <fmtVol(Σ volumeQuote of assets with data)> 24h futures vol`; `Momentum │ <BULLISH|BEARISH|MIXED> (<up> of <total> above EMA50)` (`—` when total is 0; BULLISH when up = total, BEARISH when up = 0, else MIXED); `Carry │ <POSITIVE|NEGATIVE|FLAT> (<mean APR, signed, 2dp>% APR avg)` from `fundingBySymbol` (`—` when empty); `Trend │` one `<SYM> ▲|▼ <REGIME>` token per symbol in `strategyMetrics.adaptive` (`warming up` when empty).
5. **Col 3**: rows use `formatPrice`/`formatQty`; empty → `no open positions`; footer `Total uPnL: ±$<2dp>` and `Positions:  <n> active`.
6. **Col 4**: `Unrealized`, `Margin`, `Free` (2dp); risk block: `VaR(95%)   <±$usd(var95) or —>`, `Exposure   <exposurePct 2dp>% / <config.risk.maxExposurePct>%`, `MaxDD      <maxDd 2dp>% / -<config.risk.maxDrawdownPct>%`, `Liq dist   <minLiqDistancePct 2dp>%` (`—` when null), `Corr BTC-E <corr 2dp> <high|medium|low>` (`|c| ≥ 0.8` high, `≥ 0.5` medium, else low; `—` when null), `Sharpe     <2dp or —>`; **POSITION ACTIONS** lists up to 3 real positions around the selection as `▸Close <symbol> <side>` (selected, yellow) / ` Close …` (others, gray), or `no open positions`.
7. **Position detail** (`renderDetailLines(position | undefined)`): with a position — line 1 `<symbol> <side> · <strategy> │ entry $<formatPrice> │ size <formatQty> │ mark $<formatPrice> │ uPnL ±$<2dp> (±<pct 2dp>%) │ lev <n>x ISOLATED`; line 2 `liq dist <liqDistancePct 2dp or —>% │ SL <formatPrice if numeric else raw label> │ TP <same> │ margin $<usd(qty×mark/leverage)> │ 1R $<usd(initialRisk×qty) or —>`. Without a position — line 1 `no open position selected`, line 2 `—`. No fake default position.
8. **Strategy metrics box** (4 rows): `FUNDING-ARB │ <SYM> <±rate 4dp>% (<apr 2dp>% APR) …per symbol… │ next <countdown or —> est ±$<usd(estNextFundingUsd)>`; `PAIRS-TRD │ disabled (ratio is not tradable) │ BTC/ETH z <±2dp or —> (info only)`; `MOMENTUM │ <SYM> ATR <formatPrice(sym, atr)> … per symbol │ EMA50 <up>/<total>`; `ADAPTIVE-ST │ <SYM> ▲|▼ <REGIME> <formatPrice(sym, superTrend)> (<distanceAtr 2dp> ATR) … per symbol` (`warming up (needs 109 closed candles)` when empty). `computeRowHeights` is adjusted (`available = targetRows - 31`) so the total line count is unchanged by the extra row.
9. **Log**: empty rows are blank; real rows show `HH:MM:SS agent msg`.
10. **Perf strip** (`renderPerfLines(props, width)`): `Session <sessionDecisions> decisions │ <sessionExecuted> executed │ <sessionMonitored> monitored │ <successRate 2dp or —>% win │ ±$<usd(totalPnl)> PnL │ Sharpe <2dp or —> │ MaxDD <maxDd 2dp>% │ liq events <liqEvents>`.
11. **Footer**: `⠴ orchestrator │ <running> agents autonomous │ eval <LOOP_INTERVAL_MS/1000>s │ api weight <apiWeight>/2400 │ ws ●<wsStatus> │ mode <MODE> │ venue BINANCE FUTURES` (`ws` dot green for `connected`, yellow `reconnecting`, red `down`).

- [ ] **Step 1: Extend `tests/cockpit.test.ts` with the guard and real-value tests**

```typescript
import { setSymbolRules } from '../src/binance/symbolRules.js';
import { config } from '../src/config.js';
import type { AgentState, Position } from '../src/types.js';

const FORBIDDEN = ['27,766', '142', '96.4', '2.84', '1,842', '18.7', '0.91', '247/1200', 'AVAX', 'ETH/USDT', 'SOL/USDT', 'BTC/ETH pairs', '127.40', '2750', '7h58m', '1.8x', '2.1x'];
const render = (props: CockpitProps) => renderCockpit(props).map(strip).join('\n');

function realisticProps(): CockpitProps {
  const symbol = config.symbols[0];
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.1, stepSize: 0.001, minQty: 0, minNotional: 0 });
  const position: Position = {
    id: 'p', symbol, side: 'LONG', strategy: 'ADAPTIVE-ST-ζ', entry: 81_000.5, qty: 0.012, mark: 81_100.25, upnl: 1.2, upnlPct: 0.12,
    leverage: 5, marginType: 'ISOLATED', liqDistancePct: 19.5, serverSl: '80100.5', serverTp: '83000', initialRisk: 900,
  };
  const agents: AgentState[] = [{ id: 'ADAPTIVE-ST-ζ', status: 'RUNNING', strategy: 'ml_adaptive_supertrend', positions: 1, winRate: 62.5, pnl: 12.34 }];
  return baseProps({
    equity: 100_012.34, upnl: 1.2, marginUsed: 194.6, positions: [position], agents, initialEquity: 100_000, totalPnl: 12.34, totalPnlPct: 0.01234,
    successRate: 62.5, sharpe: null, maxDd: -0.5, var95: null, liqEvents: 0, sessionDecisions: 9, sessionExecuted: 3, sessionMonitored: 6,
    apiWeight: 31, wsStatus: 'connected', exposurePct: 0.97, minLiqDistancePct: 19.5, corrBtcEth: 0.84, funding: {}, strategyMetrics: null,
    spotPrices: { [symbol.replace('USDT', '')]: { price: 81_100.25, changePct: 1.5, low24h: 80_000, high24h: 82_000, volumeQuote: 2e9 } },
  } as Partial<CockpitProps>);
}

test('should show no known mock literal with an empty state', () => {
  const text = render(baseProps());
  for (const literal of FORBIDDEN) assert.ok(!text.includes(literal), `mock literal "${literal}" is still rendered`);
});

test('should show no known mock literal with a realistic state', () => {
  const text = render(realisticProps());
  for (const literal of FORBIDDEN) assert.ok(!text.includes(literal), `mock literal "${literal}" is still rendered`);
});

test('should render real values with per-symbol precision', () => {
  const text = render(realisticProps());
  assert.ok(text.includes('+$12.34'));           // total PnL
  assert.ok(text.includes('POSITIONS (1 open)'));
  assert.ok(text.includes('AGENT FLEET (1 active)'));
  assert.ok(text.includes('81,000.50'));         // entry at the symbol's 2 decimals
  assert.ok(text.includes('0.012'));             // quantity at 3 decimals
  assert.ok(text.includes('Session 9 decisions'));
  assert.ok(text.includes('Close ' + config.symbols[0]));
  assert.ok(text.includes('api weight 31/2400'));
});

test('should list every configured symbol as an asset row and nothing else', () => {
  const text = render(realisticProps());
  for (const symbol of config.symbols) assert.ok(text.includes(symbol.replace('USDT', '')));
});

test('should show placeholders, not demo values, before data arrives', () => {
  const text = render(baseProps());
  assert.ok(text.includes('no open positions'));
  assert.ok(text.includes('no open position selected'));
  assert.ok(text.includes('POSITIONS (0 open)'));
  assert.ok(text.includes('AGENT FLEET (0 active)'));
});
```
- [ ] **Step 2:** Run `npx tsx --test tests/cockpit.test.ts`. Expected: the new tests FAIL (mock literals still present / new fields unread).
- [ ] **Step 3:** Implement the eleven cell rules above across the UI modules and `App.tsx`. Files ≤ 300 lines each; functions ≤ 30 lines (split renderers into helpers); no literal from the forbidden list may remain anywhere in `src/ui/` or `src/store.ts`. Grep the source too: `grep -nE "27,766|142|96\.4|2\.84|1,842|18\.7x|0\.91|247/1200|AVAX|127\.40|7h58m" src/ui src/store.ts` must print nothing.
- [ ] **Step 4:** `npx tsx --test tests/cockpit.test.ts`, `npx tsc --noEmit`, `npm test`, `npm run build`. Expected: all pass, build succeeds.
- [ ] **Step 5: Checkpoint** — no commit.

---

### Task 13: Verification (controller)

- [ ] `npx tsc --noEmit`, `npm test`, `npm run build`, line-count and function-length audit of touched files.
- [ ] Run the cockpit once against fixture props (Task 12 tests) and, without touching `data/paper-state.json`, a scratchpad script that renders `renderCockpit` from `buildTelemetry` output with live-shaped inputs.
- [ ] Tell the user how to restart (`s` in the TUI, then `npm run dev:paper`); the startup purge removes stale `BTCUSDTETHUSDT` rows.
