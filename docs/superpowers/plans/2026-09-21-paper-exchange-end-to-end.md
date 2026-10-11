# crypto-trading-agent + paper_exchange End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paper-trade the agent on the paper_exchange broker with a dedicated account, keeping exchange positions, wallet and agent state consistent across restarts, retries, outages and external changes.

**Architecture:** The exchange (Rails) owns wallet/positions/fills/fees/funding/liquidations; the agent keeps a sidecar file (owner, SL/TP, initial risk, trade journal) and evaluates SL/TP/trailing itself, closing with reduce-only orders. A `RemoteBroker` (agent) implements the venue behind `BinanceService`; an in-memory `FakeExchange` with the real exchange's accounting formulas lets every scenario run as a fast test, and the same scenario suite also runs against the real exchange.

**Tech Stack:** TypeScript (ESM, strict), Node test runner via `tsx --test`; Rails 8 + RSpec inside the `paper_exchange-api-1` container. No new dependencies.

**Spec (binding):** `docs/superpowers/specs/2026-09-21-paper-exchange-end-to-end-design.md`

## Global Constraints

- Never commit or stage anything in either repo (user's rule: ask first; no `Co-Authored-By`). Other people/sessions also edit both repos: touch only the files each task names.
- Agent repo (`/home/nemesis/projects/crypto-trading/crypto-trading-agent`): functions ≤ 30 lines, files ≤ 300 lines, nesting ≤ 3, params ≤ 4, why-only comments, no `any`; new source files only `src/binance/stopRules.ts`, `src/binance/remoteState.ts`, `src/binance/remoteBroker.ts` (a second file `src/binance/remoteExits.ts` is allowed if `remoteBroker.ts` would exceed 300 lines), plus tests and `scripts/e2e-paper-exchange.ts`. `client.ts` and `Orchestrator.ts` MUST end ≤ 300 lines (they are 443 and 366 now).
- Exchange repo (`/home/nemesis/projects/apps/paper_exchange`): Rails conventions of that repo (thin controllers, logic in services), RSpec for every change, run inside Docker: `docker exec paper_exchange-api-1 bash -lc "cd /rails && bundle exec rspec <paths>"` (the source is bind-mounted, changes are live). `accounts_controller.rb`, `routes.rb` and two smoke files already have someone else's staged edits — do not revert them.
- Never touch the real account `crypto-agent` or `data/paper-state.json` in tests; tests use in-memory fakes or a throwaway account id `e2e-<epoch>` on the real exchange. Do not start the TUI.
- Symbols come from `config.symbols`; agent always sends `execution_price` and a `client_order_id`; the agent whitelists symbols (the broker accepts anything).
- Wallet equity = `available_balance + locked_margin + Σ unrealized` (never the exchange's fee-blind `equity` field on the agent side).
- Baseline: `npx tsc --noEmit` clean, `npm test` green (run it first and record the count).

## File Structure

| File | Responsibility |
|---|---|
| exchange: `app/controllers/api/accounts_controller.rb`, `app/services/exchange/paper_exchange.rb`, `app/services/exchange/order_validator.rb`, `app/services/projections/portfolio_projection.rb`, `spec/**` | reset margin, reduce_only, fee-inclusive equity |
| `src/binance/paperExchangeClient.ts` | `ExchangeApi`, typed errors, retries, timeouts, `reduce_only`, `findOrder`, `getRiskEvents`, `createAccount` |
| `src/binance/stopRules.ts` (new) | shared SL/TP breach evaluation |
| `src/binance/remoteState.ts` (new) | sidecar persistence |
| `tests/support/fakeExchange.ts` (new test helper) | in-memory exchange with real accounting |
| `src/binance/remoteBroker.ts` (new) | venue: sync/reconcile/ownership/orders/exits/marks/funding/status |
| `src/binance/client.ts`, `src/runtime/Orchestrator.ts` | delegate to the broker; ≤ 300 lines |
| `src/types.ts`, `src/runtime/telemetry.ts`, `src/ui/accountPanels.ts` | venue label + status |
| `.env`, `.env.example`, `README.md`, `package.json`, `scripts/e2e-paper-exchange.ts` | config, docs, E2E runner |

---

### Task 1: Exchange — reset margin, reduce_only, fee-inclusive equity

**Files:** exchange repo: `app/controllers/api/accounts_controller.rb`, `app/services/exchange/order_validator.rb`, `app/services/exchange/paper_exchange.rb`, `app/services/projections/portfolio_projection.rb`, new/extended specs under `spec/`.

**Behavior (all spec-binding):**
1. `POST /api/account/reset` accepts `margin` (number, > 0; via query or JSON body). Without it the behavior is unchanged (env default 10 000). Still dev/test only.
2. Orders accept `reduce_only` (boolean). When true: if the account has no non-zero position for the symbol, or the order side does not oppose it → HTTP 422 with a clear message and no order row left `open`; otherwise `quantity` is clamped to the position quantity, the margin lock and risk gate are skipped (same as `internal`), and the fill/ledger/fee/realized-PnL paths are unchanged. A replayed `client_order_id` still returns the original order.
3. Account equity is fee-inclusive: `equity = available_balance + locked_margin + Σ unrealized_pnl` in `Projections::PortfolioProjection.summary` (so `GET /api/account` shows 10 087.37 in the probe scenario, not 10 100); `max_equity`/`drawdown` derive from that equity; the cached `Account#current_equity` refresh uses the same formula.

- [ ] **Step 1: Write failing specs** (adapt paths to the repo's spec layout; use existing factories/helpers) covering: reset with `margin=100000` creates an account with 100 000 available and no positions, and reset without margin keeps 10 000; `reduce_only` sell on a 0.1 long → fills, position 0, no margin needed even when `available_balance` is 0; `reduce_only` with quantity 1 on a 0.1 position → filled quantity 0.1; `reduce_only` buy on a long → 422; `reduce_only` with no position → 422 and no lingering open order; replay of the same `client_order_id` → same order, no second fill; after open 0.1 BTC @65 000 lev 5 (fee 2.6) then a mark push to 66 000, `GET /api/account` equity = 10 097.4 (= 8 697.4 + 1 300 + 100).
- [ ] **Step 2:** Run the new specs — expected FAIL.
- [ ] **Step 3:** Implement; keep controllers thin, put logic in services.
- [ ] **Step 4:** Run the full suite `docker exec paper_exchange-api-1 bash -lc "cd /rails && bundle exec rspec"` — expected: no new failures versus the baseline (record the baseline pass/fail counts before you start; pre-existing failures must be listed, not fixed).
- [ ] **Step 5: Probe against the running exchange** with a throwaway account (`X-Account-Id: probe-x1`, `curl`): reset with margin, open, reduce-only close, check equity. Report the outputs. Delete nothing else.
- [ ] **Checkpoint:** `git status --short` in the exchange repo; do not commit.

---

### Task 2: Client hardening

**Files:** Modify `src/binance/paperExchangeClient.ts`, `tests/paperExchangeClient.test.ts` (extend; keep passing existing tests that still apply, delete tests for removed protection orders).

**Interfaces (Produces):**
```typescript
export class VenueUnavailableError extends Error {}                       // network error, timeout or 5xx after retries
export class OrderRejectedError extends Error { constructor(message: string, readonly status: number, readonly body: string) }  // 4xx
export interface ExchangeRiskEvent { id: number; eventType: string; details: Record<string, unknown>; createdAt: string }
export interface SubmitOrderParams { /* existing */ reduceOnly?: boolean }   // marginType default becomes 'isolated'
export interface ExchangeApi {
  getAccount(): Promise<PaperExchangeAccountSnapshot | null>;               // null on 404
  createAccount(margin: number): Promise<void>;                            // POST /api/account/reset?margin=…
  getPositions(): Promise<PaperExchangePosition[]>;                        // rows with netQuantity <= 0 removed
  submitOrder(p: SubmitOrderParams): Promise<SubmitOrderResult>;
  findOrder(clientOrderId: string): Promise<SubmitOrderResult | null>;      // scans GET /api/orders
  getRiskEvents(): Promise<ExchangeRiskEvent[]>;
  pushMarkPrices(prices: Record<string, number>): Promise<void>;
  pushFundingEvent(symbol: string, fundingRate: number, markPrice: number, fundingTime: number): Promise<void>;
}
export class PaperExchangeClient implements ExchangeApi { constructor(baseUrl: string, accountId: string, opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; retries?: number; backoffMs?: number }) }
```
`getAccount` snapshot gains nothing new but must map `available_balance`, `locked_margin`, `margin`, `unrealized_pnl`, `realized_pnl`, `positions_count`, `equity`. Remove `submitProtectionOrder` and its types.

**Behavior:** every request has an abort timeout (default 5 000 ms); GETs and POSTs are retried (default 3 attempts, exponential backoff starting 250 ms, injectable for tests) **only** on network errors, timeouts and 5xx — never on 4xx; POSTs are only retried because they carry a `client_order_id`/funding_time; the final failure is `VenueUnavailableError` (5xx/network) or `OrderRejectedError` (4xx, message includes the response body); a 404 on `/api/account` returns `null`. Send `reduce_only` only when true.

- [ ] **Step 1: Write failing tests** with a scripted fake `fetch`: 5xx twice then 200 → succeeds after 3 calls with the same body/`client_order_id`; 4xx → `OrderRejectedError` after exactly 1 call; abort/timeout → `VenueUnavailableError` after the retry budget; `getAccount` 404 → `null`; flat rows (`net_quantity` "0.0") filtered from `getPositions`; `findOrder` finds by `client_order_id` and returns `null` when absent; `submitOrder` with `reduceOnly` sends `reduce_only: true` and `margin_type: 'isolated'` by default; `createAccount(100000)` posts to `/api/account/reset?margin=100000`; no `stop_loss`/`bounded` order is ever sent.
- [ ] **Step 2:** Run `npx tsx --test tests/paperExchangeClient.test.ts` — expected FAIL.
- [ ] **Step 3:** Implement (helper for retry/backoff; functions ≤ 30 lines). Update `client.ts` **only as far as needed to compile** (delete the protection-order calls; Task 7 replaces that code entirely).
- [ ] **Step 4:** Run the file, `npx tsc --noEmit`, `npm test`. Expected: pass.
- [ ] **Checkpoint:** no commit.

---

### Task 3: Shared stop rules

**Files:** Create `src/binance/stopRules.ts`; Modify `src/binance/paperEngine.ts`; Test: `tests/stopRules.test.ts`.

**Interfaces (Produces):**
```typescript
export function directionOf(side: Side): 1 | -1
export interface StopExit { price: number; reason: 'STOP LOSS' | 'TAKE PROFIT' }
/** SL fills at the current mark (a breached stop never fills at a better level), TP at its level; non-numeric labels never trigger. */
export function findStopExit(pos: Pick<Position, 'side' | 'mark' | 'serverSl' | 'serverTp'>): StopExit | null
```
`PaperEngine.findExit` keeps its liquidation check and calls `findStopExit` for SL/TP; behavior identical (all existing `paperEngine` tests pass unchanged).

- [ ] **Step 1: Failing tests** (`tests/stopRules.test.ts`): long SL breached (mark ≤ SL) → `{ price: mark, reason: 'STOP LOSS' }`; short SL breached; long TP breached → `{ price: TP, reason: 'TAKE PROFIT' }`; short TP; SL and TP both non-numeric (`'—'`, `'trail'`, `'fund'`, `''`) → `null`; mark exactly at SL triggers; mark between → `null`.
- [ ] **Step 2:** run → FAIL. **Step 3:** extract from `paperEngine.ts` (no behavior change). **Step 4:** `npx tsx --test tests/stopRules.test.ts tests/paperEngine.test.ts`, `npx tsc --noEmit`, `npm test` → pass.
- [ ] **Checkpoint:** no commit.

---

### Task 4: Sidecar store and fake exchange

**Files:** Create `src/binance/remoteState.ts`, `tests/support/fakeExchange.ts`; Test: `tests/remoteState.test.ts`, `tests/fakeExchange.test.ts`.

**Interfaces (Produces):**
```typescript
export interface PositionMeta { owner: AgentId; stopLoss: number | null; takeProfit: number | null; initialRisk: number | null; openedAt: number; external?: boolean }
export interface RemoteStateFile { version: 1; accountId: string; positions: Record<string, PositionMeta>; closedTrades: TradeRecord[] }
export class RemoteStore {
  constructor(filePath: string, accountId: string)      // loads if present; a different accountId or corrupt/invalid file starts empty
  getMeta(symbol: string): PositionMeta | undefined; setMeta(symbol: string, meta: PositionMeta): void; deleteMeta(symbol: string): void
  metas(): Record<string, PositionMeta>; addTrade(t: TradeRecord): void; trades(): TradeRecord[]   // cap 1000, oldest dropped
}
```
Every mutating call writes the file **synchronously and atomically** (temp file + rename) — the data is small and rare, and losing it on a crash would orphan strategy state.

**`FakeExchange` (implements `ExchangeApi` + test controls):** in-memory replica of the real exchange's measured accounting — market orders fill fully at `executionPrice`; margin lock = `qty × price / leverage`; taker fee 0.04 % of `qty × price` deducted from `availableBalance`; long liquidation price `entry × (1 − 1/lev + 0.004)`, short `entry × (1 + 1/lev − 0.004)`; same-side fill averages entry; opposite fill closes `min(qty, position)` (realized PnL credited to `availableBalance`, proportional margin released), remaining quantity opens the flipped position; closed positions remain as `netQuantity 0` rows (the API filters them); non-reduce orders need `availableBalance ≥ required margin` else `OrderRejectedError(…, 402, …)`; `reduceOnly` follows spec X1 (422 when none/same side, clamp, no margin check); replaying a `clientOrderId` returns the original order; `pushMarkPrices` re-marks and, when a mark crosses a liquidation price, closes the position at that mark, credits the loss, and records a `POSITION_LIQUIDATED` risk event; `pushFundingEvent` is idempotent per `(symbol, fundingTime)` (rate > 0: longs pay `qty × mark × rate`, shorts receive); `getAccount()` returns `null` until `createAccount(margin)`. Test controls: `down = true` makes every call throw `VenueUnavailableError`; `failNextPostAfterFill = true` fills the order then throws `VenueUnavailableError` for that response; `injectExternalOrder(side, qty, price, leverage)` places an order as an outside actor; `walletEquity()` returns `available + locked + Σ unrealized`.

- [ ] **Step 1: Write failing tests.** `remoteState.test.ts`: round-trips meta and trades across a new instance on the same file; atomic write leaves no `.tmp` file; corrupt JSON and a different `accountId` start empty; the 1001st trade drops the oldest. `fakeExchange.test.ts` (pins the accounting to the real measurements): open 0.1 BTC long @65 000 lev 5 → position qty 0.1, liquidation 52 260, `lockedMargin` 1 300, `availableBalance` 8 697.4; after `pushMarkPrices({BTCUSDT: 66000})` `walletEquity()` = 10 097.4; partial close 0.04 @66 000 → `availableBalance` 9 256.344, `lockedMargin` 780; flip sell 0.2 @66 000 on the 0.06 long → short 0.14 @66 000, `lockedMargin` 1 848; closing it leaves a `netQuantity 0` row absent from `getPositions()` and `availableBalance` 10 087.368; 402 when margin is insufficient; replay of a `clientOrderId` does not double fill; `down = true` throws `VenueUnavailableError`; liquidation via a mark push closes the position and records the risk event; funding: SHORT SOL 10 @100, rate 0.001, `fundingTime` T → `availableBalance` +1.0 once, replay with the same T adds nothing.
- [ ] **Step 2:** run both files → FAIL. **Step 3:** implement. **Step 4:** run both files + `npx tsc --noEmit` + `npm test` → pass.
- [ ] **Checkpoint:** no commit.

---

### Task 5: RemoteBroker part 1 — init, sync, reconcile, views, status

**Files:** Create `src/binance/remoteBroker.ts` (part 1); Test: `tests/remoteBroker.sync.test.ts` (use `FakeExchange` and a temp `RemoteStore`).

**Interfaces (Produces, part 1):**
```typescript
export type VenueState = 'connected' | 'degraded' | 'down';
export interface VenueStatus { name: 'paper_exchange'; accountId: string; state: VenueState; lastError: string | null; lastSyncAt: number }
export interface RemoteBrokerDeps { api: ExchangeApi; store: RemoteStore; accountId: string; symbols: string[]; initialMargin: number; now?: () => number }
export class RemoteBroker {
  constructor(deps: RemoteBrokerDeps)
  init(): Promise<void>                // create the account only if getAccount() is null (createAccount(initialMargin)); sync(); never resets an existing account
  sync(): Promise<void>                // getAccount + getPositions; on success state 'connected'; on VenueUnavailableError keep cache, state 'degraded' (1-2 consecutive failures) or 'down' (>= 3); then reconcile
  getAccount(): { equity: number; marginUsed: number; initialEquity: number }   // wallet equity with live re-marking; from the last successful sync (stale-flagged via status)
  getPositions(): Position[]           // qty > 0 only; strategy = meta.owner (external => 'EXECUTOR-ε'); serverSl/serverTp strings from meta ('—' when null); initialRisk from meta; marginType 'ISOLATED'; liqDistancePct from the exchange liquidation price; upnl/upnlPct re-marked from the latest local mark
  getTrades(): TradeRecord[]
  status(): VenueStatus
}
```
**Reconcile rules** are exactly the table in the spec (present/absent × exchange/sidecar; liquidation detection through `getRiskEvents()` newer than `meta.openedAt`, journal price = the event's `mark_price`, `pnl = (exit − entry) × qty × direction` from the last known position). Journal records use `reason` `'LIQUIDATED'` or `'CLOSE'`.

- [ ] **Step 1: Failing tests:** (S1) `init` on a fake with no account creates it with `initialMargin` (100 000) and a second `init` on an existing account does not reset it (an existing position survives); (S2/S21) after `injectExternalOrder`-free flow: with a fake position opened through the fake's API and sidecar meta set, `getPositions()` exposes owner/SL/TP/initialRisk/liq distance and `getAccount().equity` equals `fake.walletEquity()` (fees included), `initialEquity` 100 000; (S17) a fake position with no sidecar entry is adopted as external `EXECUTOR-ε` with `serverSl '—'`; (S18) a sidecar entry whose exchange position vanished is journaled `CLOSE` and deleted; (S10) with a `POSITION_LIQUIDATED` risk event newer than `openedAt` the same situation is journaled `LIQUIDATED` at the event mark; (S22) zero-quantity rows never appear; (S13) with `fake.down = true` for 3 syncs the status goes `degraded` then `down`, cached positions/account remain readable, and the first success restores `connected`; an external flip is journaled and re-adopted.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement (≤ 300 lines; if part 2 will not fit, put exits/orders in `src/binance/remoteExits.ts` as allowed). **Step 4:** run the file, `npx tsc --noEmit`, `npm test` → pass.
- [ ] **Checkpoint:** no commit.

---

### Task 6: RemoteBroker part 2 — orders, exits, marks, funding

**Files:** Modify `src/binance/remoteBroker.ts` (and `src/binance/remoteExits.ts` if needed); Test: `tests/remoteBroker.orders.test.ts`, `tests/remoteBroker.exits.test.ts`.

**Interfaces (Produces, part 2):**
```typescript
export interface OpenParams { symbol: string; side: 'BUY' | 'SELL'; qty: number; leverage: number; strategy: AgentId; stopLoss?: number; takeProfit?: number; entryPrice: number }
open(params: OpenParams): Promise<{ orderId: string; status: string }>
close(pos: Position, reason: ExitReason): Promise<void>            // reduce-only exact quantity; journals; 'CLOSE' for manual
markAll(prices: Record<string, number>): string[]                    // sync; see below
updateStops(symbol: string, strategy: AgentId, stopLoss: number, takeProfit: number): void
pushFunding(symbol: string, fundingRate: number, markPrice: number, fundingTime: number): Promise<void>
```
**Rules:**
- `open`: refuse with `VenueUnavailableError` when status is `down` (nothing sent); refuse with `OwnershipError` when the symbol is held by another owner (no order sent); new position → submit (client id `<symbol>-<strategy>-OPEN-<ms>-<nonce>`, the entry price is sent as `executionPrice`), require `status === 'filled'` (else re-sync and throw), then refresh positions, write meta `{owner, stopLoss, takeProfit, initialRisk = |fillPrice − stopLoss| or null, openedAt}`; same side by the owner → scale-in, meta SL/TP replaced when given, `initialRisk` unchanged; opposite side by the owner → reduce-only close of the full quantity (journal `FLIP`, meta deleted), then the new open; if the close succeeds and the open fails, the position is flat, the error is surfaced, no zombie meta. Every ambiguous failure (`VenueUnavailableError` after the request may have been sent) is resolved with `findOrder(clientOrderId)` then a re-sync before deciding success or failure; a 402/422 (`OrderRejectedError`) changes no sidecar/journal state.
- `close`/exits: re-read the position from the exchange right before sending (S23), send `reduceOnly` for exactly that quantity with client id `<symbol>-<strategy>-EXIT-<reason>-<ms>-<nonce>`, journal a `TradeRecord` (`exit` = fill price, `pnl` gross), delete the meta, re-sync; when the exchange is down the exit stays pending and is retried on later `markAll`/`sync` calls (S14) — exactly one exit order in the end.
- `markAll(prices)`: store the latest marks (used for live re-marking), push marks to the exchange for symbols that have a position — at most once per symbol per second, fire-and-forget with failures logged into `status().lastError` — evaluate `findStopExit` for every managed position (external ones excluded), start **one** async exit per breached symbol (in-flight guard, S24), and return the human-readable messages of exits that completed since the last call (`"STOP LOSS BTCUSDT LONG @ 65 000.00 pnl=-12.34"`, same format as the local engine).
- `updateStops` changes only the sidecar meta (persisted); ignored when the symbol has no managed meta for that strategy.
- `pushFunding`: forwards to the exchange with the settlement time as `fundingTime`; failures never throw into the loop.

- [ ] **Step 1: Failing tests** for each scenario: S2 open → exchange position matches, meta written, `initialRisk` correct; S3 scale-in average entry and SL/TP replaced; S4 other strategy refused, `fake` saw no order; S5 flip → journal `FLIP` with PnL, new position, meta owner; S6 SL breach via `markAll` (position exits at the mark, journal `STOP LOSS`, meta gone, message returned once); S7 TP; S8 `updateStops` persisted and visible after building a new broker on the same store file (S12: restart with an open position keeps owner/SL/TP and sends no order); S9 manual `close` → `CLOSE`; S11 `pushFunding` idempotent and reflected in `getAccount().equity`; S13 `open` while `down` sends nothing; S14 exit while down → pending, retried after recovery, exactly one exit order; S15 `failNextPostAfterFill` → `open` resolves by lookup, no duplicate order/position; S16 insufficient margin → `OrderRejectedError`, no meta/journal; S19 two symbols; S20 marks pushed at most once per second per symbol and for symbols with positions; S23 quantity changed externally before the exit → the exit uses the fresh quantity; S24 ten `markAll` calls while an exit is in flight → one exit order.
- [ ] **Step 2:** run both files → FAIL. **Step 3:** implement. **Step 4:** run both files, `npx tsc --noEmit`, `npm test` → pass; every file ≤ 300 lines, every function ≤ 30 lines.
- [ ] **Checkpoint:** no commit.

---

### Task 7: Wire the broker into BinanceService and Orchestrator

**Files:** Modify `src/binance/client.ts`, `src/runtime/Orchestrator.ts` (and small helpers where needed to reach the line limits), `src/config.ts` only if a setting is missing.

**Behavior:** in remote mode (`config.mode === 'paper' && config.paperExchange`) `BinanceService` builds `new RemoteBroker({ api: new PaperExchangeClient(...), store: new RemoteStore('data/remote-state.json', accountId), accountId, symbols: config.symbols, initialMargin: 100_000 })` and delegates `getAccount`, `getPositions`, `getTrades`, `openFuturesPosition` (→ `broker.open`), `closePosition` (→ `broker.close(pos, 'CLOSE')`), `markAll` (→ `broker.markAll`), `updateStops`, funding push, `getVenueStatus()`; all old `remotePaper` branches, protection-order code and mapping code are deleted; `dropUnlistedPositions` is a no-op remotely. `Orchestrator.start()` awaits `binance.initVenue()` (init the broker) **before** the first loop and logs failures (the loop then retries via `sync`); each loop `getPositions()` performs `sync()` first; the adaptive agent and the trailing pass run in remote mode exactly as in local paper mode (remove the remote-mode disabling code and log lines); `maybePushFunding` moves into the broker (or a helper it calls) and the Orchestrator only calls one method per loop; cooldown/veto/ownership refusals are logged as `warn` and counted as `monitored`, never as failures. `telemetry` gets `attributable: true` in remote mode. **Both files end ≤ 300 lines** (extract `gatherContext`/`refreshLiveTickers`/funding boundary detection into small helpers inside existing files or `remoteBroker`; no other new source files).

- [ ] **Step 1:** Read both files and the earlier tests; write a failing wiring test `tests/binanceService.remote.test.ts` that builds `BinanceService` with an injected `RemoteBroker` (add a constructor/factory seam, e.g. an optional `broker` parameter) over `FakeExchange`, and asserts: entries go through the broker, `getAccount`/`getPositions` reflect the fake, `markAll` returns exit messages, `updateStops` works, and no old remote code path remains.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement and shrink both files. **Step 4:** `npx tsc --noEmit`, `npm test`, `wc -l src/binance/client.ts src/runtime/Orchestrator.ts` (both ≤ 300), function-length audit of both files.
- [ ] **Checkpoint:** no commit.

---

### Task 8: Venue label and status in the cockpit

**Files:** Modify `src/types.ts`, `src/runtime/telemetry.ts` (+ its test), `src/runtime/Orchestrator.ts` (emit), `src/ui/accountPanels.ts` (footer), `tests/cockpit.test.ts`.

**Interfaces:** `AppState.venue: { name: string; state: 'connected' | 'degraded' | 'down' | 'local' }` (`name`: `paper_exchange (<accountId>)`, `local paper engine`, `BINANCE FUTURES`). Footer: `… │ mode PAPER │ venue <name> ●<state>` (`●` green connected / yellow degraded / red down; `local` renders no dot). The store seeds `{ name: '—', state: 'down' }`. While `down`, the cockpit shows `stale` next to the equity line (tests: text present only when down).

- [ ] **Step 1: Failing tests:** footer shows `venue paper_exchange (crypto-agent) ●connected` for a remote/connected state, `●down` and the `stale` marker when down, `venue local paper engine` for local paper, `venue BINANCE FUTURES` for live; the guard test still finds no mock literals; render sweeps still strictly shorter than the terminal and without `…` at `MIN_COLS`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement (if the footer no longer fits `MIN_COLS`, widen the floors and update `MIN_COLS` consistently). **Step 4:** `npx tsx --test tests/cockpit.test.ts tests/telemetry.test.ts`, `npx tsc --noEmit`, `npm test`, `npm run build`.
- [ ] **Checkpoint:** no commit.

---

### Task 9: Config, docs and the E2E runner

**Files:** `.env.example`, `README.md` (new root README section; issue #8), `package.json`, new `scripts/e2e-paper-exchange.ts`. (`.env` itself is edited by the controller in Task 10.)

**Behavior:** `.env.example` documents `PAPER_EXCHANGE_URL=http://127.0.0.1:3100` and `PAPER_EXCHANGE_ACCOUNT_ID=crypto-agent` (commented, with what they do). README documents: the two modes, how to start the exchange (`docker compose up -d` in `/home/nemesis/projects/apps/paper_exchange`), the account model (one shared account, ownership rule, agent-side exits), the sidecar file, what to do on account reset (delete `data/remote-state.json`), outage behavior, and the E2E command. `npm run e2e:paper-exchange` runs `scripts/e2e-paper-exchange.ts`: a scenario runner that executes S1–S24 through `RemoteBroker` against a backend chosen by `E2E_BACKEND=fake|real` (default `fake`; `real` requires `PAPER_EXCHANGE_URL`, uses a throwaway account `e2e-<epoch>`, refuses to run against an account id that is not prefixed `e2e-`), prints a pass/fail line per scenario with the exchange numbers it compared, and exits non-zero on any failure. Scenarios that need an outage or an external actor use the fake's controls on `fake` and are marked `SKIPPED (needs fake)` on `real` (S13–S15, except those that can be produced with a stopped/blocked URL: run S13 against `http://127.0.0.1:1` on `real`); liquidation (S10) on `real` pushes a mark price just beyond the liquidation price and waits up to 5 s for the asynchronous liquidation.

- [ ] **Step 1:** Write the runner; run `E2E_BACKEND=fake npm run e2e:paper-exchange` — expected all scenarios pass (this doubles as the integration test of Tasks 4–7).
- [ ] **Step 2:** `npx tsc --noEmit` (the script is outside `src/`; make sure it type-checks by running `npx tsc --noEmit --skipLibCheck scripts/e2e-paper-exchange.ts` or an equivalent), `npm test`.
- [ ] **Checkpoint:** no commit.

---

### Task 10: Real run, account creation, final review (controller)

- [ ] Create the real account: with the exchange Task 1 in place, `curl -X POST 'http://127.0.0.1:3100/api/account/reset?margin=100000' -H 'X-Account-Id: crypto-agent'`; verify `GET /api/account` shows 100 000.
- [ ] `E2E_BACKEND=real npm run e2e:paper-exchange` against a throwaway account; fix every discrepancy between fake and real (fake fidelity bugs → fix the fake; exchange bugs → fix in Rails with a spec).
- [ ] Add `PAPER_EXCHANGE_URL` / `PAPER_EXCHANGE_ACCOUNT_ID` to `.env`; run the real Orchestrator headlessly (a scratch script in the scratchpad importing `Orchestrator`, with the real Binance feed) for several loops and verify: account sync, cockpit state, mark push, a forced entry/exit through the agent, sidecar file, restart recovery.
- [ ] Final whole-change review on the strongest model (agent repo diff + exchange repo diff), one fix wave, one scoped re-review.
- [ ] Report: how to run everything, what was verified live, what remains.
