# Cockpit real data + hardening

Date: 2026-09-19 · Status: scope approved by the user in chat ("fix everything … cockpit clean-up, show real data, not fake or dummy");
design decisions below were delegated to and made by the controller.

## Goal
1. Every number and label in the TUI cockpit comes from live or persisted data. Nothing is removed from the layout; hard-coded
   mock values and fallback demo values are replaced by computed values, or by an honest `—` / "waiting for data" when a value
   does not exist yet.
2. Close the seven review items parked after the Adaptive SuperTrend work.

## Part A — Hardening (behavior changes)
| # | Change |
|---|---|
| A1 | `SymbolRules` gains `minQty` and `minNotional` (from LOT_SIZE.minQty and MIN_NOTIONAL.notional; default 0 = no limit). Executor refuses an order below either. `ExecutorAgent.execute` split so every function is ≤ 30 lines. |
| A2 | `BinanceService.openFuturesPosition` split so every function is ≤ 30 lines, behavior unchanged. |
| A3 | LOW-regime TP cap gets hysteresis: TP is pulled in only when it is more than `TP_TRIGGER_ATR × assignedAtr` beyond the cap (stops a write on every new mark low). Anchor filter requires the BTC state to come from the same or a newer closed candle than the alt being checked, so a failed BTC fetch cannot leave a stale direction in force. |
| A4 | `OllamaAdvisor` accepts an injected client, re-pings at most every 60 s while offline, and warns on a JSON reply with an unknown verdict (reason prefix `advisor`). |
| A5 | No floating promises around `loadSymbolRules().then(loop)` and the interval loop; the trailing pass and its extra `getPositions()` call run only in paper mode. |

## Part B — Cockpit real data
### Data model
- **Trade journal** (persisted in `paper-state.json` as `closedTrades`, newest last, capped at 1000):
  `{ symbol, strategy, side, entry, exit, qty, pnl, reason, closedAt }`, `reason ∈ CLOSE | FLIP | STOP LOSS | TAKE PROFIT | LIQUIDATED`.
  Written wherever the engine books realized PnL. `getTrades()`, and `getAccount()` also returns `initialEquity` (100 000).
  Old state files without the field load as an empty journal.
- **`src/binance/performance.ts` (new, pure)**
  - `winRate` = wins / closed × 100 (`pnl > 0` is a win); `null` with no closed trades.
  - `maxDrawdownPct`: equity curve = `[initialEquity, initialEquity + cumulative pnl after each trade in closedAt order, currentEquity]`;
    largest peak-to-trough fall in %, ≤ 0, `0` when flat/up only.
  - `sharpe`: daily returns (UTC day) = day realized pnl ÷ equity at the start of that day, zero-filled from the first trade day to
    today; needs ≥ 5 calendar days and non-zero deviation, else `null`; `mean / sample-std × √365`.
  - `var95`: 5th percentile (nearest rank, `floor(0.05 × n)` on ascending pnl) of per-trade pnl, needs ≥ 20 trades, reported as
    `min(0, p5)` in USD, else `null`.
  - `liquidations` = trades with `reason = LIQUIDATED`; `byStrategy[strategy] = { closed, wins, pnl }`.
  - `correlation(a, b)`: Pearson over aligned 15 m simple returns, needs ≥ 30 pairs, else `null`.
- **`src/runtime/telemetry.ts` (new, pure)**: `buildTelemetry(input) → Partial<AppState>` assembling everything below so
  `Orchestrator.ts` stays under 300 lines.

### AppState / types (all previously-mock fields become computed)
`initialEquity`, `totalPnl` (= equity − initialEquity), `totalPnlPct`, `successRate` (winRate), `sharpe`, `maxDd` (%), `var95`,
`liqEvents`, `sessionDecisions / sessionExecuted / sessionMonitored` (renamed from `today*`: counters are per bot session, not per day),
`apiWeight` (`x-mbx-used-weight-1m`), `wsStatus` (`connected | reconnecting | down`), `exposurePct` (Σ qty × mark ÷ equity × 100),
`minLiqDistancePct` (nearest liquidation across positions, replaces `liqBufferAtr`), `corrBtcEth`, `agents: AgentState[]`
(`winRate: number | null`, `progress` removed), `strategyMetrics` (below). Decision counters:
decisions = signals reaching the risk gate; executed = successful fills; monitored = signals rejected by the gate, vetoed, or skipped by cooldown.

`StrategyMetrics` = `{ fundingBySymbol: Record<sym,{rate,apr}>` (apr % = rate × 3 × 365 × 100)`, nextFundingCountdown, estNextFundingUsd`
(Σ FUNDING-ARB positions: notional × rate, sign + for shorts)`, zscoreBtcEth: number|null, atrBySymbol` (ATR14)`,
adaptive: Record<sym,{direction,regime,superTrend,distanceAtr}>, momentumAboveEma50: {up,total} }`.

### Agent fleet
Built each loop from real agent objects: id, `status`, strategy, open positions by `strategy`, closed-trade win rate, pnl =
realized (by strategy) + unrealized (open). PAIRS is listed as `PAUSED` because it is disabled in code; ADAPTIVE is `PAUSED` in live
mode; RISK-MGR is `WATCHING`. The progress bar now draws the win rate.

### UI (nothing removed; every cell wired)
- `panels.tsx` (298 lines) is split: `ui/format.ts` (padLine, boxLines, usd, fmtVol, fmtRange), `ui/accountPanels.ts` (header, col1, col3,
  col4, perf strip, footer), `ui/marketPanels.ts` (col2, metrics, detail, log), and `panels.tsx` (props, column/row sizing, table, resize
  warning, `renderCockpit`). `App.tsx` imports are unchanged.
- Literals replaced: header `●N ag` (running agents); fleet title `N active`; positions title `N open`; equity line `±$totalPnl (±pct% total)`;
  `Lev cap` from `config.risk`; asset list from `config.symbols` (no fallback prices — `—` until data); funding header = mean funding of
  the symbols with real settle countdown; market regime lines from candles/funding/adaptive states; POSITION ACTIONS lists the real
  positions with the selection marker; POSITION DETAIL shows real liq distance, SL, TP, margin and 1R (or "no open position");
  risk block = exposure `x% / maxExposurePct`, MaxDD `x% / -maxDrawdownPct`, nearest liq distance, BTC–ETH correlation, VaR and Sharpe (or `—`);
  strategy-metrics box = four real rows (FUNDING-ARB, PAIRS disabled + BTC/ETH z, MOMENTUM ATR + EMA50 breadth, ADAPTIVE-ST direction/regime/line);
  performance strip labelled `Session` with real counters; footer with running-agent count, `eval` from `LOOP_INTERVAL_MS`, real API weight
  `used/2400`, real websocket status. Empty log rows are blank. `store.ts` seeds nothing (empty positions/agents/logs/prices).
- No-mock guard: a test renders the cockpit with an empty state and with a realistic state and fails if any known mock literal appears
  (`27,766`, `142`, `96.4`, `2.84`, `1,842`, `18.7`, `0.91`, `247/1200`, `AVAX`, `ETH/USDT`, `SOL/USDT`, `BTC/ETH pairs`, `127.40`, `2750`, `7h58m`, `1.8x`, `2.1x`).

## Out of scope
Persisting session counters across restarts (they reset with the process and are labelled `Session`), unrealized-PnL drawdown,
live-mode dynamic exits, historical VaR from anything but closed trades.
