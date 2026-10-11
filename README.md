# crypto-trading-agent

A TypeScript agent for Binance USD-M perpetual futures. Multi-strategy signal
generation, risk gating, an optional Ollama LLM veto layer, and a TUI cockpit
built on Ink. Routes orders to either a local in-memory paper engine, a remote
`paper_exchange` Rails broker (over HTTP), or live Binance.

---

## ⚡ MiniCPM-2B Autonomous 24/7 Trading Fleet

A dedicated, real-time autonomous trading system powered by local **`openbmb/minicpm5-2b:latest`** (Ollama) and Binance WebSocket feeds.

* **Full Guide & Documentation**: [docs/MINICPM_TRADING_FLEET.md](docs/MINICPM_TRADING_FLEET.md)
* **Macro Anchor**: `BTCUSDT` is used strictly as a market context anchor (trend, momentum, 24h delta) to guide trades on `ETHUSDT`, `SOLUSDT`, and `XRPUSDT`.
* **Capital & Sizing**: **$1,000.00 account** with **$980.00 margin** per position at **10x isolated leverage** ($9,800 notional). The remaining $20.00 (2%) is held in cash to prevent order rejection from exchange taker fees.
* **Profit Target**: Mandatory minimum **$\ge 5\%$ return on capital** ($\ge 0.5\%$ price distance from entry) and minimum $R/R \ge 1.5$.
* **Exits**: Evaluated and triggered **instantly on real-time sub-second WebSocket ticks**.
* **Launch Command**:
  ```bash
  npx tsx scripts/run-minicpm-fleet.ts
  ```

---

## Modes

| `MODE` | Backend | SL/TP/trailing exits | Per-strategy attribution |
| --- | --- | --- | --- |
| `paper` (default, no `PAPER_EXCHANGE_URL`) | Local in-memory `PaperEngine` | Agent-side, checked on every price tick | Yes (positions keyed by `symbol+strategy`) |
| `paper` + `PAPER_EXCHANGE_URL` | Remote `paper_exchange` Rails broker via `RemoteBroker` | Agent-side reduce-only market orders (the broker never evaluates resting orders and has no price feed). Liquidation, fees and funding are exchange-side | Yes: one account, a symbol is owned by the strategy that opened it |
| `live` | Live Binance | Exchange-side STOP_MARKET / TAKE_PROFIT_MARKET | No — Binance positions are per-symbol |

