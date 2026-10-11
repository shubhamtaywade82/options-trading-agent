# crypto-trading-agent + paper_exchange, end to end

Date: 2026-09-21 · Status: user asked for a complete, working, end-to-end system covering all scenarios; the account model
(**one shared account**) was chosen by the user; every other decision below was made by the controller from probes of the running exchange.

## Goal
`MODE=paper` with `PAPER_EXCHANGE_URL` set makes the agent trade on the paper_exchange Rails broker (`http://127.0.0.1:3100`, Docker)
with its own dedicated account, and keeps both sides consistent: the exchange holds the wallet, positions, fills, fees, funding and
liquidations; the agent holds strategy state (who owns a position, SL/TP, trailing stops, initial risk, trade journal) and shows the
exchange's truth in the cockpit. Restarting either side, the exchange being down, retries, and external changes must never corrupt or
duplicate positions.

## Verified facts about the running exchange (probed on 2026-09-20 with a scratch account)
| Fact | Consequence |
|---|---|
| `POST /api/orders` market order fills fully at `execution_price`; replaying a `client_order_id` returns the original order (no double fill) | agent always sends both; retries are safe |
| Opposite-side order larger than the position **flips** it atomically; a closed position stays as a `quantity 0` row | closes must be sized exactly; the agent filters `quantity 0` rows |
| No `reduce_only`; closing orders still lock margin first (a low-margin account could fail to close) | add `reduce_only` to the exchange (X1) |
| Server-side resting `stop_loss` / `bounded` orders are **never re-evaluated** when mark prices arrive (only liquidation is), they lock extra margin, and the broker has no price feed of its own so nothing could trigger while the agent is offline anyway | **exits are managed by the agent** (reduce-only market orders); the existing "protection order" code is removed |
| Fee 0.04 % is taken from `available_balance`, but the account's `equity` field = `margin + realized + unrealized` ignores fees (10 000 → 10 087.37 wallet vs 10 100 reported) | agent computes wallet equity itself; exchange `equity` fixed in X1 |
| `POST /api/mark_prices` drives liquidation; a breached position is closed **asynchronously** by `LiquidationJob` at the pushed mark; a `POSITION_LIQUIDATED` risk event is written | agent detects by reconciliation and journals `LIQUIDATED` |
| `POST /api/funding_events` is async (202) and idempotent on `funding_time`; positive rate: longs pay, shorts receive | agent pushes once per settlement |
| 402 on insufficient margin, 422 on quantity ≤ 0; unknown symbols and missing `execution_price` are accepted | agent whitelists symbols and always sends a price |
| `GET /api/performance` returns nonsense for a used account (realized −31 592 on a 10 000 account) | agent computes its own statistics from its journal |

## Decisions
1. **Source of truth.** Exchange: wallet, positions (qty, entry, leverage, liquidation price), fees, funding, liquidations.
   Agent sidecar: owner strategy, SL, TP, initial risk per position, and the closed-trade journal.
2. **One account** `crypto-agent` (`PAPER_EXCHANGE_ACCOUNT_ID`), starting margin 100 000 (USDT, matches the local engine). The agent creates
   it on startup **only if missing** (`GET /api/account` → 404 → `POST /api/account/reset?margin=…`, dev only); it never resets an existing account.
3. **Ownership rule** (positions net per symbol on the exchange, like Binance one-way mode): a symbol is owned by the strategy that
   opened it. Another strategy's entry on an owned symbol is refused before any order is sent. The owner may scale in (same side) or
   flip (opposite side: full reduce-only close, journal `FLIP`, then a new position). A position found on the exchange with no
   sidecar entry (manual/curl trade, lost sidecar) is adopted as external (`EXECUTOR-ε`, no SL/TP) and never touched by strategies.
4. **Exits are agent-side**: SL / TP / trailing stops are evaluated against the agent's own price ticks; a breach sends a reduce-only
   market order for the exact position quantity, one in-flight exit per symbol. Liquidation stays server-side.
5. **Wallet equity** = `available_balance + locked_margin + Σ unrealized` where unrealized is re-marked locally from live ticks;
   `initialEquity` = the account's starting `margin`; `marginUsed` = `locked_margin`. Fees and funding are therefore inside equity/PnL.
6. **Journal PnL is gross** (`(exit − entry) × qty × direction` at the exchange fill price); fees and funding show up in equity and total PnL,
   not in per-trade records (cockpit labels stay honest: win rate / Sharpe / VaR come from gross trade PnL).
7. **Idempotency**: every logical order has one `client_order_id` = `<symbol>-<strategy>-<kind>-<epochMs>-<nonce>` created once and reused on
   every retry. After an ambiguous failure (timeout after send) the agent looks the order up by `client_order_id` before deciding, then
   re-syncs positions from the exchange.
8. **Outage semantics**: venue status `connected | degraded | down`. While `down`, entries are refused (`VenueUnavailableError`), the loop and cockpit
   keep running on cached data marked stale, exits keep retrying with backoff, and recovery is automatic (re-sync + reconcile).
