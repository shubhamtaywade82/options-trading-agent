# CoinDCX live execution, Binance for market data only

Date: 2026-09-22 · Status: scope approved by the user (chat brainstorm, architectural path). Every decision below was confirmed
in dialogue; two rounds used documented defaults after a 300s no-response timeout (SDK dependency, exit model, rollout
safety) and were not contradicted afterward.

## Goal
`MODE=live` keeps Binance as the sole source of market data (klines, websocket ticks) but routes ALL live execution —
account, positions, leverage, orders, closes — through CoinDCX futures. Paper trading (`MODE=paper`, either the local
`PaperEngine` or the `paper_exchange` broker) is untouched by this work. There is no silent fallback to direct
Binance order submission: if live mode starts without CoinDCX credentials, the process refuses to start.

## Decisions (controller / user, in dialogue order)
1. **SDK dependency.** `@nemesis-oss/coindcx-sdk` is a real standalone package at
   `/home/nemesis/projects/sdks-and-clients/coindcx/coindcx-sdk` (not the crypto-agent repo, not on npm). Add it as a
   `file:` dependency in `package.json`, the same way any local workspace package is consumed. Do not vendor/copy its
   source; do not port `crypto-agent`'s `execution-broker.ts` (it depends on the vendored `@nemesis-oss/*` domain
   types we are explicitly not bringing over) — write a new, thin adapter against OUR types instead (see Components).
2. **Exit model: agent-side**, same as `paper_exchange`. SL/TP/trailing stop are evaluated locally against live ticks
   (`stopRules.ts`, already shared with the local engine and `RemoteBroker`); a breach sends a reduce-only market
   order for the exact position quantity. CoinDCX's own `attachTPSL` (server-side, fixed price) is NOT used — it
   cannot express the Adaptive SuperTrend's dynamic trailing stop.
3. **Margin currency: USDT preferred, INR auto-fallback per symbol.** Port `crypto-agent`'s `SymbolRouter` /
   `pair-mapper.ts` logic: for each configured Binance symbol, resolve `B-BASE_USDT` if CoinDCX lists it, else
   `B-BASE_INR`. `COINDCX_QUOTE_PREFERENCE=auto|USDT|INR` (default `auto`) overrides the preference. Sizing and risk
   stay USDT-denominated everywhere (equity, risk budget, R-multiples); only the final order price/quantity is
   converted to INR at submission time for an INR-routed pair, using a live USDT/INR rate pulled from CoinDCX's own
   public spot ticker (`USDTINR` / `T-USDT_INR`), cached with a freshness policy (fresh < 30 s, stale-usable < 120 s).
   An order on an INR pair with no usable rate is refused, never submitted at a guessed price.
4. **Rollout safety: CoinDCX paper mode first.** `COINDCX_PAPER_MODE=on|off` (default `on`) routes the same
   `CoinDcxBroker` through the SDK's own paper engine instead of its live REST client, so the full plumbing (account,
   positions, orders, market-data split, sidecar) can be verified before `off` sends real orders.
5. **Legacy direct-Binance live order code stays but becomes dead code.** `BinanceService`'s existing
   `submitNewOrder`-based live path (`client.ts`) is not deleted, but nothing calls it once this lands — live
   execution always resolves to `CoinDcxBroker`. If `MODE=live` and `COINDCX_API_KEY`/`COINDCX_API_SECRET` are
   missing, the process logs a `CRITICAL` line and refuses to start (fail-closed; no fallback to raw Binance orders).