**A CoinDCX live-execution migration is in progress but not live yet.** `src/coindcx/coindcxClient.ts`
already implements a full `ExchangeApi` adapter for CoinDCX, but it is not wired into `BinanceService` —
`MODE=live` still executes exclusively through `BinanceService.submitLiveOrder()` (raw Binance) exactly as
the table above describes, and only needs `BINANCE_API_KEY`/`BINANCE_API_SECRET` to start. An earlier commit
added a startup check requiring `COINDCX_API_KEY`/`COINDCX_API_SECRET` for `MODE=live` even though nothing
used them yet; that check has been removed (see issue #31) until the wiring
(`docs/superpowers/plans/2026-09-22-coindcx-live-execution.md`, Task 5) actually lands — finishing it needs
the private `@nemesis-oss/coindcx-sdk` package (a `file:` dependency never added to `package.json`), which
isn't published anywhere a CI runner or a fresh clone can install it from.

---

## Quick start

```bash
git clone https://github.com/shubhamtaywade82/crypto-trading-agent.git
cd crypto-trading-agent
cp .env.example .env   # then edit .env for your risk limits
npm install
npm run build
npm start
```

The cockpit needs at least 160×53 terminal cells (`MIN_COLS` x `MIN_ROWS` in `src/ui/panels.tsx`). Use `?` inside the cockpit
for the command cheatsheet.

---

## Backtesting

```bash
npx tsx scripts/backtest.ts --symbol BTCUSDT --days 30 --funding
```

Fetches public Binance USD-M klines and replays the **same** strategy agents, regime routing, signal fusion,
risk gate and execution-quality gate the orchestrator runs each cycle — only the market and execution adapters
differ. The replay is strict about causality: decisions taken at a bar close see only candles that had closed by
then, and fill at the next bar's open with half-spread, slippage and taker fees; intrabar exits resolve
stop-before-target (conservative), and stops that gap through the open fill at the open. Funding payments
settle on their boundaries when `--funding` is passed.

The report covers expectancy, profit factor, Sharpe/Sortino, CVaR, MAE/MFE, fees/funding/slippage and
research slices by strategy, regime, symbol and evidence bucket (does a high setup grade actually earn
more?). Pass `--decisions data/backtest-decisions.jsonl` to keep the decision journal produced by the run —
every decision carries the evidence it was taken on and, once closed, its realized outcome.

The replay also runs the **learning loop** the orchestrator runs each cycle: closed trades grade into the
per-agent stats of an in-memory agent ledger, and collected signals are confidence-adjusted from those
stats exactly like the live `collectSignals` path. The ledger is never written to disk, so one replay never
trains another (or the live bot); set `learning: false` in the replay config to A/B against the pre-learning
behaviour. The run's final per-agent stats (trades graded, wins, total R) come back on
`ReplayResult.agentStats`.

### Parameter sweeps

```bash
npm run sweep:struct-liq -- --symbols BTCUSDT,ETHUSDT --days 45
```

A parameter-sensitivity harness for the STRUCT-LIQ setup (`src/backtesting/StructLiqSweep.ts`): it
rebuilds the MarketState history with the same no-lookahead discipline as the replay engine and evaluates
the setup over a grid of `maxSweepAgeCandles` x `minimumRewardRisk` values, reporting distinct setups
(what cooldowns would turn into trades), emissions, and each cell's delta versus the default thresholds.
Pass `--fleet 6:1.5,24:1.0` to also run full fleet replays at chosen combos and see which fires survive
routing, fusion, risk and execution. A 45-day BTC+ETH sweep answered the firing-rate question directly:
the sweep-age window showed **zero** sensitivity (6 -> 96 candles admitted no new setups at any RR level)
while the reward-risk floor is the binding constraint (1.5 -> 1.0 doubles, -> 0.8 triples the setups;
removing it entirely admits 12x — the diagnostic ceiling of every other gate combined).

See `src/backtesting/` and `tests/replayService.test.ts` for the engine itself.

---

## Decision lineage

Every gated signal leaves a `DecisionRecord` in an append-only JSONL journal (`DECISIONS_PATH`, default
`data/decisions.jsonl`): the market state it saw, the deterministic evidence rubric and the composite score,
planned levels, the risk verdict, execution friction, and the realized outcome once the position closes. The
record is written in the same shape by the paper, live and replay paths (`src/decision/CandidateFlow.ts`),
and closed trades resolve back to their decision through the `decisionId` carried by the venue. The trade
grader scores against this stored evidence instead of a neutral placeholder, so "which conditions produced
profitable decisions?" becomes an empirical question:

```
cat data/decisions.jsonl | jq 'select(.outcome != null) | {score: .evidence.score, r: .outcome.rMultiple}'
```

---

## Risk state that survives restarts

The drawdown kill-switch measures against a persisted, mode-keyed equity high-water mark
(`data/risk-hwm.json`, atomic writes): a process crash mid-drawdown no longer resets the peak and silently
re-arms the bot. The same peak seeds the circuit-breaker's `PerformanceEngine`, so both drawdown views read
one authority.

**Resetting it.** After a long drawdown every entry is refused with `drawdown kill-switch` until equity recovers. To start a
fresh baseline on purpose (stop the agent first, it keeps the peak in memory):

```bash
npx tsx scripts/reset-risk-hwm.ts            # dry run: shows the stored peak and what would change
npx tsx scripts/reset-risk-hwm.ts --confirm  # backs up data/risk-hwm.json, then resets (paper by default)
npx tsx scripts/reset-risk-hwm.ts --mode live --confirm --allow-live   # a live account needs both flags
```

The reset forgets the stored peak **and** stamps a reset time that the circuit breaker also honours: realized peaks in the
closed-trade journal from before it stop counting, otherwise `EMERGENCY` would persist off the journal alone. The next equity
reading becomes the new peak. The daily-loss and loss-streak limits are not reset, and the trade journal is untouched.

---

## Position manager & market safety

**Market safety (entries only).** Every cycle each symbol gets a verdict (`src/market/MarketSafety.ts`):
`NORMAL`, `NO_ENTRY` or `HALT`. `RiskAgent.gate` rejects `OPEN_*` signals unless the symbol is `NORMAL` (reason
`safety <level>: …`, journaled like any rejection). Rules: mark missing/invalid or exchange status not `TRADING` → HALT;
websocket silent > `SAFETY_TICK_STALE_MS` → NO_ENTRY (HALT if the REST mark is stale too); stale 15m candle or derivatives
→ NO_ENTRY; **shock** → NO_ENTRY. Shock (`src/market/ShockDetector.ts`) is a 1m return z-score ≥ `SHOCK_RETURN_Z` confirmed
by a volume z-score or a spread blow-out, left only after `SHOCK_RECOVERY_BARS` calm bars. The gate never closes anything:
a protected position keeps its stop and its manager through a bad feed. Replay has no tick feed, so the gate does not apply there.

**Status: off by default (`POSITION_MANAGER=off`), because replay does not support turning it on.** 90-day replays of the
whole fleet on real Binance klines (BTC, ETH, SOL; the last 90 days and the 90 before them; `scripts/pm-sweep.ts`, data from
`--source archive`), pooled, net of fees and slippage:

| Exit management | Trades | Win % | E[R] | Net PnL (USDT) | vs off |
| --- | --- | --- | --- | --- | --- |
| off (fixed stop / target) | 227 | 29.9 | -0.248 | -184.6 | n/a |
| 35% @ 1R, then breakeven + trail (the original default) | 334 | 44.9 | -0.271 | -280.8 | -96.2 |
| 35% @ 1R only, original stop / target | 271 | 31.4 | -0.231 | -192.2 | -7.6 |
| 35% @ 1.5R only | 247 | 31.6 | -0.230 | -200.7 | -16.0 |
| breakeven + trail only after TP2 | 302 | 34.1 | -0.266 | -256.9 | -72.3 |
| wide trail (4 / 5 / 6 ATR) | 293 | 44.7 | -0.294 | -296.3 | -111.7 |

It raises the win rate (30% -> 45%) and cuts the winners; the breakeven + trail is what costs money, partials alone are about
neutral. It also frees the symbol sooner, which lets a fleet with negative expectancy (E[R] about -0.25 here) re-enter more often.
The result is the same in both windows. Treat it as a measured "no" for these exits on this fleet, not as a verdict on trailing in
general: fix the entries first (the fleet loses with or without it), then re-run `pm-sweep` before switching it on.

**Position manager (paper and remote paper_exchange).** `src/position/PositionManager.ts` is a pure state machine
(`INITIAL → PROTECTED → TRAILING`) driven by every price tick (250 ms) through `PositionDriver`, with ATR/structure inputs
cached per 8 s cycle. The entry strategy still owns the initial stop; the manager only ratchets it toward price.

| Step | Rule |
| --- | --- |
| TP1 | at +`PM_TP1_R` close `PM_TP1_FRACTION` of the entry quantity, arm breakeven at `entry ± entry × 2(fee+slippage)` |
| TP2 (RUNNER) | at +`PM_TP2_R` close `PM_TP2_FRACTION`, drop the fixed target (`serverTp = 'trail'`) |
| Trail | `max(extreme − k·ATR, protected 15m swing ∓ 0.15 ATR, SuperTrend)`, k = 2 / 2.5 / 3.2 by volatility class, never closer than 0.25 ATR to the mark, ratchet only |
| TARGET mode | the signal target stays the final exit (mean reversion always; any signal with TP ≤ 2R) |

A partial below the exchange lot/notional minimum, or one that would leave a remainder below it, is skipped (logged);
a failed or refused partial is retried on the next tick; through a `paper_exchange` outage a partial stays queued under one
client order id. State is persisted in `data/position-manager.json`; a position that changed outside the manager
(scale-in, restart) is rebuilt from the venue (a stop already at/over entry rebuilds as `PROTECTED` with TP1 taken).
**Live Binance** keeps its exchange-side STOP_MARKET / TAKE_PROFIT_MARKET (`closePosition`) orders by default;
`updateStops` now re-places the take-profit it used to drop. `LIVE_POSITION_MANAGER` (needs `POSITION_MANAGER=on`) adds the manager there:

| Value | Behaviour |
| --- | --- |
| `off` (default) | Exchange-side stops only, exactly as before. |
| `shadow` | Runs the manager on the live feed and **logs what it would do** (`SHADOW would reduce …`, `SHADOW would move … stop`) against an in-memory overlay. Sends no orders. State goes to `data/position-manager-shadow.json`. Run this first. |
| `on` | Sends real reduce-only market partials and replaces stop orders. |

How `on` stays safe (`src/binance/liveBook.ts`, entries recorded in `data/live-state.json`): the client library cannot edit a
conditional order, so a stop move is *cancel the old stop by id → place the new one (3 tries) → if that fails restore the previous
stop → if that fails close at market*; a failed cancel aborts and leaves the old stop standing. Partials use
`newOrderRespType: RESULT` and the manager counts only the executed quantity. Every cycle the book reconciles with the exchange and
**re-places a stop that has disappeared** (closing the position if it cannot). Positions it has no recorded entry for are left alone.
One-way position mode only. **This path is covered by a fake-exchange test suite, not by the real exchange**: run `shadow`, then
`on` with a small size, and watch the first trades. Also verify against Binance's current changelog that STOP_MARKET /
TAKE_PROFIT_MARKET `closePosition` orders are still accepted on `/fapi/v1/order` (the installed `binance` client, 2.15.22, has no
separate conditional-order API, so the existing entry protection depends on it too).

Partial legs are journaled as `PARTIAL TP` with `partial: true`. Everything that counts *positions* folds them into their
final close (`src/position/foldPartials.ts`): the learning ledger and confidence adjuster grade one blended R per position,
loss/win streaks and expectancy count positions, replay metrics report one trade per position (`result.partials` holds
the legs). Realized PnL sums, daily loss and drawdown still use every leg on its own day.

**Adaptive size.** The risk budget is `equity × RISK_PER_TRADE_PCT × circuit × volatility × score`; both new factors only
shrink it (ATR percentile ≥ 60/80/95 → ×0.75/0.5/0.25; evidence score < 75/65 → ×0.75/0.5). The stop distance still sets
the quantity, so leverage never sets the risk. A `portfolio_risk` check additionally caps the summed loss-at-stop of all open
positions plus the new trade at `MAX_PORTFOLIO_RISK_PCT` of equity (a stop at/over breakeven counts 0).

**Backtesting the manager.** `npx tsx scripts/backtest.ts --symbol BTCUSDT --days 30 --position-manager off|on` A/B-tests it.
The bar is walked adverse-extreme first (open → low → high → close for a long): stop/liquidation, then partials and stop
moves at the favourable extreme, then the remaining target, and a stop moved on a bar is tested against that bar's close — so a
stop move never helps a trade on the bar that produced it. Partials fill at their level (at the open on a gap); manager
inputs are the features of the last *closed* bar.

---

## Regime model: classic vs scored

`REGIME_MODEL=scored` (`src/market/RegimeScoring.ts`) keeps the six labels but scores a trend 0..1 (ADX, EMA slope, EMA alignment,
VWAP side, gated by the 1h direction), enters a trend at >= `REGIME_TREND_ENTER` and keeps it until < `REGIME_TREND_EXIT`, and
only adopts a different label after `REGIME_CONFIRM_BARS` closed bars. It exists because the classic classifier flips
TREND <-> TRANSITION every time ADX crosses 25 and the strategy router follows that label.

Replay of the same fleet on real klines (BTC, ETH, SOL; `npx tsx scripts/pm-sweep.ts --study regime`), net PnL in USDT:

| Regime model | Older 90d | Last 90d | Pooled (trades) |
| --- | --- | --- | --- |
| classic | -81.5 | -104.7 | -186.1 (227) |
| scored, confirm 1 bar | -25.2 | -123.6 | -148.8 (261) |
| scored, confirm 2 bars | -39.0 | -109.0 | -148.0 (223) |
| scored, confirm 3 bars | -22.0 | -102.1 | -124.1 (276) |
| scored, confirm 2, enter .60 / exit .45 | -11.3 | -114.8 | -126.1 (246) |

Pooled, every scored variant is better, but all of the gain is in the older window; in the last 90 days most are slightly worse, and
by symbol the sign flips (BTC gains where SOL loses). With about 250 trades at roughly +-5 USDT each the noise on these sums is
around +-80, so the difference is not distinguishable from chance. It stays opt-in until a longer or out-of-sample run says otherwise.

**What the sweeps do show**: the fleet loses money in both windows whatever the regime model or exit management (E[R] about -0.25
after fees and slippage; on BTC roughly 40% of the loss is fees plus slippage and the rest is negative gross edge). Neither of these
layers is the problem; the entries are.

---

## Configuration

All configuration is via environment variables (validated with `zod` in
`src/config.ts`). The defaults shown below are the schema defaults, NOT
necessarily what's in `.env.example` — they were inconsistent before issue #9
was fixed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MODE` | `paper` | `paper` or `live` |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | (empty) | Required for `MODE=live` (market data always, and today's only order execution path) |
| `COINDCX_API_KEY` / `COINDCX_API_SECRET` / `COINDCX_PAPER_MODE` / `COINDCX_QUOTE_PREFERENCE` / `COINDCX_MAX_ORDER_NOTIONAL` / `COINDCX_MAX_ORDER_QUANTITY` / `COINDCX_INITIAL_BALANCE` | see `.env.example` | Optional, reserved for the CoinDCX execution path (see "Modes" above and issue #31); not required to start `MODE=live`, and currently unused even when set |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama daemon URL (`https://ollama.com` for cloud). All LLM calls go through [`@nemesis-oss/ollama-sdk`](https://github.com/shubhamtaywade82/ollama-sdk); JSON mode (`format: "json"`) is requested only from local hosts because the SDK refuses `format` requests against cloud endpoints, so elsewhere the prompts demand JSON and replies are parsed tolerantly (code fences / prose around the object) |
| `OLLAMA_MODEL` | `gemma4:31b` | Model used for veto/advise/ask |
| `MIN_LEVERAGE` | `5` | Floor for the dynamic-leverage calculation |
| `MAX_LEVERAGE` | `10` | Ceiling for the dynamic-leverage calculation |
| `MAX_EXPOSURE_PCT` | `80` | Cap on notional as a % of equity |
| `RISK_PER_TRADE_PCT` | `1` | Risk budget per trade as a % of equity |
| `LIVE_POSITION_MANAGER` | `off` | `off` / `shadow` / `on`: the position manager on live Binance, see [Position manager](#position-manager--market-safety) |
| `POSITION_MANAGER` | `off` | Partials + breakeven + adaptive trail (paper / remote paper; live via `LIVE_POSITION_MANAGER`). **Off by default: it did not beat the fixed stop/target in replay**, see [Position manager](#position-manager--market-safety) |
| `MAX_PORTFOLIO_RISK_PCT` | `3` | Cap on summed loss-at-stop of open positions + the new trade, % of equity |
| `SAFETY` | `on` | Market-safety / shock gate on new entries |
| `MAX_DRAWDOWN_PCT` | `5` | **Kill-switch** (issue #10): once drawdown from session peak exceeds this, all OPEN signals are rejected until recovery |
| `MIN_LIQ_BUFFER_ATR` | `2` | Minimum SL distance as a multiple of ATR(14) |
| `SYMBOLS` | `BTCUSDT,ETHUSDT,SOLUSDT,AVAXUSDT` | Universe |
| `STRUCT_LIQ` | `on` | `off` removes the STRUCT-LIQ-η agent from the fleet (shown paused in the cockpit) |
| `STRUCT_LIQ_MAX_SWEEP_AGE_CANDLES` | `6` | How old (15m candles) the STRUCT-LIQ trigger sweep may be |
| `STRUCT_LIQ_MIN_REWARD_RISK` | `1.5` | Minimum reward:risk the STRUCT-LIQ target liquidity must offer |
| `REGIME_MODEL` | `classic` | `scored` = trend score + hysteresis + dwell time (`REGIME_CONFIRM_BARS`, `REGIME_TREND_ENTER`, `REGIME_TREND_EXIT`); labels unchanged, adds `confidence`, `rawRegime`, `barsInRegime` to the snapshot. **Off by default: not shown to help**, see [Regime model](#regime-model-classic-vs-scored) |
| `SETUP_MIN_REWARD_RISK` | `1.5` | Gross reward:risk a Telegram setup scenario must offer to be built at all (was a hard-coded 1.25); the quality gate then re-checks it after costs |
| `SETUP_ALERT_HIDE_NO_TRADE` | `on` | Leave scenarios the quality gate rejected (`NO_TRADE`, e.g. a long entered in premium or cost-adjusted RR < 1.0) out of setup cards; they still reach `data/setup-outcomes.jsonl` |
| `CROWDING_MIN_REWARD_RISK` | `1.5` | CROWDING-ι targets the nearest untaken liquidity pool paying at least this multiple of its stop (≥ 1.2 ATR); with none, no signal. Replaced the range-midpoint target, whose reward collapsed as price drifted toward it (RR 1.17 → 0.89 → 0.42) |
| `AUDIT` / `ALERTS` | `off` | Audit trail and Telegram alerts, see [Ops](#ops-audit-trail-telegram-alerts-kill-switch) |
| `PAPER_EXCHANGE_URL` | (unset) | When set in `paper` mode, routes through the remote Rails broker (`http://127.0.0.1:3100`) |
| `PAPER_EXCHANGE_ACCOUNT_ID` | (none) | Account for the remote broker; **required** when `PAPER_EXCHANGE_URL` is set in `paper` mode (startup fails without it); `.env.example` suggests `crypto-agent` |

---

## Paper trading on paper_exchange

Set `PAPER_EXCHANGE_URL` (and `PAPER_EXCHANGE_ACCOUNT_ID`) with `MODE=paper` and the agent trades on the
`paper_exchange` Rails broker instead of the local engine.

**Start the exchange:** `docker compose up -d` in `/home/nemesis/projects/apps/paper_exchange`
(health check: `GET http://127.0.0.1:3100/up`).

**Who holds what.** The exchange holds the wallet, positions, fees, funding and liquidations. The agent holds
strategy state and shows the exchange's numbers: equity is `available_balance + locked_margin + unrealized`
(re-marked from live ticks), so fees and funding are inside it. Journal PnL per trade is gross; fees and funding
show up in equity only.

**Account.** One shared account (`PAPER_EXCHANGE_ACCOUNT_ID`). On startup the agent creates it with 100 000
margin only if it does not exist; it never resets an existing account.

**Ownership rule.** Positions net per symbol. A symbol is owned by the strategy that opened it: other
strategies are refused before any order is sent. The owner may scale in (same side) or flip (full reduce-only
close journaled `FLIP`, then a new position). A position on the exchange with no sidecar entry (manual trade,
lost sidecar) is adopted as `EXECUTOR-ε`, without SL/TP, and strategies never touch it.

**Exits are agent-side.** SL, TP and trailing stops are evaluated against the agent's own price ticks; a breach
sends a reduce-only market order for the exact quantity, one exit in flight per symbol. If the agent is offline
nothing exits (the broker has no price feed); liquidation is the only server-side exit.

**Sidecar `data/remote-state.json`.** Holds owner, SL/TP and initial risk per position, plus the closed-trade
journal (last 1000). The file is bound to one account id. After resetting the exchange account, delete it.

**Outage behavior.** While the exchange is down, entries are refused (`VenueUnavailableError`) and nothing is
sent. Exits queue and retry (about once a second) under one client order id, and complete after recovery, at the
worse of the trigger and the current mark for stops. The loop and cockpit keep running on cached data: the
footer shows `venue paper_exchange (<account>) ●connected|degraded|down` and the equity line shows `stale`
when down.

**End-to-end check.** `npm run e2e:paper-exchange` runs scenarios S1–S24 (design spec:
`docs/superpowers/specs/2026-09-21-paper-exchange-end-to-end-design.md`) through `RemoteBroker` and prints one
PASS/FAIL/SKIPPED line per scenario with the agent and exchange numbers it compared; non-zero exit on any failure.

- `E2E_BACKEND=fake` (default): in-memory exchange replica, no network.
- `E2E_BACKEND=real`: needs `PAPER_EXCHANGE_URL`; creates a throwaway account `e2e-<epoch>` (the run refuses any
  other account id) and trades only synthetic symbols `E2EAUSDT`, `E2EBUSDT`, ... because the exchange's mark
  prices and liquidation scan are shared across accounts. Scenarios that need a controlled outage or a lost
  response (S14, S15) are `SKIPPED (fake-only)`; S13 runs against a closed port. The exchange cannot delete
  accounts, so `e2e-*` accounts stay in its database.

---

## Ops: audit trail, Telegram alerts, kill-switch

Both are on by default and isolated from trading: an audit, alert or Telegram failure is swallowed before it
reaches the loop, and sends are fire-and-forget, so trading never waits on Telegram. With a flag turned off its
hook does nothing: no file is written, no request is made, no timer is started. `ALERTS=on` still needs
`TELEGRAM_CHAT_ID` and a bot token below before it can actually send anything — until those are set it has nothing
to send to.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUDIT` | `on` | `off` stops appending a JSON line per decision step to `EVENTS_PATH` |
| `ALERTS` | `on` | `off` stops sending Telegram cards (and the daily digest timer) |
| `EVENTS_PATH` | `data/events.jsonl` | Audit trail; rotated to `<file>.1` at 5 MB |
| `NOTIFICATIONS_PATH` | `data/notifications.json` | Optional subscription JSON (missing or invalid means every class on) |
| `TELEGRAM_CHAT_ID` | (unset) | Destination chat, required to send |
| `TELEGRAM_BOT_TOKEN` | (unset) | Shared bot, used when a channel has no bot of its own |
| `TELEGRAM_TRADING_BOT_TOKEN` | (unset) | Bot for TRADE and SIGNAL cards |
| `TELEGRAM_ALERTBOT_BOT_TOKEN` | (unset) | Bot for SYSTEM and digest cards |
| `TELEGRAM_DRY_RUN` | (unset) | `1` writes each card to the cockpit log (`[telegram dry-run] ...`) instead of sending; works without tokens |

**Enable it:** both are already on; add `TELEGRAM_CHAT_ID` plus a bot token (`TELEGRAM_BOT_TOKEN`, or the two
per-channel tokens) to `.env` to let `ALERTS` actually send. Try it first with `TELEGRAM_DRY_RUN=1`. Tokens are
never logged. The audit trail and the alerts are independent of `RISK_ENGINE`. Set `AUDIT=off` / `ALERTS=off` to
disable either.

**Audit trail.** Each signal keeps one `decisionId` (the signal's `id`) from `signal` through `gate`, `veto`,
`order`, `exit` and `journal`; refusals are `refusal` events with the same id. System events (`venue`, `circuit`,
`crash`, `killswitch`, `digest`) carry none. Exits are detected from the closed-trade journal, so a stop, a
liquidation or an off-agent close is reported even when the loop logged nothing. A position opened before a restart
has no `decisionId` on its exit.

**What each alert covers** (a card is audible unless its severity is below IMPORTANT):

| Class | Cards | Severity |
| --- | --- | --- |
| TRADE (trading bot) | position opened, scale-in, flip; exit with reason, gross PnL and R (R needs the position's initial stop) | fill: SIGNAL; exit: IMPORTANT; liquidation: CRITICAL |
| SIGNAL (trading bot) | entry accepted; entry refused (risk gate or executor); entry vetoed by the advisor | accepted: SIGNAL; refused/vetoed: WATCH (silent) |
| SETUP (trading bot) | deterministic multi-scenario flow map: regime, structure, liquidity, crowding, entry zones, SL/TP, trigger, invalidation, flow hypothesis and expected move window | triggered: SIGNAL; developing: WATCH (silent) |
| SYSTEM (alert bot) | venue degraded / down / recovered, websocket drop after it was up, loop crash, circuit-breaker change, kill-switch on/off | down, crash, HALTED/EMERGENCY, kill-switch: CRITICAL; others IMPORTANT (websocket reconnecting: WATCH) |
| RESEARCH (alert bot) | daily digest at 00:05 UTC for the previous UTC day: PnL, trades, win rate, profit factor, best/worst, drawdown, refusals by reason, per-strategy results (gross realized PnL; a dash where a ratio is undefined) | WATCH (silent) |

### Institutional-style setup maps

The alert pipeline can also publish one deterministic `SETUP` map per symbol instead of relying only on entry/refusal cards. A setup map summarizes the current directional regime, HTF/LTF structure, liquidity, crowding and derivatives context, then presents up to three executable hypotheses (liquidity sweep, pullback/retest, breakout/retest) with entry zone, invalidation, stop, targets, reward/risk, trigger, flow hypothesis, expected move window and thesis expiry.

These are **market-derived hypotheses**, not claims of privileged institutional intent. The flow field explicitly describes an inference from observable positioning/aggression/liquidity data. Expected move windows are currently deterministic volatility/ATR model estimates; they are not yet historical time-to-target quantiles. The setup engine never routes an order by itself: the existing risk gate, execution-quality checks and executor remain authoritative.

Setup maps are generated from the same `MarketState` already built by `Orchestrator.gatherContext()`. `WATCHING` cards use WATCH severity; `TRIGGERED` cards use SIGNAL severity. Setup alerts are deduplicated with a 15-minute cooldown, while a WATCHING → TRIGGERED transition is emitted immediately. Configure them through the existing `SETUP` class in `NOTIFICATIONS_PATH`; no new Telegram credentials are required.

### Multi-persona agentic AI and self-learning

`LLM_COUNCIL` is on by default: the runtime runs a research council above the deterministic market engine. Five specialist personas (technical, liquidity, derivatives, regime and skeptic) analyze the same normalized `MarketState` and setup map independently, then a portfolio-chair persona synthesizes the reports and may select only a supplied setup scenario or `WATCH`/`NO_TRADE`. Set `LLM_COUNCIL=off` to disable it entirely (no persona calls, no learning-ledger predictions).

The council never creates price levels, sizes positions or bypasses `RiskAgent`, execution-quality checks or `ExecutorAgent`. LLM output is schema-validated. Each persona can use a different Ollama model through the `OLLAMA_*_MODEL` variables; all default to `OLLAMA_MODEL`.

`LLM_COUNCIL_AUTOTRADE` is also on by default (requires `LLM_COUNCIL=on`): a chair `TRADE` verdict is converted into a real `Signal` — but only when it targets a setup scenario the deterministic `SetupEngine` has *itself* already confirmed `TRIGGERED`, and only above `LLM_COUNCIL_MIN_PROBABILITY` (default 0.65). The signal's entry, stop loss and take-profit are always the scenario's own deterministic values; the LLM selects a scenario, it never invents a price. `WATCH`/`NO_TRADE` verdicts and verdicts on a `FORMING`/`ARMED` scenario are never traded. Because the council runs detached from the tick loop (to keep local-LLM latency off the trading loop), an approved verdict is queued and picked up by the risk gate on the next cycle, dropped after 5 minutes if unconsumed. From there it is one more `Signal` with agent id `AI-COUNCIL-κ`: it still goes through `RiskAgent.gate()` (mandatory stop loss, position sizing, drawdown kill-switch), execution-quality checks and the same Telegram/audit notices as every other agent's signal. Set `LLM_COUNCIL_AUTOTRADE=off` to keep the council advisory-only (it still runs and still logs every verdict) without touching `LLM_COUNCIL`.

The learning ledger is persistent and idempotent. Closed trades update per-agent realized-R statistics, with symbol-specific history preferred after enough observations. Closed-trade keys are persisted so restarting the process cannot train twice on the same trade. Persona and chair forecasts are also persisted as prediction episodes and resolved later against live marks at their stated horizons using an adaptive volatility threshold. Resolution records directional correctness and a Brier score for calibration. The replay engine runs the same per-agent stats loop against an in-memory ledger (never persisted), so backtests exercise — and report — the same learned confidence adjustment the live fleet would apply.

This is adaptive self-learning, not live fine-tuning of neural-network weights. The learned state influences deterministic signal-confidence adjustment and is fed back to persona prompts as historical memory. It does not mutate code or bypass the risk boundary automatically; candidate policy changes should still be validated through replay/backtesting before production.


Repeats are dropped by fingerprint: a refused signal for the same symbol, agent and reason at most once per 15
minutes, and the same system alert at most once per 5 minutes. Optional `NOTIFICATIONS_PATH` JSON turns classes,
symbols or a minimum severity off, for example `{"notifications": {"signal": false, "minSeverity": "IMPORTANT"}}`
(SYSTEM CRITICAL alerts are never suppressed).

**Kill-switch.** Press `k` in the cockpit to halt new entries: every OPEN is refused with `kill-switch: manual`,
whatever `RISK_ENGINE` says, and the risk row of the fleet panel shows `KILL-SWITCH`. Exits, stops and manual closes
are never affected. Press `k` again to resume. The state is saved to `data/kill-switch.json`, so a restart does not
resume trading by itself (press `k` or delete the file to clear it). A circuit-breaker HALTED/EMERGENCY (`RISK_ENGINE`,
on by default) refuses entries on its own and is announced as a SYSTEM alert; it does not touch the kill-switch.
Set `RISK_ENGINE=off` to fall back to the legacy sizing path (no fee netting, exposure caps or circuit breaker).

With `MODE=live` (without `PAPER_EXCHANGE_URL`) the venue keeps no per-strategy trade journal, so the risk engine cannot see realized losses there: the daily-loss and loss-streak limits stay inactive (only drawdown applies) and a warning is logged at start.

---

## Architecture

```
src/
  agents/           # Signal generators + RiskAgent + ExecutorAgent
    FundingArbAgent.ts       # funding harvest (short perp when funding positive)
    MomentumAgent.ts         # momentum breakout
    AdaptiveSuperTrendAgent  # ML-adaptive supertrend (paper modes, local and remote)
    RiskAgent.ts             # gating authority, drawdown kill-switch
    ExecutorAgent.ts         # order routing
    StructureLiquidityAgent.ts  # STRUCT-LIQ fleet agent (STRUCT_LIQ=off to disable)
  binance/
    client.ts                # BinanceService — paper/live/remote backend switch
    paperEngine.ts           # local in-memory paper engine (with flushOnShutdown — #5)
    paperExchangeClient.ts   # HTTP client for the remote Rails broker (retry, typed errors — #7)
    remoteBroker.ts          # strategy-aware view of the shared exchange account
    remoteOrders.ts          # entries, agent-side reduce-only exits, idempotent client order ids
    remoteReconcile.ts       # aligns the sidecar with the exchange (adopt, journal off-agent closes)
    remoteState.ts           # data/remote-state.json sidecar + wallet-equity projections
    remoteFunding.ts         # funding-boundary detection and push
    stopRules.ts             # SL/TP breach rules shared by the local engine and the remote broker
    symbolRules.ts           # exchangeInfo precision cache
    indicators.ts            # ATR, sparkline
    adaptiveSuperTrend.ts    # indicator math
    performance.ts           # win rate / max drawdown / Sharpe
  coindcx/
    coindcxClient.ts          # ExchangeApi adapter over a real CoinDCX futures account (not yet wired into client.ts — #31)
    symbolRouter.ts           # Binance symbol <-> CoinDCX B-<BASE>_<QUOTE> pair mapping, USDT/INR routing
    contractSpec.ts           # CoinDCX instrument lot size / min qty / leverage cache
  ollama/
    advisor.ts               # veto / advise / ask (fail-closed on parse errors — #6)
  ops/                       # audit trail, alerts, Telegram sender, cards, kill-switch, hooks
  runtime/
    Orchestrator.ts          # main loop, state emit
    opsHooks.ts              # circuit/performance ops, hook wiring from the flags, daily digest timer
    telemetry.ts             # builds the cockpit state snapshot
  decision/
    CandidateFlow.ts          # canonical routing + fusion + DecisionRecord builder (shared with replay)
    SignalFusion.ts           # evidence scoring and conflict resolution
    CandidateScorer.ts       # deterministic evidence rubric from the MarketState
    StrategyRouter.ts        # regime-based strategy eligibility
    DecisionJournal.ts       # append-only JSONL decision lineage (evidence -> risk -> execution -> outcome)
    StructureLiquidityStrategy.ts  # SMC trend setup consuming the liquidity ledger (sweep history + untaken targets)
  market/                     # MarketState stack (data -> state)
  risk/
    equityHwm.ts             # persisted equity high-water mark (mode-keyed, atomic writes)
    performanceEngine.ts      # journal-derived circuit-breaker metrics
    positionSizer.ts          # Decimal-precise sizing
    riskEngine.ts             # deterministic portfolio checks
  backtesting/
    ReplayService.ts          # full-system replay: same agents/fusion/risk/learning as the live loop
    MarketDataFeed.ts         # no-lookahead historical feed
    ExecutionSimulator.ts     # spread/slippage/fee fills, conservative intrabar exits
    PortfolioSimulator.ts     # multi-symbol positions, funding, liquidation, MAE/MFE
    BacktestMetrics.ts       # expectancy/Sharpe/Sortino/CVaR + by-strategy/regime/evidence slices
    StructLiqSweep.ts         # STRUCT-LIQ parameter-sensitivity harness (age x reward-risk grid)
  learning/
    AgentLedger.ts           # per-agent rolling stats (disk-backed; null path = in-memory, e.g. replay)
    TradeOutcomeRecorder.ts  # grades closed trades against their stored decision evidence
  ui/                        # Ink TUI
  config.ts                  # zod-validated env config
  types.ts                   # shared types
  index.tsx                  # entrypoint with SIGINT/SIGTERM hooks
```

### STRUCT-LIQ and the liquidity ledger

`agents/StructureLiquidityAgent.ts` runs `decision/StructureLiquidityStrategy.ts` — the SMC trend
setup: HTF directional regime -> LTF liquidity sweep -> LTF BOS/CHOCH confirmation -> opposing
liquidity target. It is a first-class fleet member (paper, live and replay all run the same
agent, one evaluation per closed 15m candle per symbol) and the first consumer of the
market-state hardening ledgers:

- **Trigger sweeps** are drawn from the persistent `sweepHistory` (causally replayed over the
  whole window) unioned with the legacy 12-bar window. Sweeps of pools that aged out of the
  per-snapshot pool list still qualify, and a sweep must predate the confirming break — the
  strategy enforces causality rather than assuming it.
- **Take-profit targets** skip every pool the sweep ledger marked `taken`. Spent liquidity is
  never re-targeted: the setup walks out to the nearest untaken pool or stands down.
- **Stops** anchor on a zone that is alive per the zone ledger — FRESH, or TESTED (preferred:
  it already absorbed one retest), formed before the break. When the ledger says every zone is
  dead (MITIGATED/INVALIDATED/EXPIRED), the stop rides the sweep price alone instead of leaning
  on a zone the ledger has retired.

These are behavioral changes against the pre-ledger strategy: some setups that were missed now
fire, setups that aimed at already-consumed liquidity now aim further out or do not fire, and
stops no longer trust legacy "fresh" zones the ledger knows are spent. States without ledger
annotations (and `RANGE_*` pools, which the ledger does not mark) fall back to the exact legacy
behavior. The strategy stays deterministic and analysis-only — the router (directional regimes
only), signal fusion (it competes with the other market-state strategies per symbol), the risk
gate and the executor remain authoritative. Set `STRUCT_LIQ=off` to remove the agent from the
fleet; the cockpit then shows it paused.

Two thresholds are env-tunable without code changes — `STRUCT_LIQ_MAX_SWEEP_AGE_CANDLES` (default 6)
and `STRUCT_LIQ_MIN_REWARD_RISK` (default 1.5) — wired identically into the live fleet and the replay
fleet. The parameter sweep above measured their sensitivity on real data: the age window is not the
binding gate (the trigger sweep is fresh whenever the other gates pass), while the RR floor is — lower
it to admit thinner targets at a known cost in expectancy per trade. The startup log names the active
tuning whenever it deviates from the defaults.

---

## Known gaps (cross-referenced to GitHub issues)

Issues #1–#7, #10, #11 and #12 are closed as fixed (verified against current source, see each entry
below); #9 is resolved (`.env.example` and `config.ts` no longer disagree); #31 is fixed on an interim
basis (see its entry below and the "Modes" section above).

### #1 — SL/TP in remote-paper mode

**Superseded.** Server-side stop orders are gone: the broker never re-evaluates resting orders and has no price
feed. Exits are agent-side reduce-only market orders (see "Paper trading on paper_exchange"), so nothing exits
while the agent is offline.

### #2 — Funding not wired into run loop

**Fixed.** `RemoteBroker.observeFunding` detects when Binance's `nextFundingTime` jumps forward (the next
boundary moves by 8h) and pushes one funding event per symbol with the boundary timestamp. The broker dedupes on
`(paper_position_id, funding_time)`. A failed push is logged and not retried.

### #3 — Per-strategy attribution lost in remote/live

**Fixed for remote paper** by the ownership rule (a symbol belongs to the strategy that opened it; the sidecar
records it). Live Binance positions are still per-symbol.

### #4 — AdaptiveSuperTrendAgent disabled in remote-paper/live

**Fixed for remote paper.** Its stop updates are persisted in the sidecar only for positions it owns. It stays
disabled in live mode (`Orchestrator.start()` logs why).

### #5 — Paper engine 250ms debounce can drop last state on crash

**Fixed.** `PaperEngine.flushSync()` writes the state synchronously, and
`Orchestrator.flushOnShutdown()` is wired to SIGINT/SIGTERM in `App.tsx`.

### #6 — Ollama advisor was fail-open on parse errors

**Fixed.** `parseVerdict` now returns `VETO` on unparseable replies and on
unknown verdict strings — fail-closed for hard errors. Offline and network
errors still fail-open (PROCEED) because deterministic code owns the entry
decision; the veto is a belt-and-braces check.

### #7 — paperExchangeClient threw on non-204 with no retry

**Fixed.** 5xx errors and network errors retry up to 2 times with exponential
backoff (250ms, 500ms) and end as `VenueUnavailableError`. 4xx errors surface
immediately as `OrderRejectedError` (retrying a client error is wrong).

### #10 — MAX_DRAWDOWN_PCT was display-only

**Fixed.** `RiskAgent.isDrawdownBreached` tracks session-peak equity and
rejects all OPEN signals once drawdown exceeds the limit. Closes
(reduceOnly + opposite-side exits) still pass — reducing exposure is the
correct response to a drawdown breach.

### #11 — PairsAgent disabled

**Fixed (deleted).** The agent, its `PAIRS-TRD-β` `AgentId` and its permanently-paused fleet row are
removed — it only ever signaled a BTC/ETH close-ratio, which is not a tradable exchange symbol. The
underlying BTC/ETH divergence z-score is still shown in the cockpit as an informational-only metric
(the "DIVERGENCE" row in `renderMetricsLines`), decoupled from any trading strategy.

### #12 — getTrades() returns [] in remote-paper mode

**Fixed.** The trade journal lives in the sidecar (`data/remote-state.json`); the agent computes its own
statistics from it instead of the exchange's `/api/performance`.

### #31 — MODE=live required CoinDCX credentials it never used

**Fixed (interim).** The fail-closed check requiring `COINDCX_API_KEY`/`COINDCX_API_SECRET` for `MODE=live`
has been removed — see "Modes" above. `MODE=live` needs only Binance credentials again until the CoinDCX
wiring (Task 5 of `docs/superpowers/plans/2026-09-22-coindcx-live-execution.md`) actually lands, which needs
the private `@nemesis-oss/coindcx-sdk` package this environment cannot install.

---

## Testing

```bash
npm test                  # node:test runner
npm run build             # tsc, typecheck only
npm run e2e:paper-exchange  # S1-S24 through RemoteBroker (E2E_BACKEND=fake|real, see above)
```

---

## License

Proprietary — AlgoScalperAPI.

## Per-strategy RR floors (calibrated from your own trades)

`MIN_RR` is a single global floor and defaults to `0` (off). To gate each strategy on its own proven edge:

```bash
npx tsx scripts/calibrate-rr.ts --write          # reads data/decisions.jsonl, prints a report, writes data/rr-profile.json
RR_PROFILE_PATH=data/rr-profile.json RISK_ENGINE=on npm run dev:paper
```

The floor for a strategy is the lowest planned RR whose cohort (that RR and above) has at least `--min-samples` executed trades
and a positive 90% lower bound on **net** expectancy after round-trip fees and slippage. Strategies reported `NO_PROVEN_EDGE` or
`INSUFFICIENT_DATA` get no floor and keep the global `MIN_RR`. With a profile loaded, the RR check uses cost-adjusted RR.
Only executed trades have outcomes, so treat floors as candidates to paper-test, not proof.

## Setup intelligence pipeline

```
MarketState → buildSetupMap → SetupLedger (identity, pinned expiry, frozen levels, grace)
            → annotate (location@entry, sweep evidence, flow Δ, quality gate) → ThesisController → alerts / council
                                   └→ SetupOutcomeLedger (hypothetical outcome of every setup, traded or not)
```

- A confirmed **trigger** is not an **order**: only `ENTRY_ELIGIBLE` scenarios on the authoritative thesis can become council signals (fail-closed).
- One directional thesis per symbol; a flip needs an invalidation breach, expiry, or an opposing trigger while the old thesis never triggered.
- `data/setup-outcomes.jsonl` (`SETUP_OUTCOMES_PATH`) records each setup's features and hypothetical net R. Read it with
  `npx tsx scripts/setup-stats.ts`. Quality-gate thresholds are starting points; tune them from this data, not by hand or by the LLM.
- Only the council path is gated by the pipeline; the legacy agents (Momentum, Structure, …) still emit independent signals through `RiskAgent`.

## Evidence status

As of 2026-09-30 no strategy family here has a demonstrated edge after costs. See `docs/research-log.md` for what was tested,
the numbers, corrections and what is still untested. Positions with no protective stop above `UNPROTECTED_ALERT_PCT` (default 25%)
of equity raise a CRITICAL system alert, since a strategy cannot enforce a stop on a position it does not own.

## Live gate

`MODE=live` trades only strategies listed in `data/strategy-approvals.json` (`APPROVALS_PATH`); with no file, nothing trades, and the
process refuses to start live without `RISK_ENGINE=on` and `ALERTS=on`. Approvals come from measured evidence, never by hand:

```bash
npx tsx scripts/live-readiness.ts                      # checklist: evidence, forward paper, setup safety; exit 1 if not ready
npx tsx scripts/live-readiness.ts --write-approvals    # writes only strategies that pass BOTH evidence and forward paper
```

A strategy needs >= 100 trades over >= 150 days with a positive 90% lower bound on net expectancy after costs and a positive mean in
both time halves, plus >= 50 paper trades over >= 30 days with positive net expectancy. Limits (risk per trade, leverage, daily loss,
drawdown) are operator policy in `DEFAULT_POLICY` (`src/ops/liveReadiness.ts`).

## Market-data recorder

Binance does not serve historical liquidations, order-book imbalance or aggressor flow, so flow-based ideas (CROWDING and
anything derivatives-driven) cannot be backtested until the data has been recorded. Run it beside the agent:

```bash
npx tsx scripts/record-market-data.ts --self-check 30          # verify the streams first; exits 1 if trades/book/mark do not arrive
npx tsx scripts/record-market-data.ts                          # then leave it running (tmux, systemd, docker)
```

It writes one 1-minute record per symbol to `data/market/SYMBOL-YYYY-MM-DD.jsonl` (~3 MB per symbol per week): aggressor buy/sell
volume, liquidations by side, book spread and imbalance, mark/index/funding, open interest and taker ratio. Public streams only,
no keys. The first and last minute of a session are partial; drop them when analysing. As of 2026-09-30 Binance serves
`aggTrade`/`markPrice`/`forceOrder` only from `wss://fstream.binance.com/market/` and the book from `/public/`; the legacy `/stream` and
`/ws` URLs deliver neither, so `--self-check` is the first thing to re-run if a recording ever comes back empty.

### Analysing the recorded data

```bash
npx tsx scripts/analyze-flow.ts          # pre-registered event study on data/market; needs >= 14 days for a meaningful answer
```

Three hypotheses (H1 liquidation flush reverses, H2 aggressor flow continues, H4 book imbalance predicts direction) are fixed in
`src/marketdata/EventStudy.ts` and tested at 5/15/30/60 minutes with the trigger threshold taken from the first half of the recording and
events counted only in the second half. The significance bar is Bonferroni-corrected across all 12 tests, and a result must also beat
round-trip costs to matter. Do not edit the existing hypotheses after looking at results; add a new id.
