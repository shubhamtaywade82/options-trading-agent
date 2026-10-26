# Time Machine: historical replay of the live strategy

`src/research/` and `scripts/timemachine.ts` replay the live entry and exit rules over historical sessions, priced
on real option premiums, and then measure how much of the result is evidence and how much is noise. It is a
research tool. It imports no order code, never touches the live risk gate, and no result changes the agent's
behaviour.

```bash
npm run timemachine -- fetch --underlying NIFTY --from 2026-04-01 --to 2026-09-30 --lot-size 75 --dump-raw
npm run timemachine -- run --data data/research/NIFTY-2026-04-01-2026-09-30.json --config config.paper.yml
```

`fetch` makes read-only Dhan calls. `run` needs no credentials and no network.

## Origin: the day-trader-skill pack

The idea comes from `trader-timemachine` in
[Jakeschincariol/day-trader-skill](https://github.com/Jakeschincariol/day-trader-skill) (MIT, Python, US stocks
on Yahoo 5-minute bars). Its source (`trader-timemachine/timemachine.py`) was read before this was written. What it
does:

- It builds a pool of underlying 5-minute bars, each stored as open/high/low/close ratios to the previous close,
  from up to 60 full sessions.
- It builds 10,000 paths by drawing each remaining bar independently (iid) from the same time-of-day slot (±2
  bars), then counts target-first, stop-first and neither. A bar that touches both counts as the stop.
- It re-runs the same rule on the past sessions as a "history" check.

The method does not carry over to buying index options:

| Gap in the original | Consequence for options buying | What this implementation does |
| --- | --- | --- |
| Simulates the underlying, not the premium | A correct direction call can still lose to theta, IV crush and spread | Prices every fill from the held strike's own premium bars |
| iid draws of single bars | Destroys volatility clustering and intraday trend persistence, which are what ORB/SuperTrend trade | No synthetic intraday paths. Resampling is over whole days, in blocks |
| No costs | Index options round trips cost ₹40+ brokerage plus STT, exchange fees and GST, which is material per lot | `roundTripChargesInr` (the live estimate), half-spread on every fill, extra slippage on stops |
| Point estimates only | 33 historical fires give a win-rate CI about ±17 points wide | Wilson intervals on every rate, block-bootstrap interval on mean net R |
| History and simulation share one 60-day window | Nothing is out of sample | Chronological in-sample / out-of-sample split; the verdict requires both |

### The other ten skills against this repository

| Skill | Status here | Action |
| --- | --- | --- |
| `trader-scanner` | Covered: `StrategySession` evaluates five setups per index on closed bars | None. A stock universe scan does not apply to index options |
| `trader-news` | Missing | Candidate: an Indian event-risk calendar (RBI policy, budget, expiry, results of index heavyweights) as an entry block. Not built |
| `trader-entry` | Covered: closed-bar signals, entry window, stale-data gate, serial queue | None |
| `trader-exit` | Covered: `bracketLevels`, trailing stop, time stop, EOD flatten, structure exit | None |
| `trader-risk` | Covered: `evaluatePreTrade`, `DayBook`, broker kill switch | None. The replay calls this gate directly |
| `trader-budget` | Covered: `sizePosition`, whole lots floored to the risk budget | None |
| `trader-broker` | Covered: paper, sandbox and live execution ports, live acknowledgement | None |
| `trader-alerts` | Partly covered: the cockpit and the journal | Optional: push notifications for halts and kill-switch events |
| `trader-analyst` | Not applicable (single-stock earnings) | Skip |
| `trader-pelosi` | Not applicable (US congressional disclosures) | Skip |

## Three methods, three questions

The methods answer different questions, so the report labels each number with the method that produced it.

| Method | Question it answers | What it cannot tell you |
| --- | --- | --- |
| **Historical replay** (`replayDataset`) | What did these exact rules do on these exact days, after costs? | Whether the result was luck. It is one path |
| **Block bootstrap of days** (`bootstrapMeanR`) | How sure can we be that mean net R per trade is above zero, given only these days? | Anything about regimes that are not in the sample |
| **Monte Carlo day paths** (`simulatePaths`) | If the next N days are a reordering of these days, how wide are P&L and drawdown? | The probability of a future profit. It assumes the future looks like the sample |

Both resamplers draw whole days in circular moving blocks, with block length about n^(1/3) days. A day's trades
stay together, and days with no trade are kept, so trade frequency is part of the sample. The seed defaults to
19, and every interval can be reproduced from it.

None of these is a forecast. Ten thousand resamples of a biased sample only reproduce the bias with more
decimal places.

## Fidelity to the live agent

Live code that the replay calls unchanged: `StrategySession.evaluate` (all five strategies and postures),
`contextVerdict`/`marketContext`, `structureTurnedAgainst`, `nearestAtmStrike`/`targetEntryStrike`,
`bracketLevels`, `calculateTrailingStop`, `sizePosition`, `evaluatePreTrade` and `roundTripChargesInr`.

