# options-trading-agent

An NSE/BSE **index options buying** agent on **DhanHQ**, with LLM advisory through
[`@nemesis-oss/ollama-sdk`](https://www.npmjs.com/package/@nemesis-oss/ollama-sdk).
It trades NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY (NSE_FNO) and SENSEX (BSE_FNO) by buying
one long CE or PE per signal, with a server-side stop and target on every entry.

It was migrated from `crypto-trading-agent` (the baseline commit is kept in history). The
crypto exchange adapters, perpetual and funding logic, SMC-ML strategy, MiniCPM workers and
research plane were removed, not adapted. See [What was removed](#what-was-removed).

## Scope

| In scope | Out of scope |
| --- | --- |
| Long CE / long PE on index options (buy-to-open only) | Any option selling, spreads that sell premium, or short options |
| NSE_FNO and BSE_FNO index options | Equities, futures, commodities, crypto |
| DhanHQ REST + WebSocket market data and super-order execution | Other brokers |
| Three modes on live market data: `paper`, `sandbox`, `live` | Automatic tuning from backtest results |
| Offline historical replay on real option premiums ([Time Machine](docs/TIME_MACHINE.md)) | |

## Quick start

```bash
npm ci                       # installs @nemesis-oss/dhanhq-sdk 1.3.0 from npm (exact pin)
cp .env.example .env         # fill DHAN_CLIENT_ID, DHAN_PIN and DHAN_TOTP_SECRET (see Dhan authentication)
npm run typecheck && npm test
npm run dev:paper            # paper venue, live market data, simulated fills
```

There are three modes. Market data is always the live Dhan feed in every mode.

| Mode | Market data | Orders go to | Persistence |
| --- | --- | --- | --- |
| `paper` | live Dhan feed | `PAPER_BACKEND=postgres`: simulated venue in PostgreSQL. `PAPER_BACKEND=exchange`: a running [paper_exchange](https://github.com/shubhamtaywade82/paper_exchange) server | PostgreSQL (required) |
| `sandbox` | live Dhan feed | Dhan sandbox account via the SDK's `hybrid` mode (`DHAN_SANDBOX_*`) | PostgreSQL and Redis (required) |
| `live` | live Dhan feed | Dhan production account | PostgreSQL and Redis (required) |

Live trading needs `MODE=live` **and** `LIVE_TRADING_ACK=I_ACCEPT_LIVE_ORDER_RISK`. Without
both, the process exits before opening a socket. `npm run dev:sandbox` starts sandbox mode.
Each mode holds its own trading lease, keyed `mode:clientId`, so a paper run never blocks a live run.

### Running paper against paper_exchange

`PAPER_BACKEND=exchange` sends paper orders to a running [paper_exchange](https://github.com/shubhamtaywade82/paper_exchange) server, which keeps the account, margin and ledger. Set `PAPER_EXCHANGE_URL` (https, or http on loopback), `PAPER_EXCHANGE_API_KEY` and optionally `PAPER_EXCHANGE_ACCOUNT_ID`.

The account must be INR. The server's reset endpoint creates USD accounts, so after a reset set the currency to INR on the server. The agent refuses to start otherwise.

To run the end-to-end suite against a server (it places real paper orders on that account and leaves no position open):

```bash
PAPER_EXCHANGE_E2E_URL=http://127.0.0.1:3100 \
PAPER_EXCHANGE_E2E_API_KEY=... \
PAPER_EXCHANGE_E2E_ACCOUNT=<inr-account-id> \
npx tsx --test tests/paperExchange.e2e.test.ts
```

Without those variables the suite is skipped.

Node 22 or newer is required.

## Architecture

```
                  ┌──────────────── Orchestrator (one shared DayBook) ───────────────┐
 Dhan WS  ──ticks─▶ route by composite key  (IDX_I:13 → spot,  NSE_FNO:48001 → option)
                  │      │                                           │
                  │  UnderlyingAgent (per index, serial queue)       │
                  │      CandleBuilder → BarSeries → ORB+SuperTrend  │
                  │      signal → ChainSnapshot → selectContract     │
                  │      → bracketLevels → sizePosition              │
                  │      → evaluatePreTrade (risk gate)              │
                  │      → LLM advisor (veto only, optional)         │
                  │      → ExecutionPort.submitEntry ─────────────┐  │
                  │      TradeStateMachine (deterministic FSM) ◀──┼──┘
 Dhan REST ◀── MarketPort (charts, expiries, option chain, funds)  │
                  │                                                │
                  │   ExecutionPort  (one contract, two venues)    │
                  │     PaperExecutionPort  simulated fills        │
                  │     LiveExecutionPort   super orders, WS fills │
                  └────────────────────────────────────────────────┘
                  EventLog (JSONL audit trail) · console logger (IST)
```

- **One contract, two venues.** `ExecutionPort` reports every outcome as an event. The
  state machine is driven by events only, so paper and live follow the same code path.
- **One serial queue per underlying.** Spot ticks, option ticks, clock, and fills all enter
  one queue, so transitions never interleave.
- **Composite keys everywhere.** Instruments are identified by `exchangeSegment:securityId`.

Details, the full transition table, and the failure-mode matrix are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Operator cockpit

On an interactive terminal, `npm run dev:paper` (and `dev:live`) opens a full-screen cockpit in the same
layout family as the crypto dashboard: header, four framed columns, a detail row, the event log, and a
footer. Set `UI=off`, or pipe the output, for plain log lines under a process supervisor.

```
UNDERLYINGS     SIGNAL & CONTRACT           POSITION          RISK & DAY
▸ NIFTY IDLE    SELECTED NIFTY               flat             P&L +₹83.75
  spot, age     LAST SIGNAL / REJECTION      LAST EXIT        loss ░░░░ 0% of ₹3,000
  ST, ORB       LAST CANDIDATE (contract,    (or the open     trades 2/3, open 1/1
  EMA           ask, spread, OI, SL, TP)     position: mark,  kill switch off
                                             P&L, held time)
```

| Key | Action | Notes |
| --- | --- | --- |
| `↑` `↓` | select underlying | The columns and detail follow the selection. |
| `c` | close the selected position | Goes through the normal exit path (reason `MANUAL`). Press twice within 5 s. |
| `k` | toggle the entry block | Blocks new entries. Clearing is refused while any underlying is halted or the day has breached its loss limit. Press twice. |
| `s` or `ctrl+c` | stop | Flattens open positions, then exits. Press twice. |
| `?` | help line | |

The cockpit only reads state, except for these three actions, and every action needs a second press.
Its data comes from `Orchestrator.snapshot()`, a read-only view built from the agents and the day
book. Rendering it never changes trading state. Its log is an in-memory ring of the last 200 records;
the durable record is still the journal.

## Strategy and contract selection

**Signal** (evaluated only on closed bars, IST session):

1. Opening range = high/low of the first `ORB_MINUTES` (default 15) from 09:15.
2. **Bullish:** a bar closes above the ORB high, the previous bar closed at or below it,
   SuperTrend is UP, and EMA(9) > EMA(21). **Bearish** is the mirror image.
3. Entries are considered only between `ENTRY_START` and `ENTRY_END` (default 09:30–14:30).
4. A level that is already broken on the previous bar does not fire again.

**Contract:** expiry is the nearest one with at least `MIN_DAYS_TO_EXPIRY` days left. The
strike is ATM ± `STRIKE_OFFSET_STEPS` × the strike step derived from the live chain. Bullish
buys the CE, bearish buys the PE. A positive offset is always further out-of-the-money.
Every check fails closed: a missing leg, a missing quote, a crossed quote, a security-id
mismatch with the scrip master, a spread above `MAX_SPREAD_PCT`, or OI/volume below the
minimums rejects the signal.

**Brackets and sizing:** entry reference is the ask × (1 + `ENTRY_LIMIT_BUFFER_PCT`), rounded up to
tick. Live entries are LIMIT super orders at that price, so a fill can never be above it and the
realised risk never exceeds the sized risk. A limit not filled within `ORDER_TIMEOUT_MS` is cancelled;
a partial fill keeps what filled. Stop = entry × (1 − `STOP_LOSS_PCT`),
rounded up to tick. Target = entry + `TARGET_RR` × risk, rounded down to tick. Lots are
floored so that `lots × lotSize × (entry − stop)` fits `min(CAPITAL_INR, available funds) ×
MAX_RISK_PER_TRADE_PCT`. `CAPITAL_INR` is a ceiling, never raised by a larger broker balance, so
one stop-out stays inside the daily loss limit (also a percentage of `CAPITAL_INR`).
If one lot does not fit the budget, the trade is skipped. The agent never rounds risk up.

## Risk controls

| Control | Where | Behaviour |
| --- | --- | --- |
| Mandatory stop loss | `bracketLevels`, `evaluatePreTrade`, SDK super-order schema | Every entry carries a stop and target. An entry cannot be built without them, and the SDK rejects a super order that lacks either. |
| Max risk per trade | `sizePosition`, re-checked in `evaluatePreTrade` | Lots floored to budget. Zero lots means skip. |
| Max daily loss | `DayBook`, `Orchestrator.enforceDailyLoss` | Realised + unrealised day P&L ≤ −limit: entries blocked, all positions flattened, then broker kill switch. Realised P&L is net of estimated charges (`roundTripChargesInr`: ₹20/order brokerage, STT 0.15% on the sell premium, exchange and SEBI fees, stamp duty, GST); the journal records gross, charges and net. The contract note is authoritative. |
| Max daily loss at risk | `DayBook.openRiskInr`, `evaluatePreTrade` | Realised P&L − every open or pending stop − this trade's stop must stay above −limit, across all underlyings and both sides. Otherwise `DAILY_LOSS_AT_RISK`. |
| Trades per day, open positions, one per underlying | `evaluatePreTrade` | Hard limits. Defaults: 3 trades, 1 open position. |
| Cooldown per underlying | `DayBook` | `COOLDOWN_SECONDS` after each exit. |
| Entry window and expiry-day cutoff | `evaluatePreTrade` | Outside the window, or after `EXPIRY_DAY_ENTRY_CUTOFF` on expiry day: no entry. |
| Stale data | `evaluatePreTrade`, `DhanFeed.ageMs` | Spot tick older than `FEED_STALE_MS` (or never received) on local receipt time, or a chain snapshot older than `FEED_STALE_MS`: no entry. |
| Time stop, EOD flatten | `UnderlyingAgent.exitReason` | `MAX_HOLD_MINUTES`, and every position flattened at `FLATTEN_BY` IST. |
| Kill switch | `DayBook`, `engageBrokerKillSwitch` | Local block on entries at once. Broker kill switch on halts and on daily-loss breach once no position is open (Dhan refuses it otherwise), tried again if a late fill reopens and closes one. |
| Clock alignment | `assertWarmupClock` | Startup refuses if bar timestamps are inconsistent with the wall clock (wrong epoch convention). |
| Broker positions at start | `Orchestrator.start` | Refuses to start while the broker holds option positions. Reconcile manually first. Until then only the position's bracket legs and Dhan's own intraday square-off (from about 15:18 IST, with a charge) protect it: no agent exit runs. |
| Flatten before the broker does | `loadConfig` | `FLATTEN_BY` must be 15:15 IST or earlier, before Dhan auto-squares intraday positions. |
| Live risk ceilings | `loadConfig` | `MODE=live` refuses `MAX_RISK_PER_TRADE_PCT` above 2 and `MAX_DAILY_LOSS_PCT` above 6, whatever `.env` or the YAML says. Not configurable. |
| Day state across restarts | `restoreDayBook` | Day P&L, trade count, cooldown, and breach state are rebuilt from today's journal file (`data/journal/events-YYYY-MM-DD.jsonl`). A malformed line in that file refuses startup. |

## Execution invariants (live)

- **BUY to open, SELL only to close.** The type system has no SELL-to-open shape. The risk
  gate rejects any non-BUY entry.
- **An exit SELL is sent only when the broker reports a net long quantity**, and never for
  more than that quantity. A negative net halts the underlying.
- **Fills are confirmed from the order-update stream**, not from the HTTP response.
- **No replay of trading writes.** Ambiguous placement outcomes (timeouts, 5xx, 401, 429,
  network) become `ENTRY_UNCONFIRMED` / `EXIT_UNCONFIRMED`, which halt the underlying and
  engage the broker kill switch. Only definitive 4xx rejections are `REJECTED`.
- **Reconciliation** polls `positions.list` while tracked positions are open. It reports
  external (bracket) closes and late fills exactly once, through the same terminal-key
  dedupe that prevents double-reporting.

## LLM advisor (`@nemesis-oss/ollama-sdk`)

Enabled with `LLM_ADVISOR=on`, `OLLAMA_HOST`, and `OLLAMA_MODEL`. The advisor gets a
structured snapshot of one entry candidate and must reply with a schema-validated
`{decision: ENTER|SKIP, confidence, reason}`.

- It is a **veto only**. It can stop an entry; it cannot create one, change size, strike,
  stop, or target, or override the risk gate.
- **Fail-closed.** Timeout, network error, auth error, malformed reply, or schema mismatch
  all resolve to SKIP.
- Structured output uses `chatWithSchema` with Zod validation. A second `safeParse` is applied
  to the result.

## Configuration

All keys, defaults, and bounds are in [`.env.example`](.env.example) and `src/config.ts`.
Invalid or unsafe values stop startup with a message that names the key. Defaults are
starting points. Tune `MIN_OPEN_INTEREST`, `MIN_VOLUME`, `MAX_SPREAD_PCT`, `STOP_LOSS_PCT`,
and `TARGET_RR` per index and per regime. None of them has been calibrated against data here.

## Dhan authentication

Set one source. Setting both is a startup error.

- **OTP login (preferred).** `DHAN_PIN` and `DHAN_TOTP_SECRET`. On first login (or after expiry)
  the agent sends the client id, PIN and a fresh TOTP code to `auth.dhan.co`. Valid tokens are
  cached on disk (`~/.dhanhq` by default, or `DHAN_TOKEN_CACHE_DIR`) so `smoke:live` and
  `dev:paper` in the same user account reuse one token instead of each starting a new PIN+TOTP
  login. Dhan rate-limits repeated logins. The token renews via `RenewToken` before expiry. If a
  request gets a 401, one renewal runs and all calls waiting on it share the result. A TOTP code
  with under 5 s left in its 30 s window is not sent. The agent waits for the next window
  instead, because the code could expire in transit.
- **Static token.** `DHAN_ACCESS_TOKEN`, copied from the Dhan portal. It expires and is not
  renewed. Used only when neither OTP variable is set.

The PIN and the TOTP secret together let anyone mint tokens for the account indefinitely.
Keep both in `.env` (gitignored) or your secret store. Never commit them, paste them into an
issue, or put them in a log. The agent logs the token expiry time. It never logs the token,
the PIN or the secret.

The login path is covered by tests that replace the SDK's HTTP call with a stub. The real broker
exchange has not been run from this environment. Run `npm run smoke:live` with real credentials
before relying on it. The first check it runs is the login.

## Tools

| Command | What it does | Credentials |
| --- | --- | --- |
| `npm run cockpit:demo` | Opens the operator cockpit on fakes, to see the screen. | none |
| `npm run smoke:live` | Read-only check of the open assumptions against live Dhan data: scrip master, expiries, option-chain fields, warmup bars and clock, funds, open broker positions. Places no orders. | Dhan |
| `npm run journal:summary [YYYY-MM-DD]` | Summarises a day's journal: trades, wins and losses, realised P&L, exit reasons, dropped-signal reasons, halts. | none |
| `npm run report:performance [-- --from YYYY-MM-DD --to YYYY-MM-DD --json]` | Results across every journal day, overall and by strategy, posture, underlying, option type, exit reason, entry hour, days to expiry and day: trades, win rate, net P&L, expectancy per trade, profit factor, average R, charges. Plus the signal funnel and every drop reason. Groups under 30 trades are flagged as too few to judge. One mode and client only. | none |
| `npm run timemachine -- fetch …` | Builds a research dataset: intraday spot bars plus Dhan rolling-option premiums for ATM±N, re-keyed by real strike. Read-only. See [docs/TIME_MACHINE.md](docs/TIME_MACHINE.md). | Dhan |
| `npm run timemachine -- run --data FILE` | Replays the live rules on that dataset (same strategy, bracket, sizing, pre-trade gate and charges code), then a block bootstrap of days and Monte Carlo day paths. Prints target-first / stop-first / unresolved rates with Wilson intervals, mean net R with a 95% interval, an out-of-sample check, and a verdict: `INSUFFICIENT_EVIDENCE`, `NO_TRADE` or `EDGE_SUPPORTED`. | none |
| `scripts/session.sh start\|stop` | Starts the paper agent in a detached tmux session (`tmux attach -t options-agent` for the cockpit), or stops it with SIGTERM. Cron runs it on weekdays at 08:45 and 15:45 IST. A non-zero exit sends a crash alert. | Dhan |

Set `ALERT_WEBHOOK_URL` (https, for example an ntfy.sh topic URL) to receive daily-loss stops, kill switch,
halts, rejected entries and exits, late fills and audit gaps as plain-text POSTs. Delivery is best effort and
never blocks trading. Treat the URL as a secret: anyone who knows an ntfy topic can read it.

Run `smoke:live` before a live session, and `journal:summary` after every paper session. Use
`report:performance` to judge settings, and change a setting only on a group with enough trades. Each entry
journals its strategy, posture, direction, option type, expiry, days to expiry and entry minute for this report.
Operator test trades are journalled as strategy `test`, so they never count as a strategy's results.

## Testing

```bash
npm run check   # typecheck + build + tests
```

The suite has 464 tests, all offline (the advisor is also exercised over HTTP against a local Ollama stub). They cover:

- the state machine's full transition table and illegal-transition rejection
- indicators, bar aggregation, and the ORB+SuperTrend signal, including session-boundary
  and previous-day contamination cases
- bracket geometry, tick rounding, lot sizing, contract selection, and expiry choice
- the pre-trade gate (every violation code), the day book, and the kill switch
- the paper venue (gap-through stops, targets fired once, rejected unknown exits)
- the live adapter against a fake broker: placement classification, fill confirmation,
  exit net-quantity guard, short-position halt, reconciliation, and duplicate suppression
- the Ollama advisor's fail-closed behaviour
- the Time Machine: rolling-option parsing and strike pivot, dataset validation, replay fills (target, stop,
  ambiguous bar, gap-through, time stop, EOD, data gap, spread), the live gate inside the replay, Wilson and
  bootstrap intervals, path drawdowns, and every verdict
- end-to-end runtime scenarios: winning trade, EOD flatten, gap-through stop plus
  daily-loss breach, advisor veto, stale data, unconfirmed entry halt, shutdown flatten,
  and refusal to start with broker positions open

**Not covered by tests:** the live DhanHQ wire behaviour. There are no broker credentials
in this environment. The items under [Verification required](#verification-required-before-live) must be
exercised against a Dhan sandbox or with a minimal-size live run.

## Verification required before live

These are assumptions the code depends on that the SDK docs do not settle:

1. **Super-order leg cancel.** `LiveExecutionPort` detaches the bracket with
   `superOrders.cancel({orderLeg: 'STOP_LOSS_LEG' | 'TARGET_LEG'})` before a manual exit. The
   SDK does not document the semantics once the entry has traded. If a leg cancel fails and
   the position is still long, the exit is refused and the underlying halts. Confirm the
   sequence on sandbox.
2. **Epoch convention.** Verified 2026-10-26/27: `DHAN_EPOCH_IST_SHIFTED=false` matches live bars
   (09:15 IST opens at 03:45 UTC), and Dhan's stray after-close history bar is now dropped.
3. **Chain and scrip-master fields.** Verified 2026-10-27 by `smoke:live` on NIFTY, BANKNIFTY and
   SENSEX: no chain leg lacks ltp, bid, ask, OI, volume or security id. The scrip master's
   `TICK_SIZE` is in paise and is converted to rupees (₹0.05).
4. **Freeze limits.** `MAX_LOTS_PER_ORDER` is user-set. Dhan's per-order freeze quantity for
   index options is not hardcoded here and must be set to the current exchange value.
5. **Broker kill-switch semantics.** Whether an activated kill switch also squares off open
   positions, and whether it blocks exit orders, is not documented in the SDK. The daily-loss
   path engages it only after flat for that reason.
   The local breach state is restored from today's journal on restart. The broker-side switch is
   the durable control: after a breach, reset it in the Dhan console only after reviewing the day.
6. **Holidays.** There is no NSE/BSE holiday calendar. The weekday cron starts the agent on
   holidays too; with no ticks there are no bars or signals, and the 15:45 stop ends it.
7. **Intraday warmup depth.** `WARMUP_DAYS` determines how many days of 5-minute bars are
   seeded. Confirm the Dhan response length for your chosen bar size.

### Staged rollout to real money

Do these in order, and do not start a stage until the previous one is clean:

1. **Paper evidence.** At least 30 paper trades on the current settings
   (`npm run report:performance -- --from <first day>`) with positive net expectancy. The Time
   Machine shows these rules near breakeven, so this gate may not pass.
2. **Sandbox.** `MODE=sandbox` with `DHAN_SANDBOX_*` for at least one full session. Watch one
   entry, its stop and target legs, a manual exit (`c` in the cockpit, which exercises item 1
   above), and the EOD flatten. Compare every order against the sandbox order book by hand:
   no tool here reconciles against Dhan.
3. **Live, one lot.** `MODE=live`, `LIVE_TRADING_ACK` set, `MAX_LOTS_PER_ORDER=1`, risk inside the
   built-in ceilings (2% per trade, 6% a day). Start it in the cockpit, not under cron, and check
   Dhan's order book against the journal after each trade and at the end of the day.
4. **Scale.** Raise lots only after a week of one-lot live sessions that match the journal.

## Known limits

- The Time Machine's data source (`/charts/rollingoption`) has not been checked against a live response from this
  environment. Run `timemachine fetch --dump-raw` once before trusting a dataset. It cannot replay the chain gate
  or quote-based liquidity gates. See [docs/TIME_MACHINE.md](docs/TIME_MACHINE.md#verification-required-before-trusting-a-dataset).
- Paper fills model neither queue position nor partial fills, and slippage is a flat bps
  parameter. Paper P&L is an approximation.
- The strategy's indicator parameters are not optimised. Treat paper results as a smoke test.
- The feed runs in the SDK's default `full` packet mode. The agent reads only LTP and last-traded time, so live bar volume is zero and no rule uses volume.

## What was removed

From `crypto-trading-agent` main (the full tree is in the baseline commit):

- `src/binance`, `src/coindcx`: exchange adapters (replaced by `src/dhan`)
- `src/strategies/smc-ml`, `src/minicpm`, `src/research`, `src/learning`, `src/backtesting`
- perpetual, funding, carry, crowding, and open-interest logic in `src/market`, `src/agents`,
  `src/decision`, `src/position`, `src/risk`
- crypto docs, improvement notes, scripts, and tests

The Ink dashboard was rebuilt for options rather than removed. See [Operator cockpit](#operator-cockpit).

`npm test` is a fresh suite for the index-options system. The dependency on
`@nemesis-oss/ollama-sdk` is kept and upgraded to the 1.13 line. The DhanHQ dependency is
`@nemesis-oss/dhanhq-sdk` is pinned exactly to 1.3.0 from npm. It replaces the earlier git pin
to commit `353901e` (v1.2.0).

## Layout

```
src/
  config.ts            validated env configuration
  time/                IST clock, calendar arithmetic, epoch conversion
  domain/              shared types, composite keys, trade FSM
  dhan/                SDK adapters: client, scrip master, market data, feed, live venue
  market/              indicators, bar builder and series
  strategy/            ORB + SuperTrend signal
  options/             bracket pricing, lot sizing, contract selection
  risk/                pre-trade gate, day book
  execution/           ExecutionPort contract, paper venue
  llm/                 Ollama advisor
  ops/                 event log, console logger
  runtime/             orchestrator, per-underlying agent, serial queue, clock guard, wiring, read-only views
  research/            Time Machine: dataset and rolling-option pivot, historical replay, bootstrap and paths (offline)
  ui/                  operator cockpit: pure renderer (cockpit.ts) and Ink app (App.tsx)
  index.tsx            entry point: cockpit on a terminal, plain logs otherwise
tests/                 offline suite (node:test via tsx)
```
