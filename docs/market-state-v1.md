# Market State V1

## Purpose

Market State V1 introduces a shared, deterministic market-intelligence snapshot without changing order generation, risk approval, or execution behavior.

The design is intentionally incremental. Existing agents continue to run exactly as before. Strategies can opt into the new state in later iterations after the state detectors are validated with historical replay.

## Current inputs

The first implementation uses the existing 15-minute Binance kline feed and derives higher timeframes locally:

- 15m native candles
- 1h resampled candles
- 4h resampled candles

This avoids adding new REST traffic in the first rollout.

The state also computes:

- Wilder ATR
- ADX
- EMA 20/50/200 where enough history exists
- EMA slope
- ATR percentile
- RSI
- rolling VWAP
- Bollinger bands
- trend/range/transition regime
- swing highs/lows
- BOS / CHOCH events
- equal-high/equal-low liquidity pools
- swing/range liquidity
- latest liquidity sweeps
- cause-zone POIs derived from the latest structural break
- HTF premium/discount location
- mean-reversion deviation statistics

## Important limitations

The current state intentionally does not pretend to observe information that the existing Binance data layer does not yet fetch.

Not included yet:

- open interest
- global long/short ratios
- top-trader positioning
- taker buy/sell imbalance
- order-book imbalance
- basis
- native 1m / 5m candles

Those belong to the next market-data iteration.

The current 4h state is derived from 15m candles, so its history is limited by the existing 15m fetch depth. Native 1h/4h data can be introduced later when the data scheduler is ready to add TTL-based REST caching.

## Safety contract

MARKET_STATE_V1=on is read-only in this iteration.

It:

1. Builds the snapshot during Orchestrator.gatherContext().
2. Places it on MarketContext.marketState.
3. Does not create signals.
4. Does not modify existing signal logic.
5. Does not change risk sizing or approval.
6. Does not change the LLM veto.
7. Does not send any additional orders.

Set MARKET_STATE_V1=off to disable snapshot construction while retaining all existing trading behavior.

## Detector definitions

### Regime

- TREND_UP: HTF directional alignment plus ADX >= 25.
- TREND_DOWN: HTF directional alignment plus ADX >= 25.
- RANGE: ADX <= 20.
- TRANSITION: all other states.

Volatility is separately represented as LOW/MEDIUM/HIGH from the percentile of the current Wilder ATR within the available history.

These thresholds are implementation defaults, not validated trading edges.

### Structure

Swing points use a symmetric pivot detector. A swing is only available after the required right-side candles exist, so the detector does not use future bars beyond confirmation.

A close crossing a confirmed swing level creates:

- BOS when it agrees with the existing structural direction.
- CHOCH when it breaks against the existing structural direction.

### Liquidity

The detector models:

- equal highs/lows using an ATR-scaled tolerance
- recent swing highs/lows
- recent range high/low

A sweep is recorded when price trades through the liquidity level and the same candle closes back through that level.

### Cause zone

For the latest BOS/CHOCH, the detector finds the nearest opposite-color candle in a short lookback as the candidate origin zone. The result is explicitly a heuristic POI, not a claim about hidden institutional orders.

## Next iterations

1. Native lower timeframe feeds with TTL/staggered refresh.
2. Binance derivatives positioning data.
3. Signal fusion and candidate scoring.
4. Structure + liquidity trend strategy.
5. Mean-reversion strategy.
6. Crowding/contrarian strategy.
7. Portfolio-level correlation and exposure gates.
8. Execution quality/slippage model.
9. Replay/backtesting and walk-forward validation.