| Live behaviour | Replay |
| --- | --- |
| Signal on a closed bar, inside the entry window by the clock | Same, at bar close time |
| LIMIT entry at ask × (1 + `ENTRY_LIMIT_BUFFER_PCT`), cancelled after `ORDER_TIMEOUT_MS` (30 s) | Fill at the next bar's open plus half-spread. Bracket and sizing come from the limit, as in live |
| Stop leg triggers on LTP | Stop when the bar's low ≤ stop. A gap below the stop fills at the open, not at the stop |
| Target leg is a sell limit | Target when the bid (high − half-spread) ≥ target. A gap above fills at the target, not at the better open |
| Bar touches both stop and target | Counted as the stop, and flagged. Over 20% of trades flagged means 5-minute bars are too coarse for the bracket |
| Trailing stop moves on every tick | Moves on the bar high and takes effect from the next bar (never inside the bar that set it) |
| Time stop, `FLATTEN_BY`, structure exit, daily-loss exit | Executed at the next bar's open at the bid |
| Pre-trade gate | `evaluatePreTrade` itself, fed the replay's day book (trade count, cooldown, daily loss, loss at risk, expiry cutoff) |
| Missing premium print for the held strike | The trade is marked `DATA_GAP` and removed from the statistics. Above 5% of trades, the verdict is `INSUFFICIENT_EVIDENCE` |

What is **not** replayed. The report prints this list with every run:

- The chain OI-resistance gate (`CHAIN_ANALYSIS`). There is no historical option chain, so trades it would have
  vetoed are included.
- The chain-bias vote in the context gate. It is replayed as `NEUTRAL`, which makes the gate stricter, not looser.
- `MAX_SPREAD_PCT`, `MIN_OPEN_INTEREST` and `MIN_VOLUME`. Bars carry no quotes. The default half-spread is
  `MAX_SPREAD_PCT / 2`, the widest spread the live gate accepts, so the default cost model is the worst accepted case.
- Expiry choice. Expiry follows the dataset's `--expiry-code`, not `MIN_DAYS_TO_EXPIRY`/`MAX_DAYS_TO_EXPIRY`.
- Concurrent CE and PE positions. The replay holds one position at a time.

## Verdict

| Verdict | Condition |
| --- | --- |
| `INSUFFICIENT_EVIDENCE` | Fewer than 30 priced trades (the same threshold as `report:performance`), fewer than 10 out-of-sample trades, or more than 5% data-gap trades |
| `NO_TRADE` | The bootstrap 95% interval of mean net R does not lie above zero, or the out-of-sample mean net R ≤ 0 |
| `EDGE_SUPPORTED` | Otherwise |

`EDGE_SUPPORTED` means only that this sample does not contradict a positive expectancy after modelled costs. It
does not authorise live trading. Every parameter sweep is another test on the same days: if you try k
configurations and keep the best, its interval is optimistic by roughly a factor of k. Judge a chosen setting on
days that were not used to choose it.

## Data source: Dhan `/charts/rollingoption`

`client.expiredOptionsData.fetch` in `@nemesis-oss/dhanhq-sdk` 1.3.0 posts to `/charts/rollingoption`.
Facts verified from the SDK source:

- Strikes are **relative to ATM at each bar** (`ATM`, `ATM+1`, `ATM-2`, …). The request takes the underlying's
  security id, not a contract's. One series is therefore not one contract. `fetch` pulls ATM±`--offsets` and
  `pivotByStrike` re-keys every bar by the `strike` column, which rebuilds each fixed contract's series. A held
  strike that drifts beyond the fetched band leaves its series, and the trade becomes `DATA_GAP`.
- The SDK validates `expiryCode` 1–10, `interval` 1/5/15/25/60, and a range of at most 180 days.
  `fetch` uses 30-day windows.
- The SDK passes the response body through **untyped**. Its declared type (`data?: ExpiredOptionsDataPoint[]`)
  is not what the parser expects. `parseRollingOptionResponse` accepts only the column layout
  `{ data: { ce | pe: { open, high, low, close, strike, timestamp, volume? } } }` and refuses anything else with
  the keys it found.

### Implied volatility and open interest

`fetch` also requests `iv` and `oi`. A live account returned both columns, plus `spot`, on 2026-10-26, and
served 1-minute bars as well as 5-minute ones. They are stored per option bar as optional fields, so older
datasets without them still load. IV is the source's annualised implied volatility in percent.

`run --iv-exit-pts N` adds a research-only exit: once the held strike's IV closes N vol points below its
entry-bar IV, the replay exits at the next bar's open (`IV_CRUSH`). The live agent has no such exit, and the
report says so. Bars without IV never trigger it.

## Verification required before trusting a dataset

These items cannot be verified from this environment (no broker credentials):

1. **Response layout.** Run `fetch` once with `--dump-raw` on a short range and check `<out>.raw-CE.json` against
   the layout above. A mismatch fails the fetch rather than producing a wrong dataset.
2. **Timestamp convention.** Option bars are converted with `DHAN_EPOCH_IST_SHIFTED`, the same switch as spot.
   `parseDataset` refuses bars outside 09:15–15:30 IST, which catches a 5h30m error but not a smaller one.
3. **Offset band.** How many ATM offsets Dhan serves for each index and expiry type. Lower `--offsets` if
   requests fail. A large `DATA_GAP` count means the band is too narrow for the moves in the range.
4. **Expiry code at the roll.** Whether `expiryCode 1` on expiry day refers to that day's expiry or the next.
   This decides whether expiry-day theta is in the sample.
5. **Expiry dates.** The rolling source does not return them, so the expiry-day entry cutoff is skipped (the
   report warns). An expiry calendar per underlying would close this.
6. **Lot size.** It is given per fetch (`--lot-size`). Split a fetch at every exchange lot-size revision.
