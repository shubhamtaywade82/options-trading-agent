# SMC ML Multi-Timeframe Execution

This strategy ports the supplied Pine Smart Money Concept ML logic into TypeScript while using @nemesis-oss/binance-sdk as the exchange boundary.

## Pipeline

    Binance USD-M futures WS kline close
            |
            v
    SmcMlRunner
            |
            +--> SDK REST klines: 5m / 15m / 1h / 4h (+1d optional)
            +--> SDK mark price
            |
            v
    SmcMlEngine
      - confirmed swing highs/lows
      - BOS / CHOCH
      - protected swing
      - ATR / volatility
      - FVG
      - order blocks
      - equal/swing liquidity
      - retest probability
      - liquidity first-touch probability
      - causal Bayesian logistic calibration (outcome-safe)
      - follow-through edge test
            |
            v
    SmcConfluence
      - timeframe-weighted score
      - agreement
      - no-trade reasons
            |
            v
    Execution candidates
      - MARKET
      - BREAK_CLOSE
      - RETEST_LEVEL
            |
            v
    Ollama SmcExecutionAdvisor
      - OPEN / ADD / EXIT / HOLD
            |
            v
    Deterministic portfolio policy
      - no position + aligned setup -> OPEN
      - same direction position + aligned setup -> ADD
      - strong admissible opposite confluence -> EXIT
      - no-trade confluence cannot force an automatic exit
      - stale setups produce no execution candidates
      - never reverse directly
      - one active execution cycle per symbol
            |
            v
    Binance SDK FuturesOps
      - risk-based sizing
      - tick/step/min-notional validation
      - bracket order

## Pine parity

The Pine retest event is a level touch. The Level Retest entry additionally requires a reclaiming close. The port preserves that distinction and exposes the reclaiming candle close as retestEntryPrice.

The supplied Pine signal bookkeeping scores TP1 partial exits. The initial Binance execution adapter places the protective stop and TP2; TP1 partial-close automation belongs in the execution/risk layer.

## Position policy

The LLM cannot invent levels, prices, quantity, leverage or indicators. It selects only an action and an existing candidate source.

    NO_POSITION + LONG confluence  -> OPEN LONG
    NO_POSITION + SHORT confluence -> OPEN SHORT
    LONG  + LONG confluence       -> ADD / HOLD
    SHORT + SHORT confluence      -> ADD / HOLD
    LONG  + strong SHORT          -> EXIT LONG
    SHORT + strong LONG           -> EXIT SHORT

Opposite-direction reversal is deliberately two-step: flatten first, then a later closed-candle cycle can create a new entry.

Before execution, the runtime re-reads the live position and rejects stale OPEN/ADD/EXIT decisions when the portfolio state changed. An already-flat EXIT is treated as idempotent.

## Install

    npm install @nemesis-oss/binance-sdk@^3.0.0

The feature branch adds the dependency to package.json. The existing package-lock.json still needs regeneration on a machine with npm registry access.

The SMC CI workflow validates only the strategy slice because the root package also contains an existing machine-local CoinDCX SDK dependency.

## Example

    const runtime = new SmcMlRuntime(client, advisor, {
      timeframes: ['5m', '15m', '1h', '4h'],
      candleLimit: 300,
      confluenceMinimum: 0.35,
      riskPct: 1,
      leverage: 5,
    });

    const runner = new SmcMlRunner(client, runtime, {
      symbols: ['BTCUSDT', 'ETHUSDT'],
      autoExecute: false,
    });

    await runner.start(({ cycle }) => {
      console.log(JSON.stringify({
        symbol: cycle.analysis.symbol,
        confluence: cycle.analysis.confluence,
        decision: cycle.decision,
        candidate: cycle.selectedCandidate,
      }, null, 2));
    });

Start with autoExecute=false and paper/testnet execution. Enable live execution only after deterministic backtests and forward paper validation.

## Trade lifecycle state machine

The execution candidate now has a deterministic lifecycle model:

    ENTRY
      -> TP1_PARTIAL
      -> BREAKEVEN
      -> TRAILING
      -> TP2 / CLOSED

The lifecycle is pure and side-effect free. It tracks the setup fingerprint, initial risk, remaining quantity, favorable excursion, TP1 state, breakeven state and a monotonic protective stop.

Default controls:

- TP1 closes 50% of the currently observed position.
- Breakeven activates only after TP1 and defaults to exact entry.
- Trailing starts after 1R favorable excursion after TP1.
- Trailing distance defaults to 0.5R.
- LONG stops can only move upward; SHORT stops can only move downward.
- TP2 produces a single close-remaining intent.
- A zero exchange position terminates the lifecycle as an external close.
- A terminal lifecycle emits no further actions.

The lifecycle deliberately produces **intents**, not exchange mutations. This prevents the state machine from pretending an order succeeded. The next execution-layer integration must atomically reconcile position/open orders around each intent, persist the setup lifecycle across process restarts, and consume Binance user-data order events. Binance USDⓈ-M user-data streams expose ORDER_TRADE_UPDATE for order creation, amendment and terminal state transitions, which is the appropriate event source for that integration.



## Live lifecycle integration

When `autoExecute=true`, the runner subscribes to:

- closed-candle kline streams for SMC analysis
- 1-second mark-price streams for lifecycle management
- USD-M user-data streams for `ACCOUNT_UPDATE` and `ORDER_TRADE_UPDATE`

The lifecycle coordinator keeps the latest position from account events and uses REST reconciliation immediately before mutations. This avoids a signed REST request on every mark-price tick while retaining a fresh exchange check at the point where an order is about to change.

The Binance lifecycle adapter uses the SDK's existing `FuturesOps.closePosition`, `FuturesTrading.modifyOrder`, and idempotent execution cancellation surface. Protective stop amendments are reconciled after a transport error instead of being blindly retried.

A lifecycle is registered only after a bracket entry has produced an observable open position and a protective stop order ID. Pending LIMIT/RETEST entries therefore remain outside the lifecycle until they become a live position; persistent pending-entry attribution is a later integration.

## Current lifecycle safety boundary

The current lifecycle is **position-level**, not individual-fill-level. Same-direction ADD operations continue to use the existing portfolio execution path; the active lifecycle manages the aggregate open position. Per-entry attribution, restart-safe persistent lifecycle storage, and exact multi-entry PnL accounting require the execution ledger integration before they should be treated as independent setup lifecycles.


### User-data recovery and ordering

The lifecycle coordinator tracks Binance user-data event time per symbol and ignores older updates, preventing a delayed account/order event from overwriting a newer lifecycle view. Zero-amount account updates invalidate the local position cache so the next lifecycle evaluation performs a fresh REST reconciliation rather than assuming the entire symbol is flat.

The runner also listens for listen-key expiry and requests a fresh user stream while retaining the same execution/lifecycle coordinator. Binance documents a 60-minute user-data stream validity window and recommends keepalive; its USD-M user-data documentation also identifies ORDER_TRADE_UPDATE and ACCOUNT_UPDATE as the key order/position events and describes event-time ordering.

