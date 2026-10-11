# Research log — is there an edge?

Status as of 2026-09-30: **no validated edge** in any strategy family tested. Do not size real capital on these rules.
Everything below is reproducible from scripts in this repo; numbers are copied from actual runs.

## Method (what each tool answers)

| Question | Tool |
|---|---|
| Where do decisions go, and why are they refused? | `scripts/analyze-decisions.ts` |
| Does the entry signal beat a coin flip? (before costs) | `edgeVsCoinFlip` (in `analyze-decisions`, `replay-decisions`) |
| Net expectancy per strategy after costs, per RR floor | `scripts/calibrate-rr.ts` |
| Would rejected ideas have worked? (real 5m price path) | `scripts/replay-decisions.ts` |
| Full pipeline on history, net of fees | `scripts/backtest.ts` (`--end-days-ago` for unseen windows) |
| Delta-neutral funding carry | `scripts/carry-backtest.ts` |

Rules followed: pre-commit a rule, test it on a window it was not found in, charge all costs, report the coin-flip baseline,
and treat a single slice at p ~ 0.05 among many as noise.

## 1. Live paper journal (Sep 27–30, 99 decisions)
3 executed, 1 closed (ADAPTIVE XRP long, −0.53R). 93 refused: capacity 37%, circuit breaker 33%, stop-width ("liq buffer") 29%.
The stop-width check measured ATR on candles including the forming one, so stops placed at exactly 1.2 ATR read ~1.19 and were refused (fixed).
Capacity refusals were dominated by positions on the paper account that this agent did not open (owner `EXECUTOR-ε`, no stop, ~3x equity notional).

## 2. Backtest, two 90-day windows, four symbols, $100k each, after fees
Costs per fill: 4 bps fee + 1 bp half-spread + 3 bps slippage.

| | Jul–Sep | Apr–Jul |
|---|---|---|
| BTC | +4.0% (4 trades) | −8.4% (14) |
| ETH | +0.6% (34) | −3.3% (25) |
| SOL | −2.9% (36) | +2.8% (27) |
| XRP | −8.3% (36) | −3.2% (20) |

196 trades pooled: 64 target hits vs 62.2 expected from random entries (z = 0.28, p = 0.39).
MOMENTUM n=131: net −0.164R (90% lower bound −0.319). STRUCTURE-TREND n=64: net −0.070R (lower bound −0.323).
Only MOMENTUM and STRUCTURE-TREND ever executed; CROWDING cannot be backtested (no historical positioning data), MEAN-REVERT proposed 779 times and never fit the risk model.

## 3. Why only some ideas can trade
Sizing is `risk / (stop + costs)` and the engine refuses, not shrinks, a trade that breaches the exposure cap. With 1% risk,
an 80% cap and 0.12% round-trip costs a stop must be >= 1.13% of price. Fit rates: MEAN-REVERT 0/779, STRUCTURE-TREND 222/1476,
MOMENTUM 216/464. Zero executed trades had a narrower stop. Every backtest trade therefore comes from the wide-stop subset.

## 4. Hypothetical outcomes of 1,510 distinct ideas (tight stops included)
Net R per idea after costs, and entry timing vs a coin flip (target hits vs expected):

| Slice | n | Net R | z |
|---|---|---|---|
| MEAN-REVERT (all tight) | 494 | −0.50 | −2.07 |
| MOMENTUM wide / tight | 195 / 216 | −0.03 / −0.13 | −0.34 / +0.25 |
| STRUCTURE-TREND wide / tight | 82 / 504 | +0.07 / −1.79 | −0.19 / −1.76 |

Cost share of the stop shows a dose-response: <0.15R: −0.08R; 0.15–0.35R: −0.19R; 0.35–0.7R: −0.51R; >=0.7R: −4.55R (6% win).
Stops under 0.25%: 10% win, −3.1R. No stop-width region is profitable. STRUCTURE-TREND emits degenerate stops (0.001–0.007% from entry).

## 5. Funding carry (long spot, short perp, 2x isolated, mark-price liquidation), annualised on capital, always in
| Window | BTC | ETH | SOL | XRP | mean funding BTC / ETH (APR) |
|---|---|---|---|---|---|
| Oct 22–Oct 23 | 2.13% | 1.06% | — | — | 5.6% / 5.2% |
| Oct 23–Sep 24 | 4.91% | 5.62% | — | — | 11.8% / 13.0% |
| Sep 24–Sep 25 | 3.05% | 3.09% | −3.45% | −5.18% | 7.1% / 7.4% |
| Sep 25–Sep 26 | 1.40% | 0.95% | −0.92% | −0.07% | 3.4% / 2.5% |

