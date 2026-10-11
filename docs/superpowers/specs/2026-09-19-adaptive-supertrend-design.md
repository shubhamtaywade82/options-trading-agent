# Adaptive SuperTrend entries + regime-aware trailing exits

Date: 2026-09-19 · Status: design approved in chat, spec awaiting review

## Goal
Add an ML Adaptive SuperTrend (AlgoAlpha, K-Means volatility clustering) entry strategy for crypto
futures, with dynamic trailing SL/TP driven by the volatility regime, and an LLM that can only veto entries.
Paper mode only for v1.

## Decisions (from brainstorming)
- Entries are deterministic; Ollama may **veto** (never originate). Ollama down/slow (5s) → proceed, log warn.
- Runs **alongside** MomentumAgent (not a replacement). Paper positions are keyed symbol+strategy, so both can hold
  opposite sides on one symbol. Real Binance one-way mode nets them → adaptive agent + dynamic exits are **not
  registered in live mode** (log a warning at startup).
- 15m timeframe, closed candles only, both directions, entries skipped when regime is LOW.

## Components

### 1. `src/binance/adaptiveSuperTrend.ts` (new, pure)
Port of the Pine indicator. Input `Candle[]` (closed only) → `AdaptiveSuperTrendResult[]`.
- ATR: Wilder RMA series (own implementation; existing `indicators.atr()` is an SMA scalar and stays untouched).
- Training window 100, ATR length 10, factor 3, initial centroids at 75/50/25% of window high–low, 3-cluster K-Means
  (max 100 iterations, stop on convergence). Empty cluster keeps its previous centroid. Ties break toward the
  higher-volatility cluster so no observation is dropped.
- SuperTrend: `src=(high+low)/2`, bands = `src ± factor × assignedCentroid`; proper ratchet (lower band only rises,
  upper band only falls, unless previous close crossed it). State (bands, line, direction) carried across **every**
  bar; bars before the training window are skipped for output but never break the state.
