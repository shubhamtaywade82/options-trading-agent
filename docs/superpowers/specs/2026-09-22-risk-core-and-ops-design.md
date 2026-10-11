# Risk + sizing core and ops (audit trail + Telegram), ported from crypto-agent

Date: 2026-09-22 · Status: scope approved by the user (approved plan `binary-marinating-crab`: "Phase 1 risk+sizing core" and "Phase 2 ops: audit trail + Telegram alerts", executed together);
open decisions were answered by the controller (below). Phases 3 (market-structure signals) and 4 (LLM roles) are out of scope here.

## Goal
Bring the proven pieces of `/home/nemesis/projects/crypto-trading/crypto-agent` (read-only source) into this repo **without touching the TUI stack**:
(1) a Decimal position sizer and a graded circuit breaker + risk engine with daily-loss, loss-streak, position-count and exposure caps, fed by a performance
engine that survives restarts; (2) an append-only JSONL audit trail with a `decisionId` per signal, and a Telegram alert system (taxonomy, subscriptions, dedupe/cooldown, HTML cards, digest, kill-switch).

## Decisions (controller; all flag-gated, default off)
1. **Limits keep our current values** (`config.risk`: 1 % risk/trade, leverage 5–10, drawdown 5 %, exposure 80 %, liq buffer 2 ATR). New limits get workable defaults instead of `crypto-agent`'s prop-firm ones:
   `MAX_DAILY_LOSS_PCT=3`, `MAX_LOSS_STREAK=4`, `MAX_CONCURRENT_POSITIONS=<number of config.symbols>`, `MAX_SYMBOL_EXPOSURE_PCT=maxExposurePct`, `MAX_CORRELATED_EXPOSURE_PCT=maxExposurePct`, `MIN_RR=0` (our strategies' R:R is < 1 for Adaptive; the R:R check is disabled unless set).
2. **Circuit states** derive from those limits: CAUTION at 50 % of a limit, REDUCED at 75 %, HALTED at 100 % of daily loss or loss streak, EMERGENCY at 100 % of max drawdown (port `deriveCircuitState` / `circuitRiskMultiplier` and parametrize by limits).
3. **`RISK_ENGINE=off|on`** (default `off`): off = today's `RiskAgent` behaviour unchanged (including the existing drawdown kill-switch); on = the ported sizer + engine decide. **`ALERTS=off|on`** and **`AUDIT=off|on`** likewise (default off). Dry-run: `TELEGRAM_DRY_RUN=1` prints the card to the log instead of sending.
4. **Decimal only inside the risk module** (numbers in, numbers out); the rest of the repo keeps `number`. Add `decimal.js` (^10.4) as the only new dependency. No zod upgrade, no Ink/React change.
5. **TUI**: no new panels/rows. Circuit state text goes into the existing RISK-MGR-δ fleet row (`AgentState.note?: string`, rendered only if it fits) and into the log; optional `alerts ●on|off` word in the footer only if it fits at `MIN_COLS`. `tests/cockpit.test.ts` guard tests stay green unchanged.
6. **Secrets**: the implementers never read `.env` values; Telegram credentials are pasted by the user (same env names as crypto-agent: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_TRADING_BOT_TOKEN`, `TELEGRAM_ALERTBOT_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).
7. **Source of truth for inputs**: equity/positions from the venue (`ctx.equity`, `ctx.positions`), trade outcomes from the journal (`BinanceService.getTrades()` — local `closedTrades` or remote sidecar). The performance engine is rebuilt from the journal at startup so a restart cannot reset the governor.

## Components
### Phase 1 — `src/risk/` (new; ports with adaptation, all functions ≤ 30 lines, files ≤ 300 lines)
Sources in crypto-agent (read them, do not modify): `src/domain/primitives.ts` (Decimal helpers), `src/domain/risk/risk-config.ts`, `risk-decision.ts`, `src/domain/futures/contract-spec.ts`, `src/domain/portfolio/portfolio-state.ts` (cluster helpers), `src/engines/position-sizer.ts`, `src/engines/risk-engine.ts`, `src/engines/performance-engine.ts`, optionally `risk-reservations.ts`, `leverage-policy.ts` (skip unless trivially portable).
- `primitives.ts`, `riskConfig.ts` (limits + `deriveCircuitState`, `circuitRiskMultiplier`, built from `config.risk` + new env), `contractSpec.ts` (adapter `ContractSpec` ← `SymbolRules`, plus `maxQuantity`/`maxLeverage` from config defaults), `positionSizer.ts` (fee/slippage/funding/lot/min-qty/min-notional/cap/margin sizing), `riskEngine.ts` (`evaluateRisk` with checks: sizing, risk-per-trade, leverage, position count, daily loss, loss streak, exposure caps; freshness check dropped or fed by our `MarketContext` timestamp), `performanceEngine.ts` (UTC-day PnL, loss/win streak, HWM drawdown, profit factor, expectancy; `hydrate(trades)`; snapshot).
- Wiring (behind `RISK_ENGINE=on`): `Orchestrator` builds `ctx.performance` (`{ dailyLossPercent, drawdownPercent, lossStreak, circuit }`) from the journal each loop; `RiskAgent.gate` sizes with the ported sizer using the signal's entry/SL, our dynamic leverage as `requestedLeverage`, funding rate from `ctx.funding`, spec from `symbolRules`; the engine can reject with named checks; `OPEN_HEDGE` keeps its notional path but passes the circuit/exposure checks. Decision text (reason) lists the failed check. `ExecutorAgent` still rounds/validates (sub-lot/min notional) as a second guard.
- Circuit state exposed through telemetry as `AgentState.note` for RISK-MGR-δ (e.g. `CAUTION 62% daily`), never as a new row.
### Phase 2 — `src/ops/` (new)
Sources: `src/domain/alerts/types.ts`, `src/engines/alerts/{notification-engine,dispatcher,subscriptions,make-alert,trade-monitor,system-monitor,research-reporter}.ts`, `src/notifications/{telegram,signal-telegram,alert-telegram}.ts`, `src/infrastructure/events/event-store.ts`, `src/security/kill-switch.ts`.
- `eventStore.ts`: append-only JSONL (`data/events.jsonl`, size-capped rotation `events.jsonl.1`), typed events `{ id, at, type, decisionId?, symbol?, payload }`, `readTail(n)`; never throws into the loop. `decisionId` minted when a signal is produced (`Signal.id` reuse) and carried through gate → veto → order → exit → journal.
- `alerts.ts`: taxonomy (8 classes × 5 severities), `AlertEvent`, `NotificationEngine` (subscriptions, fingerprint dedupe, per-class cooldown, suppression reasons), `defaultSubscriptions`/`parseSubscriptions` (JSON at `NOTIFICATIONS_PATH`, default `data/notifications.json`).
- `telegram.ts`: sender (HTML escape, 10 s timeout, silent flag, `alert`/`trading` channels, no-op when unconfigured, dry-run), card formatters: TRADE (fill/flip/SL/TP/liquidation with PnL and R), SYSTEM (venue degraded/down/recovered, loop crash, ws down, circuit change, kill-switch), SIGNAL (entry with regime/RR/size, veto), daily DIGEST (PnL, trades, win rate, drawdown, top refusal reasons).
- `killSwitch.ts`: state `{ halted, reason, at }` persisted in `data/kill-switch.json`; when halted `RiskAgent` refuses every OPEN (exits still work); toggled by TUI key `k` (added to `App.tsx` key handler and the `?` help line; no layout change) and by the circuit reaching HALTED/EMERGENCY (auto).
- Wiring: `Orchestrator` publishes audit events + alerts at the existing seams (`processSignals`, `logExits`, venue status changes, circuit changes, loop crash); a daily digest timer at 00:05 UTC. Everything is `try/catch`-isolated: an alert or audit failure must never affect trading.

## Scenario checklist (each is a test)
Sizer: risk ≤ budget at any stop distance; lot alignment; below-min-qty and below-min-notional handling (bump vs reject); fees/slippage/funding widen the stop; notional cap; margin/leverage cap.
Circuit: NORMAL→CAUTION→REDUCED→HALTED→EMERGENCY transitions from daily loss / streak / drawdown; risk multiplier applied; HALTED refuses entries but exits still pass; restart re-hydrates from the journal (no reset).
Engine: each named check rejects with its name; exposure caps on symbol/gross/cluster; position-count cap; flag off = identical decisions to today's `RiskAgent` (golden test on a signal table).
Audit: events appended in order with one `decisionId` per signal; rotation at the cap; corrupt tail line ignored; write failure does not throw.
Alerts: dedupe by fingerprint inside cooldown; severity/class/symbol subscriptions; SYSTEM CRITICAL never suppressed; card HTML is escaped; unconfigured/dry-run never sends; timeout/failed send returns false and never throws; digest numbers equal the journal's.
TUI: cockpit guard tests unchanged; RISK-MGR-δ note renders without `…` at `MIN_COLS`; `k` key toggles the kill-switch and refuses entries.

## Out of scope
Market-structure signals, LLM roles, risk-reservations across concurrent pipelines (our loop is single-flight), per-strategy analytics UI, HTTP/MCP surfaces.