Active entry/exit rules lost to churn (37–48 cycles at ~0.36% each); a slow rule (lookback 21, min hold 21) was no better than always-in on the latest window.
BTC/ETH average about 2.7–2.9% a year on capital; with portfolio margin (capital = spot leg) the notional return averages about 4%.
Not modelled: borrow, spot yield, margin top-ups, counterparty risk.

## 6. Corrections made along the way
- STRUCTURE-TREND looked like a credible loser in one window (−0.40R, n=35) and did not replicate (+0.36R, n=29): retracted.
- Backtest trade metrics were before fees while equity was after; now all net (`grossPnl` reported separately).
- Carry liquidations were checked against last-price wicks; Binance liquidates on mark price: fixed.

## 7. Not tested
Derivatives flow (OI, liquidations, taker delta, book imbalance) — no historical data beyond ~30 days; maker-only execution; other timeframes
and instruments; cross-symbol relative value. The live setup outcome ledger (`data/setup-outcomes.jsonl`) is the start of the dataset those need.

## 8. Live gate (added 2026-09-30)
No strategy currently passes `scripts/live-readiness.ts`, so `MODE=live` would trade nothing. The gate is enforced twice: the
orchestrator drops unapproved OPEN signals before the journal and alerts, and `RiskAgent.gate` refuses them as defence in depth.

## 9. Market-data recorder (added 2026-09-30)
`scripts/record-market-data.ts` records 1-minute flow/derivatives features going forward. Probing found that Binance's legacy USD-M
websocket endpoints no longer deliver aggTrade, markPrice or forceOrder (the `binance` npm library 2.15.22 routes those to the legacy
URL; its raw `@trade` stream, which the agent uses for live prices, still works). The recorder uses `/market` and `/public` directly.
Minimum useful dataset: several weeks across more than one volatility regime before testing any flow hypothesis.

## 10. Pre-registered flow hypotheses (committed 2026-09-30, before any recorded data was examined)
Recording started 2026-09-30; at the time of this commit under five hours existed and none had been analysed. Fixed rules, in `src/marketdata/EventStudy.ts`:
- **H1** — net long liquidation notional over 5 minutes in the top 5% of its first-half distribution predicts a bounce (buy); net short liquidation predicts a drop (sell).
- **H2** — 5-minute net aggressor imbalance in the top 5% (by magnitude) predicts continuation in its direction.
- **H4** — 5-minute mean book imbalance in the top 5% (by magnitude) predicts direction (bid-heavy up, ask-heavy down).
Horizons 5/15/30/60 minutes, 12 tests, Bonferroni alpha 0.0042, n >= 30 events, events non-overlapping within the horizon, thresholds from the first half of the data,
events counted in the second half, costs 16 bps round trip. A pass is a lead to re-test on later data; it does not approve a strategy (see section 8).

## 11. Conditional edge and microstructure state (added 2026-10-06)
Motivation: a pooled −0.16R can hide a positive regime slice, but slicing 7 strategies × 6 regimes × 5 volatility phases × 2 sides
gives hundreds of cells, and some will look profitable by chance. The tooling therefore tests the *selection rule*, not the slices.

- Every decision now journals `context` (`regime`, `volatilityPhase`, 15m ATR percentile, ADX). Volatility phase
  (`COMPRESSED` ≤ 20th pct, `NORMAL`, `EXPANDING` ≥ 75th, `EXTREME` ≥ 95th) is a level, independent of the directional regime,
  so TREND_UP + COMPRESSED and TREND_UP + EXTREME are different cells. Bins are descriptive, not fitted. Older records group as `UNKNOWN`.
- `scripts/conditional-edge.ts` reads any decision journal with outcomes (backtest journal, or
  `scripts/replay-decisions.ts --write-hypothetical` for every idea including rejected ones) and reports:
  - an in-sample matrix by `--dims` (strategy, regime, phase, side, symbol) with a **day-clustered** bootstrap interval
    (same-day trades across correlated symbols resample together) and **Holm** family-wise correction across every tested cell;
  - a **rolling walk-forward**: on each train window select cells with bootstrap lower bound > 0, using only outcomes that closed
    before the window ended; pool the decisions those cells produced in the next, non-overlapping test window. Only a positive
    out-of-sample lower bound counts, and even that is a lead for `live-readiness`, not an approval.
- `src/marketdata/MicrostructureState.ts` classifies recorded minutes into price × OI (`LONG_BUILD`, `SHORT_BUILD`, `SHORT_COVER`,
  `LONG_LIQUIDATION`) and taker flow (`BUY/SELL_DOMINANT`, `BUY/SELL_ABSORBED`) with z-scores against the symbol's own trailing
  240-minute baseline; it refuses to classify across gaps or without OI. `scripts/microstructure-state.ts` prints the current state and
  label frequencies. It is not wired into strategies or `MarketState`: the recording is a week old, and no label has been tested
  for predictive value. Any such test must be pre-registered as a new hypothesis id in `EventStudy.ts` before looking at outcomes.