- Output per bar: `atr`, three centroids, `regime` (`HIGH|MEDIUM|LOW`), `assignedAtr`, `superTrend`,
  `direction` (`BULLISH|BEARISH` — Pine's inverted -1/+1 stays internal), `trendShift`
  (`BULLISH|BEARISH|null`), `regimeShift` (`HIGH|MEDIUM|LOW|null`), `candle`.
- Batch recompute over ~300 candles per new closed candle per symbol (≈ms). No streaming engine (YAGNI at 15m).

### 2. `src/agents/AdaptiveSuperTrendAgent.ts` (new)
`BaseAgent`, id `ADAPTIVE-ST-ζ` (added to `AgentId`).
- `analyze(ctx)`: per symbol in `config.symbols`, drop the forming candle, compute indicator, remember
  `lastProcessedOpenTime` per symbol so a closed candle is handled **once** (idempotent across the 8s loop).
- Exposes `stateFor(symbol)`: latest closed-candle result, used by exits and the veto snapshot.
- On `trendShift` and regime ≠ LOW emits `OPEN_LONG`/`OPEN_SHORT`:
  `entry = ctx.marks[symbol]` (current mark), `stopLoss = superTrend line`,
  `takeProfit = entry ± k(regime) × assignedAtr`, `k = {LOW:2, MEDIUM:3, HIGH:4}`.
- **BTC anchor (added after approval):** BTCUSDT is analysed first each loop. An alt flip (ETH, SOL, XRP…) is skipped unless
  BTC's current SuperTrend direction matches it; BTC itself is unfiltered; unknown BTC state blocks alts; the filter is off
  when BTCUSDT is not in `config.symbols`.
- Sizing, leverage, liq-buffer: unchanged `RiskAgent.gate` (SL distance ≈ 3 × assigned ATR clears the 2× ATR buffer).

### 3. `src/agents/TrailingStopManager.ts` (new, pure)
`nextStops(position, state) → { stopLoss, takeProfit }`. Called by the orchestrator **every loop** for open
`ADAPTIVE-ST-ζ` positions; stateless and idempotent, so repeated 8s calls within one candle are harmless.
Long shown; short mirrors.
- **SL = max(currentSL, superTrend line)** — ratchet-only. A flip against the trade crosses the line, so the stop
  handles it; no separate flip exit.
- **Breakeven:** once `mark ≥ entry + 1R` (`R = position.initialRisk`), `SL = max(SL, entry)`.
- **TP trail:** if `mark ≥ TP − 0.5 × assignedAtr` then `TP += 1 × assignedAtr` and
  `SL = max(SL, oldTP − 1 × assignedAtr)` (lock gains near the prior target).
- **LOW-regime cap:** while regime is LOW and the trade is in profit, `TP = min(TP, mark + k(LOW) × assignedAtr)`
  (stateless replacement for "tighten TP on regime shift").
- Applied through new `BinanceService.updateStops(symbol, strategy, sl, tp)` → `PaperEngine.updateStops`,
  which only sets `serverSl`/`serverTp`; the existing `markAll` performs the trigger.

### 4. LLM veto (`src/ollama/advisor.ts`, extend)
`veto(snapshot): Promise<{ verdict: 'PROCEED'|'VETO'; reason: string }>`. Snapshot = symbol, side, regime,
distance from SuperTrend line in ATR, RSI, funding rate, entry/SL/TP. Runs in `Orchestrator.processSignals` after
`risk.gate` approves and before the executor, for `ADAPTIVE-ST-ζ` signals only. JSON-constrained prompt; any
parse error, timeout (5s) or offline → `PROCEED` + warn log. The class doc comment ("NEVER makes trading
decisions") is updated to say it may only veto.

## Changes to existing code
- `types.ts`: `AgentId += 'ADAPTIVE-ST-ζ'`; `Candle.openTime: number`; `Position.initialRisk?: number`.
- `client.ts`: `getKlines` maps `openTime` (k[0]); market overview fetches **300** candles; `updateStops`.
- `paperEngine.ts`: set `initialRisk = |entry − SL|` on create (unchanged on scale-in); `updateStops`.
- `Orchestrator.ts`: register agent (paper only), exit-manager pass each loop, veto hook, per-agent cooldown —
  `BaseAgent.cooldownMs` defaults to 15 min (Momentum); the adaptive agent uses 0 because it is already
  idempotent per candle and a fixed 15-min cooldown would swallow the next candle's flip.
- `store.ts`: add the agent row. `package.json`: `"test": "tsx --test tests/*.test.ts"` (built-in runner, no dependency).

### 5. Per-symbol precision (added after approval, user request)
`src/binance/symbolRules.ts` (new) holds `{ pricePrecision, quantityPrecision, tickSize, stepSize }` per symbol, loaded once at
startup from Binance `exchangeInfo` (fallback 2dp price / 3dp quantity with a warn log if the load fails).
- Orders: executor rounds quantity **down** to the lot step and entry/SL/TP to the tick; a size below one lot is refused.
  Live protective orders use the same rounding. Trailing stop updates are rounded before they are stored.
- Display: prices and quantities in the cockpit use the symbol's own decimals; every other figure is 2dp. Funding rates stay
  at 4dp because 2dp would hide real values (open question for the user).

## Error handling
Fewer than 109 closed candles (ATR warm-up 10 + training window 100) → no output, agent silent. NaN/non-positive ATR → bar skipped, state preserved.
Missing `stateFor` for a position's symbol → manager leaves stops untouched. Veto failures fail open (above).
Executor symbol whitelist and paper-engine "no price" rejection still apply.

## Testing (`tests/`, `node --test`)
- `adaptiveSuperTrend.test.ts`: Wilder ATR vs hand-computed values; K-Means centroids on a synthetic ATR series;
  band ratchet never loosens; `trendShift` fires exactly once per crossing; state survives the training warm-up;
  forming-candle exclusion in the agent (no repaint).
- `trailingStopManager.test.ts`: each rule above, long and short, plus idempotence (call twice → same result).
- Optional golden test: export ~150 bars plus the indicator's SuperTrend/centroid columns from TradingView and assert
  within tolerance. Needs data from the user; without it fidelity is verified by invariants only.

## Out of scope (v1)
Live-mode dynamic exits (needs netting/stop-replacement design), fees/funding accrual, total-exposure cap,
two-leg pairs, streaming (WebSocket kline) engine.