6. **Safety limits.** `COINDCX_MAX_ORDER_NOTIONAL` / `COINDCX_MAX_ORDER_QUANTITY` wire into the SDK client's
   `setSafetyLimits`, a hard cap enforced below and independent of `RiskAgent`'s own sizing — defense in depth for
   real money (matches the user's financial-code rules).
7. **Starting balance for CoinDCX paper mode: $1,150 USDT**, matching `PaperEngine` and `paper_exchange` exactly —
   one bankroll across all three paper venues, easy to compare. If the SDK's paper engine is INR-denominated
   internally, seed it with the USDT-equivalent conversion at construction time, not a separately-chosen INR figure.

## Components
### `src/coindcx/` (new; all files ≤ 300 lines, functions ≤ 30 lines)
- `coindcxClient.ts` — thin wrapper constructing `CoinDCXClient` from the SDK with `apiKey`/`apiSecret`/`paperMode`
  from config; no business logic.
- `symbolRouter.ts` — ported `SymbolRouter` + `pair-mapper.ts` pure functions (`futuresPair`, `parseFuturesPair`,
  `baseAssetOfBinanceSymbol`) adapted to our `AgentId`/`Candle`-free symbol strings; 5-minute instrument-list cache;
  `usdtInr()` FX cache with the freshness policy from Decision 3.
- `contractSpec.ts` — per-resolved-pair instrument metadata (lot size, min qty, min notional, max leverage) from
  `client.futures.market.getInstrumentDetails`, used ONLY for execution-time rounding; `RiskAgent`'s ATR/candle
  reasoning keeps reading Binance market data untouched.
- `coindcxBroker.ts` — implements the same seam `BinanceService` already delegates to for paper mode: `init`, `sync`,
  `getAccount`, `getPositions`, `getTrades`, `status`, `open`, `close`, `markAll`, `updateStops`, `pushFunding`
  (funding may be a no-op/log-only if CoinDCX doesn't expose a comparable feed — confirm in Task planning). This
  mirrors `RemoteBroker`'s public surface (`src/binance/remoteBroker.ts:73-183`) so `RiskAgent`, `ExecutorAgent` and
  `Orchestrator` need no changes beyond the construction seam.
- Sidecar: `data/coindcx-state.json` via the existing `RemoteStore` pattern (owner/SL/TP/initial risk/journal per
  symbol) — reuse `RemoteStore` directly if its constructor is generic enough (it already takes a file path and
  account id), else a minimal adapted copy. Ownership rule and one-position-per-symbol carry over unchanged.

### Wiring
- `BinanceService`'s constructor seam (`broker: RemoteBroker | null`, `client.ts:51`) generalizes to accept either a
  `RemoteBroker` (paper) or a `CoinDcxBroker` (live) behind their shared method surface. Selection logic:
  `MODE=paper` → today's `remoteBrokerFromConfig()` (unchanged); `MODE=live` → `coinDcxBrokerFromConfig()`, which
  throws a startup error if credentials are missing (Decision 5).
- Market data (`startRealtimeStream`, kline fetch) stays on `this.futures` (Binance `USDMClient`) in every mode —
  no change to that code path.
- Cockpit: venue label becomes `venue CoinDCX ●<status>` in live mode (existing venue-label cell, no new row); append
  `(INR)` only when a position/order actually routed through an INR pair and it still fits at `MIN_COLS`.
- Kill-switch, audit trail, Telegram alerts (Phase 2, already shipped) are venue-agnostic through the existing
  `Orchestrator` seams — no changes needed beyond the venue label.

### Config additions (`src/config.ts`)
`COINDCX_API_KEY`, `COINDCX_API_SECRET`, `COINDCX_PAPER_MODE=on|off` (default `on`),
`COINDCX_QUOTE_PREFERENCE=auto|USDT|INR` (default `auto`), `COINDCX_MAX_ORDER_NOTIONAL`, `COINDCX_MAX_ORDER_QUANTITY`.

## Scenario checklist (each is a test)
Symbol routing: USDT preferred when listed; INR fallback when USDT is not listed; `COINDCX_QUOTE_PREFERENCE=INR`
forces INR even when USDT exists; unlisted symbol on both quotes throws (never a synthetic price).
FX: fresh rate used as-is; stale-but-usable rate used; unavailable rate refuses the INR order (no submission).
Exits: SL/TP/trailing breach sends a reduce-only close sized to the live position quantity; one in-flight exit per
symbol (mirrors `paper_exchange` scenario S24).
Fail-closed: `MODE=live` with no CoinDCX credentials refuses to start; paper mode and Binance-only market data are
never affected by a CoinDCX outage in that case (they simply never construct a `CoinDcxBroker`).
Safety limits: an order above `COINDCX_MAX_ORDER_NOTIONAL`/`_QUANTITY` is rejected client-side before it reaches the
SDK's HTTP call.
Ownership: one position per symbol enforced the same way as `RemoteBroker`; a position found with no sidecar entry
is adopted as external and never touched by strategies.
Rollout: `COINDCX_PAPER_MODE=on` routes through the SDK's paper engine end to end (account, order, position, exit)
with zero real HTTP calls to CoinDCX's live endpoints.

## Out of scope
CoinDCX private websocket streams (`account-stream.ts` — poll like `RemoteBroker` does instead); spot/margin trading
(futures only); multi-account; HTTP/MCP surfaces; changing `paper_exchange` or the local `PaperEngine` (those keep
their own, separately-decided starting balance — see Decision 7).

