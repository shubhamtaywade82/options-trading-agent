# Risk + Sizing Core and Ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port crypto-agent's Decimal position sizer, graded circuit breaker, risk engine and performance engine into `src/risk/`, and its audit trail + Telegram alert system into `src/ops/`, flag-gated and without touching the TUI stack.

**Architecture:** Pure ported modules (`src/risk/*`, `src/ops/*`) with small adapters to our types (`SymbolRules`, `TradeRecord`, `Signal`, `Position`); wired through the existing seams (`Orchestrator` → `MarketContext.performance` → `RiskAgent.gate`; `processSignals`/`logExits`/venue status → audit events + alerts). Flags `RISK_ENGINE`, `AUDIT`, `ALERTS` default off.

**Tech Stack:** TypeScript ESM strict, Node `node:test` via `tsx --test`, `decimal.js` (new, only dependency added).

**Spec (binding):** `docs/superpowers/specs/2026-09-22-risk-core-and-ops-design.md`

## Global Constraints

- Never commit or stage (user's rule: ask first; no `Co-Authored-By`). Others also edit this repo: touch only what a task names.
- Functions ≤ 30 lines, files ≤ 300 lines, nesting ≤ 3, params ≤ 4, why-only comments, no `any`. `Orchestrator.ts` (288 lines), `client.ts` (295), `remoteBroker.ts` (299) must not grow past 300: extract into the new files allowed below.
- New source files allowed: `src/risk/{primitives,riskConfig,contractSpec,positionSizer,riskEngine,performanceEngine}.ts`, `src/ops/{eventStore,alerts,telegram,cards,killSwitch}.ts`, `src/runtime/opsHooks.ts`; new tests under `tests/`. Anything else: ask.
- **TUI stack is frozen**: no Ink/React/chalk changes, no new panels/rows; `tests/cockpit.test.ts` must pass unchanged (only additive tests). A visible text change must fit at `MIN_COLS`×`MIN_ROWS` with no `…`.
- Never read or print `.env` values (Telegram tokens). Tests never contact Telegram, Binance or the exchange; they never touch `data/paper-state.json`, `data/remote-state.json`, `data/events.jsonl` (use temp dirs).
- Reference sources (READ-ONLY, never modify): `/home/nemesis/projects/crypto-trading/crypto-agent`. Port with adaptation; keep their intent and invariants; convert their vitest tests to `node:test` (`assert.strict`), replacing `fast-check` property tests with seeded table-driven loops.
- Baseline before this plan: `npx tsc --noEmit` clean, `npm test` green (record count), fake E2E 24/24.

---

### Task 1: Risk config, circuit breaker, Decimal primitives, contract-spec adapter

**Files:** Create `src/risk/primitives.ts`, `src/risk/riskConfig.ts`, `src/risk/contractSpec.ts`; Modify `package.json` (+`decimal.js`), `src/config.ts` (new env), `.env.example`; Tests: `tests/riskConfig.test.ts`, `tests/contractSpec.test.ts`.
**Sources:** crypto-agent `src/domain/primitives.ts`, `src/domain/risk/risk-config.ts`, `risk-decision.ts`, `src/domain/futures/contract-spec.ts`, and their tests `test/kernel-risk-engine.test.ts` (circuit parts).
**Interfaces (Produces):**
```typescript
// primitives.ts
export const dec: (n: number | string) => Decimal; export function floorToStep(v: Decimal, step: Decimal): Decimal; export function ceilToStep(v: Decimal, step: Decimal): Decimal
// riskConfig.ts
export type CircuitState = 'NORMAL' | 'CAUTION' | 'REDUCED' | 'HALTED' | 'EMERGENCY'
export interface RiskLimits { maxRiskPerTradePercent: number; maxLeverage: number; minLeverage: number; maxDailyLossPercent: number; maxDrawdownPercent: number; maxLossStreak: number; maxConcurrentPositions: number; maxSymbolExposurePercent: number; maxPortfolioGrossExposurePercent: number; maxCorrelatedExposurePercent: number; maxNotionalPerTrade: number; minRiskRewardRatio: number; feeRateTaker: number; slippageBufferRate: number }
export function riskLimitsFromConfig(): RiskLimits           // from config.risk + new env, decisions 1 in the spec
export function deriveCircuitState(dailyLossPct: number, drawdownPct: number, lossStreak: number, limits: RiskLimits): CircuitState   // CAUTION 50%, REDUCED 75%, HALTED 100% of daily loss/streak, EMERGENCY 100% of drawdown
export function circuitRiskMultiplier(state: CircuitState): number   // NORMAL 1, CAUTION 0.75, REDUCED 0.5, HALTED/EMERGENCY 0
export const clusterOf: (symbol: string) => string           // majors (BTC/ETH) vs alts, ported from portfolio-state helpers
// contractSpec.ts
export interface ContractSpec { symbol: string; lotSize: number; minQuantity: number; maxQuantity: number; minNotional: number; tickSize: number; maxLeverage: number }
export function contractSpecFor(symbol: string, rules: SymbolRules, limits: RiskLimits): ContractSpec   // stepSize->lotSize, minQty->minQuantity, maxQuantity default 1e9, maxLeverage = limits.maxLeverage
```
New env (all optional, in `config.risk`): `MAX_DAILY_LOSS_PCT=3`, `MAX_LOSS_STREAK=4`, `MAX_CONCURRENT_POSITIONS=<symbols count>`, `MAX_SYMBOL_EXPOSURE_PCT`, `MAX_CORRELATED_EXPOSURE_PCT` (both default `MAX_EXPOSURE_PCT`), `MIN_RR=0`, `TAKER_FEE_RATE=0.0004`, `SLIPPAGE_BUFFER_RATE=0.0002`, `RISK_ENGINE=off|on` (default off). `config.ts` must stay ≤ 300 lines and keep the current validation style (zod v3).
- [ ] Step 1: read the crypto-agent sources; write failing tests: Decimal helpers floor/ceil to step (incl. float traps like 0.3/0.1); each circuit transition with hand-computed thresholds (e.g. limits daily 3 %, streak 4, drawdown 5 %: 1.4 % → NORMAL, 1.5 % → CAUTION, 2.25 % → REDUCED, 3 % → HALTED, drawdown 5 % → EMERGENCY, streak 2 → CAUTION, 3 → REDUCED, 4 → HALTED); multipliers; `contractSpecFor` mapping from a `SymbolRules`; `riskLimitsFromConfig` defaults (position count = symbols length) and overrides.
- [ ] Step 2: run → FAIL. Step 3: implement. Step 4: `npx tsc --noEmit`, focused tests, `npm test`.
- [ ] Checkpoint: no commit.

### Task 2: Position sizer

**Files:** Create `src/risk/positionSizer.ts`; Test `tests/positionSizer.test.ts`.
**Sources:** crypto-agent `src/engines/position-sizer.ts` (139) + `test/kernel-position-sizer.test.ts`, the sizing parts of `test/kernel-property-invariants.test.ts`.
**Interfaces:** `sizePosition(input: SizingInput): SizingResult` and `failedSizing(rejection)` exactly as in the source (`SizingInput`: equity, availableMargin, direction, entry, stop, requestedLeverage, fundingRate?, fundingPeriods?, spec: ContractSpec, limits: RiskLimits, circuitMultiplier). Numbers in, numbers out; Decimal internal.
- [ ] Failing tests: ported cases from `kernel-position-sizer.test.ts`; property loop (≥ 500 seeded random cases over entry 0.5–120 000, stop distance 0.2–8 %, lot steps 1e-3…1, both directions): `riskAmount ≤ budget × 1.02`, `quantity` a multiple of `lotSize`, `notional ≥ minNotional` or rejected, `notional ≤ cap`, `marginRequired ≤ availableMargin`, leverage ≤ min(limits, spec, requested), stop on the correct side else rejection; fee+slippage+funding widen `effectiveRiskPerUnit`; circuit multiplier 0 → rejected.
- [ ] Implement → tests → tsc → `npm test`. Checkpoint: no commit.

### Task 3: Performance engine + risk engine

**Files:** Create `src/risk/performanceEngine.ts`, `src/risk/riskEngine.ts`; Tests `tests/performanceEngine.test.ts`, `tests/riskEngine.test.ts`.
**Sources:** crypto-agent `src/engines/performance-engine.ts`, `src/engines/risk-engine.ts`, `src/domain/risk/risk-decision.ts`, `src/domain/portfolio/portfolio-state.ts` + tests `test/performance-engine.test.ts`, `test/kernel-risk-engine.test.ts`.
**Interfaces (Produces):**
```typescript
// performanceEngine.ts — no event-store dependency; rebuilt from our journal
export interface PerformanceSnapshot { dailyLossPercent: number; drawdownPercent: number; lossStreak: number; winStreak: number; realizedToday: number; profitFactor: number; expectancy: number }
export class PerformanceEngine { constructor(initialEquity: number, now?: () => number); hydrate(trades: TradeRecord[]): void /* idempotent, deterministic */; onEquity(equity: number): void; snapshot(equity: number): PerformanceSnapshot }
// riskEngine.ts
export interface PortfolioView { equity: number; openPositions: number; grossExposure: number; symbolExposure: (s: string) => number; clusterExposure: (c: string) => number; performance: PerformanceSnapshot }
export interface RiskInput { symbol: string; sizing: SizingResult; portfolio: PortfolioView; limits: RiskLimits; rr?: number }
export interface RiskDecision { approved: boolean; circuit: CircuitState; checks: { name: string; passed: boolean; detail: string }[]; reasons: string[] }   // named checks: circuit_breaker, sizing, risk_per_trade, leverage, position_count, daily_loss, loss_streak, portfolio_limits, min_rr (only if limits.minRiskRewardRatio > 0)
export function evaluateRisk(input: RiskInput): RiskDecision
```
Daily loss % uses realized PnL of the current UTC day relative to start-of-day equity (initial equity + realized before today); drawdown from the high-water mark of realized equity and current equity; streak counts consecutive losses from the newest trade (a win resets). `hydrate` must not double count if called twice with the same trades.
- [ ] Failing tests: streak/daily-loss/drawdown from a hand-built journal across two UTC days; hydrate idempotence; each risk check failing with its name and passing on the boundary; HALTED/EMERGENCY reject before any other check; exposure caps per symbol/cluster/gross; min_rr only when configured; approved decision lists all passed checks.
- [ ] Implement → tests → tsc → `npm test`. Checkpoint: no commit.

### Task 4: Wire the risk core (flag `RISK_ENGINE`) + cockpit note

**Files:** Modify `src/agents/RiskAgent.ts`, `src/agents/BaseAgent.ts` (`MarketContext.performance?`), `src/runtime/Orchestrator.ts` (stay ≤ 300: move helpers into `src/runtime/opsHooks.ts`), `src/runtime/telemetry.ts`, `src/types.ts` (`AgentState.note?: string`), `src/ui/accountPanels.ts` (render the note in the RISK-MGR-δ fleet row only when it fits), tests.
**Behavior:** with `RISK_ENGINE=off` `RiskAgent.gate` is byte-for-byte today's behaviour (golden test over a table of signals incl. the drawdown kill-switch). With `on`: the Orchestrator builds `ctx.performance` each loop from `binance.getTrades()` via `PerformanceEngine` (hydrated once at start, `onEquity` each loop); `gate` sizes with `sizePosition` (entry/SL from the signal, `requestedLeverage` = our dynamic leverage, funding from `ctx.funding`, spec from `contractSpecFor(symbolRules)`), evaluates `evaluateRisk`, and returns today's `RiskDecision` shape (`positionSizeUsdt = notional`, `leverage`, `reason` = failed check names or summary). `OPEN_HEDGE` keeps its notional path but must pass circuit/exposure checks. Circuit state → `AgentState.note` for `RISK-MGR-δ` (e.g. `CAUTION`, `HALTED daily 3.1%`), fleet row renders it only if it fits; also logged once per state change.
- [ ] Failing tests: golden flag-off equality; flag-on sizing example (equity 100 000, entry 100, stop 98, lot 0.001 → quantity by budget/effective risk); HALTED rejects entries with reason, exits unaffected (RiskAgent is entry-only); exposure/position-count rejections through `gate`; restart re-hydration (new engine + same journal ⇒ same snapshot); telemetry note; cockpit test: note renders without `…` at `MIN_COLS` and layout height unchanged; existing cockpit tests unchanged.
- [ ] Implement → focused tests → `tsc` → `npm test` → cockpit tests (also `SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT,AVAXUSDT`) → `npm run build` → `E2E_BACKEND=fake npm run e2e:paper-exchange`. Line audit: Orchestrator ≤ 300. Checkpoint: no commit.

### Task 5: Audit trail + alert engine

**Files:** Create `src/ops/eventStore.ts`, `src/ops/alerts.ts`; Tests `tests/eventStore.test.ts`, `tests/alerts.test.ts`.
**Sources:** crypto-agent `src/infrastructure/events/event-store.ts`, `src/domain/alerts/types.ts`, `src/engines/alerts/{notification-engine,subscriptions,make-alert}.ts` + tests `test/kernel-event-store-durability.test.ts`, `test/notification-engine.test.ts`.
**Interfaces (Produces):**
```typescript
export interface AuditEvent { id: string; at: number; type: string; decisionId?: string; symbol?: string; payload: Record<string, unknown> }
export class EventStore { constructor(filePath: string, opts?: { maxBytes?: number; now?: () => number }); append(e: Omit<AuditEvent, 'id' | 'at'> & { at?: number }): void /* never throws */; readTail(n: number): AuditEvent[] }   // JSONL, rotation to <file>.1 at maxBytes, corrupt lines skipped
export type AlertClass = 'SYSTEM'|'MACRO'|'MARKET'|'LEVEL'|'SETUP'|'SIGNAL'|'TRADE'|'RESEARCH'; export type AlertSeverity = 'INFO'|'WATCH'|'IMPORTANT'|'SIGNAL'|'CRITICAL'
export interface AlertEvent { id: string; at: number; class: AlertClass; severity: AlertSeverity; symbol?: string; title: string; body: string; fingerprint: string; stateFrom?: string; stateTo?: string; payload: Record<string, unknown> }
export class NotificationEngine { constructor(subs?: AlertSubscriptions, opts?: { cooldownMs?: Partial<Record<AlertClass, number>>; now?: () => number }); submit(e: AlertEvent): { action: 'emitted' | 'suppressed'; reason?: string; event: AlertEvent } }
export function defaultSubscriptions(): AlertSubscriptions; export function parseSubscriptions(json: unknown): AlertSubscriptions; export function makeAlert(partial: ...): AlertEvent
```
- [ ] Failing tests (ported + ours): append/readTail order, rotation at cap, corrupt tail ignored, write to an unwritable path does not throw; dedupe inside cooldown and re-emit after it, per-class cooldowns (SIGNAL/TRADE 0), class/symbol/severity subscription rejection, SYSTEM CRITICAL never suppressed, `parseSubscriptions` rejects garbage safely (defaults).
- [ ] Implement → tests → tsc → `npm test`. Checkpoint: no commit.

### Task 6: Telegram sender and cards

**Files:** Create `src/ops/telegram.ts`, `src/ops/cards.ts`; Tests `tests/telegram.test.ts`, `tests/cards.test.ts`.
**Sources:** crypto-agent `src/notifications/{telegram,signal-telegram,alert-telegram}.ts` + `test/alert-format.test.ts`, `test/council-telegram.test.ts`.
**Interfaces:** `escapeHtml`, `telegramConfigured(env?)`, `sendTelegram(text, opts: { channel?: 'alert' | 'trading'; silent?: boolean }, deps?: { fetchImpl?; env?; dryRun?; log? }): Promise<boolean>` (POST `sendMessage`, `parse_mode HTML`, 10 s `AbortSignal.timeout`, returns false and never throws, `TELEGRAM_DRY_RUN=1` logs the card instead), card formatters in `cards.ts`: `tradeCard(TradeRecord | fill info)`, `systemCard(...)`, `signalCard(...)`, `digestCard(summary)`, each returning an HTML string ≤ 3 500 chars (truncate with `…`), values formatted with `formatPrice`/`formatQty` (symbolRules), IST timestamps as crypto-agent does.
- [ ] Failing tests with an injected `fetchImpl`: unconfigured → false, no call; configured → correct URL/body (channel token resolution order `TELEGRAM_TRADING_BOT_TOKEN` → `TELEGRAM_BOT_TOKEN` for `trading`, `TELEGRAM_ALERTBOT_BOT_TOKEN` → `TELEGRAM_BOT_TOKEN` for `alert`), HTML escaped, silent → `disable_notification`, timeout/reject/non-200 → false, dry-run logs and returns true without fetch; cards: exact expected strings for a TP exit (PnL, R multiple), a venue-down system card, a digest.
- [ ] Implement → tests → tsc → `npm test`. Checkpoint: no commit.

### Task 7: Kill-switch, audit + alert wiring, digest, config/docs

**Files:** Create `src/ops/killSwitch.ts`, `src/runtime/opsHooks.ts` (if not already from Task 4); Modify `src/runtime/Orchestrator.ts` (≤ 300), `src/agents/RiskAgent.ts`, `src/ui/App.tsx` (key `k` + help line only), `src/config.ts`, `.env.example`, `README.md`; Tests `tests/killSwitch.test.ts`, `tests/opsHooks.test.ts`, `tests/app.keys.test.ts` (if testable) .
**Behavior:** `KillSwitch` (`{ halted, reason, at }`, persisted `data/kill-switch.json`, `toggle(reason)`, `isHalted()`); `RiskAgent.gate` refuses every OPEN while halted (reason `kill-switch: <reason>`), also when the circuit is HALTED/EMERGENCY; exits/closes are never blocked. `opsHooks.ts` exposes `createOps(config, deps)` returning `{ onSignal, onGate, onVeto, onOrder, onExit, onVenueState, onCircuit, onLoopCrash, digest }` that (a) append AuditEvents with the signal's `decisionId`, (b) map events to `AlertEvent`s and send via `NotificationEngine` + `sendTelegram` (TRADE: fill/flip/SL/TP/liquidation; SYSTEM: venue degraded/down/recovered, ws down, loop crash, circuit change, kill-switch; SIGNAL: entry accepted/refused/vetoed) with fingerprints for dedupe; all wrapped so no exception can escape into the loop. `Orchestrator` calls the hooks at the existing seams (`processSignals`, `logExits`, venue status change, loop catch) and starts a daily digest timer (00:05 UTC) that sends `digestCard` from the journal. Flags: `AUDIT`, `ALERTS` (off ⇒ the hooks are no-ops). TUI key `k` toggles the kill-switch and logs it; help line updated; footer shows nothing new unless the word `halted` fits (optional).
- [ ] Failing tests: kill-switch persistence/toggle/gate refusal + exit unaffected; hook mapping (each event → the expected alert class/severity/fingerprint; dedupe of repeated venue-down; audit lines share one `decisionId` from signal to exit; failures in `sendTelegram`/`EventStore` never propagate); digest numbers equal journal-derived stats; flag off ⇒ no file written, no fetch.
- [ ] Implement → focused tests → `tsc` → `npm test` → cockpit tests → `npm run build` → fake E2E. Line audit. Docs: README section (flags, files written, Telegram env names, dry run, `k` key) and `.env.example`.
- [ ] Checkpoint: no commit.

### Task 8: Verification and final review (controller)
- [ ] `tsc`, `npm test`, build, cockpit tests at both sizes and with the AVAX symbol set, fake E2E 24/24, real E2E (`E2E_BACKEND=real` on throwaway `e2e-*` accounts, synthetic symbols only), headless Orchestrator run on live prices with `RISK_ENGINE=on AUDIT=on ALERTS=on TELEGRAM_DRY_RUN=1` on a throwaway account (verify audit lines with one `decisionId`, dry-run cards logged, circuit note, exits unaffected), file/function-length audit.
- [ ] Final whole-change review on the strongest model, one fix wave, one scoped re-review. Report what to paste into `.env` for real Telegram messages.
