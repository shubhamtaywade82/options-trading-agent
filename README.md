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
| Paper venue on live market data, and live venue | Historical option backtesting (not yet, see Known limits) |

## Quick start

```bash
npm ci                       # installs @nemesis-oss/dhanhq-sdk pinned to a git commit (builds on prepare)
                             # CI rewrites github ssh URLs to https first; see .github/workflows/ci.yml
cp .env.example .env         # fill DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN
npm run typecheck && npm test
npm run dev:paper            # paper venue, live market data, simulated fills
```

Live trading needs `MODE=live` **and** `LIVE_TRADING_ACK=I_ACCEPT_LIVE_ORDER_RISK`. Without
both, the process exits before opening a socket.

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

**Brackets and sizing:** entry reference is the ask. Stop = ask × (1 − `STOP_LOSS_PCT`),
rounded up to tick. Target = entry + `TARGET_RR` × risk, rounded down to tick. Lots are
floored so that `lots × lotSize × (entry − stop)` fits `CAPITAL_INR × MAX_RISK_PER_TRADE_PCT`.
If one lot does not fit the budget, the trade is skipped. The agent never rounds risk up.

## Risk controls

| Control | Where | Behaviour |
| --- | --- | --- |
| Mandatory stop loss | `bracketLevels`, `evaluatePreTrade`, SDK super-order schema | Every entry carries a stop and target. An entry cannot be built without them, and the SDK rejects a super order that lacks either. |
| Max risk per trade | `sizePosition`, re-checked in `evaluatePreTrade` | Lots floored to budget. Zero lots means skip. |
| Max daily loss | `DayBook`, `Orchestrator.enforceDailyLoss` | Realised + unrealised day P&L ≤ −limit: entries blocked, all positions flattened, then broker kill switch. |
| Trades per day, open positions, one per underlying | `evaluatePreTrade` | Hard limits. |
| Cooldown per underlying | `DayBook` | `COOLDOWN_SECONDS` after each exit. |
| Entry window and expiry-day cutoff | `evaluatePreTrade` | Outside the window, or after `EXPIRY_DAY_ENTRY_CUTOFF` on expiry day: no entry. |
| Stale data | `evaluatePreTrade`, `DhanFeed.ageMs` | Spot tick older than `FEED_STALE_MS` (or never received) on local receipt time, or a chain snapshot older than `FEED_STALE_MS`: no entry. |
| Time stop, EOD flatten | `UnderlyingAgent.exitReason` | `MAX_HOLD_MINUTES`, and every position flattened at `FLATTEN_BY` IST. |
| Kill switch | `DayBook`, `engageBrokerKillSwitch` | Local block on entries; broker kill switch on halts and on daily-loss breach once flat. |
| Clock alignment | `assertWarmupClock` | Startup refuses if bar timestamps are inconsistent with the wall clock (wrong epoch convention). |
| Broker positions at start | `Orchestrator.start` | Refuses to start while the broker holds option positions. Reconcile manually first. |
| Day state across restarts | `restoreDayBook` | Day P&L, trade count, cooldown, and breach state are rebuilt from today's journal. A malformed journal line refuses startup. |

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

## Testing

```bash
npm run check   # typecheck + build + tests
```

The suite has 134 tests, all offline (the advisor is also exercised over HTTP against a local Ollama stub). They cover:

- the state machine's full transition table and illegal-transition rejection
- indicators, bar aggregation, and the ORB+SuperTrend signal, including session-boundary
  and previous-day contamination cases
- bracket geometry, tick rounding, lot sizing, contract selection, and expiry choice
- the pre-trade gate (every violation code), the day book, and the kill switch
- the paper venue (gap-through stops, targets fired once, rejected unknown exits)
- the live adapter against a fake broker: placement classification, fill confirmation,
  exit net-quantity guard, short-position halt, reconciliation, and duplicate suppression
- the Ollama advisor's fail-closed behaviour
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
2. **Epoch convention.** `DHAN_EPOCH_IST_SHIFTED` must match the feed. Startup checks this
   against warmup bars, but confirm against one live bar before trusting it.
3. **Chain and scrip-master fields.** Field mapping (`last_price`, `top_bid_price`,
   `top_ask_price`, `security_id`, `lotSize`, `tickSize`, `expiryDate`) is taken from the SDK
   types and must be checked against a live response.
4. **Freeze limits.** `MAX_LOTS_PER_ORDER` is user-set. Dhan's per-order freeze quantity for
   index options is not hardcoded here and must be set to the current exchange value.
5. **Broker kill-switch semantics.** Whether an activated kill switch also squares off open
   positions, and whether it blocks exit orders, is not documented in the SDK. The daily-loss
   path engages it only after flat for that reason.
   The local breach state is restored from today's journal on restart. The broker-side switch is
   the durable control: after a breach, reset it in the Dhan console only after reviewing the day.
6. **Holidays.** There is no NSE holiday calendar. On a holiday there are no bars and no
   signals, but the process still runs. Do not start it on exchange holidays.
7. **Intraday warmup depth.** `WARMUP_DAYS` determines how many days of 5-minute bars are
   seeded. Confirm the Dhan response length for your chosen bar size.

## Known limits

- No backtester for index options. Historical option premium replay needs a validated data
  source. The SDK exposes `expiredOptionsData`, but it is not wired here.
- Paper fills model neither queue position nor partial fills, and slippage is a flat bps
  parameter. Paper P&L is an approximation.
- The strategy's indicator parameters are not optimised. Treat paper results as a smoke test.
- The journal is read in full at startup. It grows with the audit trail and is not rotated yet.
- The feed runs in the SDK's default `full` packet mode. The agent reads only LTP and last-traded time, so live bar volume is zero and no rule uses volume.

## What was removed

From `crypto-trading-agent` main (the full tree is in the baseline commit):

- `src/binance`, `src/coindcx`: exchange adapters (replaced by `src/dhan`)
- `src/strategies/smc-ml`, `src/minicpm`, `src/research`, `src/learning`, `src/backtesting`
- perpetual, funding, carry, crowding, and open-interest logic in `src/market`, `src/agents`,
  `src/decision`, `src/position`, `src/risk`
- the Ink crypto dashboard and its panels (`src/ui`)
- crypto docs, improvement notes, scripts, and tests

`npm test` is a fresh suite for the index-options system. The dependency on
`@nemesis-oss/ollama-sdk` is kept and upgraded to the 1.13 line. The DhanHQ dependency is
`@nemesis-oss/dhanhq-sdk` pinned to commit `353901e` (v1.2.0 on `main`), which includes the
trading-write replay-safety fix. The npm registry's latest release is 1.1.0.

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
  runtime/             orchestrator, per-underlying agent, serial queue, clock guard, wiring
tests/                 offline suite (node:test via tsx)
```