9. **Venue is shown honestly** in the footer: `venue paper_exchange (<account>) ●<status>` / `venue local paper engine` / `venue BINANCE FUTURES`.
   A `stale` marker sits next to the equity line whenever the venue is `degraded` or `down` (last known data). `PAPER_EXCHANGE_ACCOUNT_ID` is required when `PAPER_EXCHANGE_URL` is set.
10. **Post-review hardening (all implemented and tested):** reduce-only is re-checked and clamped under a row lock inside the fill transaction, and the liquidation job is reduce-only (a concurrent close can never flip a position); a partial exit whose position was grown externally restores the strategy's meta so the remainder keeps its stops; a venue outage never starts the signal cooldown; an account the agent had to re-create clears the sidecar's position metas (no fabricated journal); broker notices (adoptions, dropped entries) reach the cockpit log.

## Components
### Exchange (`/home/nemesis/projects/apps/paper_exchange`, Rails; RSpec in the container)
- **X1a** `POST /api/account/reset` accepts `margin` (dev/test only; default unchanged so existing smoke tests keep working).
- **X1b** `reduce_only` on orders: rejects (422) when there is no position or the order is not opposite to it, clamps quantity to the position's, and skips the
  margin lock/risk gate (like `internal`). Idempotent replay unchanged.
- **X1c** account `equity` is fee-inclusive: `available_balance + locked_margin + unrealized` (also the cached `current_equity`, `max_equity`, `drawdown`).
### Agent (`crypto-trading-agent`)
- `paperExchangeClient.ts`: `ExchangeApi` interface; timeouts; bounded retry with backoff for GETs and for idempotent POSTs; typed errors
  (`VenueUnavailableError`, `OrderRejectedError`); `reduce_only`; `findOrder`; `getRiskEvents`; `createAccount`; flat rows filtered; protection orders removed.
- `stopRules.ts` (new): shared SL/TP breach evaluation used by the local engine and the remote broker.
- `remoteState.ts` (new): sidecar `data/remote-state.json` (`{version, accountId, positions: {symbol: PositionMeta}, closedTrades}`), atomic writes, cap 1000 trades.
- `remoteBroker.ts` (new): init/ensure account, sync + reconcile, ownership, open/scale/flip/close, exits, mark-price push (throttled), funding push, venue status, live re-marking.
- `BinanceService` delegates to `RemoteBroker` in remote mode (its old remote branches are deleted; `client.ts` ≤ 300 lines); `Orchestrator` initialises the
  broker before the first loop, no longer disables the Adaptive agent or trailing stops in remote mode, and drops its funding-push code (moved into the broker); `Orchestrator.ts` ≤ 300 lines.
- Telemetry/UI: `venue` label + status; `attributable` is true in remote mode (ownership gives real per-strategy attribution).
- Tooling: `.env` / `.env.example` / README, `npm run e2e:paper-exchange`.

## Reconcile rules (every sync)
| Exchange position | Sidecar entry | Action |
|---|---|---|
| qty > 0 | present | keep; sidecar owner/SL/TP/initial risk apply |
| qty > 0 | absent | adopt as external (`EXECUTOR-ε`), log warn |
| none / qty 0 | present | position ended off-agent: if a `POSITION_LIQUIDATED` risk event for the symbol is newer than `openedAt` → journal `LIQUIDATED` at the event's mark price, else journal `CLOSE` at the last known mark; delete entry |
| side flipped vs sidecar (external flip) | present | journal the old position `CLOSE`, adopt the new one as external |

## Scenario matrix (each is a test; the E2E suite runs every one against the in-memory fake **and** the real exchange)
S1 account missing → created with 100 000; account exists → left untouched · S2 open long: exchange position/margin/fee match the agent's view ·
S3 scale-in: average entry · S4 ownership conflict refused, no order sent · S5 flip: full close then new position, journal `FLIP` ·
S6 SL breach → reduce-only exit, journal `STOP LOSS`, sidecar cleaned · S7 TP breach → `TAKE PROFIT` · S8 trailing stop update persists across restart ·
S9 manual close (`c`) → journal `CLOSE` · S10 server-side liquidation detected, journal `LIQUIDATED`, sidecar cleaned · S11 funding pushed once, equity reflects it ·
S12 agent restart mid-position: positions, owner, SL/TP recovered, no duplicate order · S13 exchange down at entry: refused, nothing sent ·
S14 exchange down during exit: retried, one exit only after recovery · S15 timeout after the order actually filled: lookup by `client_order_id`, no duplicate ·
S16 402 insufficient margin: error, no sidecar/journal change · S17 external position appears: adopted, not touched by strategies ·
S18 agent-managed position closed externally: detected, journaled `CLOSE` · S19 multi-symbol positions at once · S20 mark-price staleness: pushes at least every loop for symbols with positions ·
S21 equity/PnL/margin in the cockpit equal the exchange's wallet numbers (fees included) · S22 dust/zero-quantity rows ignored · S23 exit while the position quantity changed externally uses the fresh quantity ·
S24 repeated exit trigger while an exit is in flight does not send a second order.

## Out of scope
Server-side stops (impossible without a price feed on the broker), multiple agent accounts, live-Binance trailing exits, changing the broker's liquidation to fill at the liquidation price,
exchange `/api/performance`, symbol validation in the broker (the agent whitelists), PairsAgent.
