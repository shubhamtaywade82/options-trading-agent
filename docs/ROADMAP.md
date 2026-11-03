# Roadmap

Where this agent goes next, in order, with the gate each step must pass. Revised 2026-11-03 against `main` at
`32874ca`. The branch `ccr-e5f824c3-nhd407` carries seven further commits (listed under Phase 1, marked on branch). It
extends what exists; it is not a rewrite.

## Where the repository actually stands

Read this before any plan. Four facts set the order of everything below.

1. **No strategy has shown a net edge, and the untouched holdout is spent.** Time Machine on NIFTY, BANKNIFTY and SENSEX
   (2025H2–2026H1, about 550 priced trades each) returns mean net R between −0.004 and +0.046. The one
   `EDGE_SUPPORTED` verdict (NIFTY 2025H) used a 0.25% half-spread; at 1% the same family is `NO_TRADE`. The first
   context-cell holdout (NIFTY 2026H) passed nothing. But 2026H had already been used: exit variants (stop %, R target,
   time stop, IV-crush exit) were tested on NIFTY 2025-10..2026-09, which contains NIFTY 2026H, and on SENSEX and
   BANKNIFTY 2026-04..09 (`TIME_MACHINE.md`). No period in the repository's data is untouched any more. The next confirmatory test needs data collected after its
   pre-registration (OTA-314).
2. **Strategy attribution depends on catalogue order.** `StrategySession.evaluate` returns the first enabled strategy
   that signals on a bar. Live and replay both use it, so a bar that would fire both range and momentum is credited to
   range only. Per-strategy results are biased by the order of `STRATEGY_CATALOG`.
3. **The statistics are weaker than the verdict wording suggests.** Both the Time Machine verdict and the context-cell
   verdict take the confidence interval over the whole sample. The out-of-sample check only requires a positive mean.
   The Time Machine's default minimum out-of-sample trade count is 10, against the 30 the paper gate requires. The
   multiple-testing divisor counts only logged runs on the same `dataSha256`, so any change to a dataset resets it to zero.
4. **Risk and research disagree on cost.** Sizing and the pre-trade daily-loss check use planned stop-distance risk only.
   The replay also charges half-spread stop slippage (`stopSlippagePct` = half-spread) and round-trip charges.

Two further facts. Live execution has defects closed in code but no sandbox record, so broker behaviour is still assumed
(`docs/BROKER_CONTRACT.md`). The SDK in use is `@nemesis-oss/dhanhq-sdk` 2.0.1 (the lockfile and `package.json` range),
while the README and Time Machine docs still describe 1.3.0.

So the order is: keep the live path safe, make the research statistics honest, and only then search for an edge. An AI
research layer on top of a strategy set with no edge only searches noise faster.

## Standing rules

- **Do not tune SuperTrend, EMA, or stop/target parameters** until a pre-registered hypothesis needs them.
- **Any period used to choose, tune or diagnose a result is spent for that question.** `docs/research/HOLDOUT.md`
  (OTA-308) records every use. A spent period can still be used for description, not for confirmation.
- **No promotion without a pre-registration** (`docs/research/PREREG.md`, OTA-308) committed before the run it tests.
- **Live strategy selection stays first-match** until OTA-307 has produced an isolated per-strategy result and a
  replacement is proven by the same gates.
- **The research plane never writes live config.** Unchanged from `docs/DECISIONS.md` ADR-001.

### External review findings, checked against the code

| Finding | Status | Evidence |
| --- | --- | --- |
| Bracket-leg cancel treated as confirmed on request accept | Fixed in code (OTA-101) | `awaitLegsTerminal` polls the super order book for a terminal leg status; `legDetails` shape still unverified against sandbox |
| Unconfirmed entry dropped after 10 min | Fixed in code (OTA-102) | Dropped only when the super order book shows it settled or absent; restart refuses to start with a live broker order or unadoptable position |
| Broker kill switch: no retry or confirmation | Fixed in code (OTA-103) | Activation reads the switch back; a failure retries every 30 s and journals `broker_kill_switch_failed` (an alert) once per failure streak |
| Feed freshness from receipt time only | Fixed in code (OTA-104) | `DhanFeed.ageMs` runs from min(receipt, exchange LTT); a lagging LTT is logged once (feed delay or fast host clock) |
| 25/60-min bars accepted with a 15-min ORB | Fixed in code (OTA-105) | Config requires `ORB_MINUTES` to be a whole number of `BAR_MINUTES`; `sessionRange` returns no range unless every opening-range bar is present |
| Late fill while HALTED left unmanaged | Fixed | `canExit` allows `HALTED && !exitSent` (`underlyingAgent.ts`) |
| Daily P&L gross of costs | Fixed | `closedPnl` books net of `roundTripChargesInr` |
| Sizing on reference price under a MARKET fill | Fixed | Entry is a LIMIT at ask × (1 + buffer) and sizing uses that limit (`entryPlan.ts`) |
| Super Order without `price` | Fixed in code | `price: order.entryReference`; wire format still unverified against sandbox |
| Restart books an unresolved entry at zero P&L | Fixed on branch (OTA-107) | Booked at planned stop loss plus charges (`ops/dayState.ts`) |
| Ambiguous exit SELL could be resent | Fixed on branch (OTA-108) | `exitOutcomeUnknown` blocks a second SELL until a definitive outcome (`dhan/liveExecution.ts`) |

## The plan

Six phases, unchanged. The phase 3 gate is tighter than before, because the research must now survive a holdout that
has not been used.

| # | Phase | Gate to leave it |
| --- | --- | --- |
| 1 | Execution safety | Every lifecycle scenario has a failing-then-passing test; sandbox run of entry → cancel → exit recorded in `docs/` (OTA-106) |
| 2 | Data integrity | Each research dataset has a quality report, a checksum and an SDK version; replay is reproducible; the multiple-testing ledger counts every variant |
| 3 | Edge discovery | A pre-registered strategy × context cell passes the holdout gate (OTA-308): holdout-only confidence interval above zero, minimum sample and days, positive at 1% half-spread and at 2× stop slippage |
| 4 | Paper validation | ≥ 30 paper trades of that cell, live-observed slippage within the TM cost model |
| 5 | Supervised live | All-in risk budget (OTA-311) in force; strict caps, operator present, rollback tested |
| 6 | Research automation (AI) | Only after phase 3 has passed once by hand, on a pre-registered hypothesis |

Phases 1 and 2 run in parallel. Track A (research correctness, OTA-307 to OTA-313) needs no broker credentials. Track B
(OTA-106 and OTA-314) needs them and is run by the operator. 3 needs Track A and OTA-314. 4 needs 1 and 3. 6 needs 3.

---

### Phase 1 — Execution safety

Each item: reproduce with a failing test against the fake Dhan client, fix, rerun `npm run check`.

| ID | Work | Where | Acceptance |
| --- | --- | --- | --- |
| OTA-101 | Confirm bracket-leg cancellation by reading leg status (super order book) after `cancel`, polling until `CANCELLED`/`TRADED`; if a leg shows `TRADED`, skip the manual SELL and report the protective exit; on timeout, HALT and alert | `liveExecution.ts` `cancelBracketLegs`, `cancelBracketLegsWithRetry` | Tests: cancel accepted but leg still pending; stop fills during manual exit (no SELL sent); poll timeout halts |
| OTA-102 | Never drop an unconfirmed entry on age alone. Resolve against order book + positions until terminal | `liveExecution.ts` reconcile loop | Tests: fill appears at minute 15 and is adopted; restart with an unresolved entry is refused while the broker holds it |
| OTA-103 | Broker kill switch: retry on failure; read the switch back after success; alert on failure | `orchestrator.ts`, `liveExecution.ts` `engageBrokerKillSwitch` | Tests: first call rejects, second succeeds; status read-back mismatch alerts |
| OTA-104 | Freshness on exchange time, not only receipt time | `dhan/feed.ts`, `underlyingAgent.ts` | Test: steady packets with an old `ltt` mark the feed stale |
| OTA-105 | Reject `ORB_MINUTES` not a multiple of `BAR_MINUTES`; refuse a range signal when any opening-range bar is missing | `config.ts`, `strategy/orbSupertrend.ts` | Tests: `BAR_MINUTES=25, ORB_MINUTES=15` throws; gap in ORB bars yields no signal |
| OTA-106 | **(a) Done (`7596b9b`):** redacted wire recorder in `src/dhan/wireRecorder.ts`, wired into `scripts/smoke-trade-cycle.ts`. **(b) Open, blocked on Dhan sandbox credentials:** the operator runs `smoke:trade`, and the recording lands in `docs/sandbox/`. | `scripts/smoke-trade-cycle.ts`, `src/dhan/wireRecorder.ts` | Recording checked in; every "Assumed" row in `docs/BROKER_CONTRACT.md` moves to "Recorded" or becomes a failing test |
| OTA-107 | **Done (`07d0778`).** Restart books an unresolved entry at its all-in adverse loss, never zero; a superseded unresolved entry is booked too; an unusable stop or tick refuses startup | `ops/dayState.ts`, `runtime/underlyingAgent.ts` (journals `exchangeSegment` and `tickSize`) | `tests/dayState.test.ts` |
| OTA-108 | **Done (`70c7f57`).** An exit SELL whose outcome is unknown blocks any further SELL until a definitive rejection, a no-fill terminal status, or a flat broker position | `dhan/liveExecution.ts` | `tests/liveExecution.test.ts` "ambiguous exits (failure injection)" |
| OTA-109 | **Done (`809e7d9`; the behaviour predates it).** Restart refuses while the broker holds a live order with no position yet | `runtime/createRuntime.ts`, `orchestrator.ts` | `tests/runtime.test.ts` |

Out of scope here: a new order-manager or recovery module. The fixes live in the adapter that already owns them.

### Phase 2 — Data integrity

| ID | Work | Where | Acceptance |
| --- | --- | --- | --- |
| OTA-201 | **Done.** `dataQuality` in every report and `runs.jsonl` line | `research/timeMachine.ts` | Fixture test |
| OTA-202 | **Done.** SHA-256 of the dataset file in every `runs.jsonl` line (`dataSha256`) | `scripts/timemachine.ts` | Same file and config give identical lines except `ts` |
| OTA-203 | **Done for NIFTY (Tue) and SENSEX (Thu).** `weeklyExpiryDates` derives expiry days. BANKNIFTY monthly still unverified, so no rule | `time/calendar.ts`, `research/replay.ts` | No effect on current paper config |
| OTA-204 | **Revised: fresh holdout data, see OTA-314.** Chain snapshots start 2026-10-27; every stored dataset ends 2026-09-30 | — | — |
| OTA-205 | **Done.** `run --cells --vix <file>` tags days by opening-VIX tercile | `research/contextCells.ts` | In cell report |

Not now: a feature registry service, Greeks engine, event-calendar feed, PostgreSQL research tables. Datasets are JSON
files with a manifest line in `runs.jsonl`; that is enough until a query needs more.

### Phase 3 — Edge discovery (context-conditioned)

Each strategy family (range, trend, ema_cross, momentum, continuation, prev_day) is judged alone, per context cell, on
the same data and costs. The live gate and selector stay as they are until a result earns a change.

| ID | Work | Where | Acceptance |
| --- | --- | --- | --- |
| OTA-301 | **Done.** Each replayed trade carries `context` (regime, trend alignment, time bucket, expiry day) | `research/replay.ts` | Test |
| OTA-302 | **Done.** `run --cells` per-cell n, mean R, bootstrap CI, P(≤0), out-of-sample R, PF, verdict | `research/contextCells.ts` | Tests |
| OTA-303 | **Superseded by OTA-313.** Bonferroni divisor counted only runs on the same `dataSha256`, which resets on any dataset change | `research/contextCells.ts` | — |
| OTA-304 | **Done, first pass, burned.** Best two 2025H cells failed on 2026H. 2026H is no longer a holdout (Fact 1) | `docs/TIME_MACHINE.md` | Logged in `HOLDOUT.md` (OTA-308) |
| OTA-305 | If a cell passes the OTA-308 gate: gate live entry on that cell (a context allow-list in config), nothing else | `runtime/tradingGate.ts` / entry plan | Paper agent only trades in passed cells |
| OTA-307 | **Done (`f0f98b5`).** **Independent strategy evaluation.** Research replays each family alone (`--strategy <id>`), and `--shadow` reports what first-match credited and hid. Live `evaluate()` is unchanged | `scripts/timemachine.ts`, `strategy/session.ts` (`candidates()`), `research/replay.ts` (`EntryObserver`), `research/shadow.ts` | `tests/isolation.test.ts` |
| OTA-309 | **Done (`1a157e2`), with one open item.** **Context features, research only.** Trade context now carries `volatility` (ATR tercile of its own history), `structureAlignment`, `expiryBucket`, and `chainBias`, recorded as `UNKNOWN`. **Open:** `weeklyExpiryDates` shifts a holiday using later sessions in the same week, so `expiryBucket` and `expiryDay` can change with later data. Not fixed. **Not tested end to end:** the no-lookahead property holds by construction, because the history passed to the features ends at the signal bar, and the feature functions are tested alone | `research/tradeFeatures.ts`, `research/replay.ts` (`tradeContext`), `research/contextCells.ts` | `tests/tradeFeatures.test.ts` |
| OTA-310 | **Done (`1e6f417`).** **Previous-day breakout completeness.** The level comes only from a complete session on the bar grid, no more than four calendar days back. The ORB range uses the same bar-count helper. Stays research-only | `strategy/levelBreak.ts`, `time/sessionCoverage.ts`, `strategy/orbSupertrend.ts` | `tests/previousDay.test.ts` |

Not now: a strategy registry with lifecycle states, a weighted scoring formula, a ranking engine. Build ranking when two
pre-registered cells compete for the same bar.

New strategy families (VWAP reversion, squeeze breakout, failed-breakout reversal) are added one at a time as functions in
`strategy/session.ts`, each pre-registered and judged by the same per-cell report. Do not add a family before OTA-307 and
OTA-308 exist, because its result would be attributed through the first-match order.

### Phase 3 research hardening (OTA-308 to OTA-313)

| ID | Work | Where | Acceptance |
| --- | --- | --- | --- |
| OTA-308 | **Done (`9b3855e` a–b, `a07afd8` c–e).** **Holdout discipline.** `docs/research/PREREG.md` and `HOLDOUT.md` exist. The verdict bootstraps the holdout only; EDGE needs 30 holdout trades and 20 holdout sessions; cost stress at 1% half-spread and 2× stop slippage can only downgrade; runs are labelled `holdout-v1`. Recorded verdicts were made under the older rules and are not comparable | `research/timeMachine.ts`, `research/contextCells.ts`, `scripts/timemachine.ts`, `docs/research/` | `tests/timeMachine.test.ts` (including a mutation check that bootstrapping the whole sample fails it) |
| OTA-313 | **Done (`c0bde8f`).** **Multiple-testing ledger.** The divisor counts every logged run on any dataset, plus the seeded floors in `docs/research/variants-seed.json` (the exit sweep and the IV-crush test). A malformed log line refuses the run. Seeds are floors, not estimates. The divisor is program-wide, so a dataset change no longer resets it | `research/ledger.ts`, `scripts/timemachine.ts` (`priorVariants`), `docs/research/variants-seed.json` | `tests/ledger.test.ts` |

Trade-off to decide in review: many cells with a fixed Bonferroni bar make each cell very hard to pass. That is intended.
The honest response is fewer, pre-registered cells, not a looser divisor.

### Phase 4 — Paper validation

| ID | Work | Acceptance |
| --- | --- | --- |
| OTA-401 | `report:performance` split by the same context cells, compared to the TM expectation for that cell | Paper vs replay mean R and slippage shown side by side |
| OTA-402 | Slippage distribution from paper fills vs the TM cost model | If paper slippage exceeds the model, rerun phase 3 with the observed cost |

Gate: ≥ 30 trades in the passed cell; result inside the TM confidence interval.

### Phase 5 — Supervised live

Existing safeguards stay (live caps on risk %, `ENFORCE_DAILY_LOSS=true`, explicit live acknowledgement).

| ID | Work | Acceptance |
| --- | --- | --- |
| OTA-311 | **Done (`2e3c6c8`), behind `ALL_IN_RISK_BUDGET`. On in `config.paper.yml`, off by default and in the live profile.** Live enablement waits for operator sign-off. The three call sites (sizing, gate, open-risk book) share one function, but no test compares their numbers end to end. **All-in risk budget.** Planned risk `qty × (entry − stop)` stays for display | `risk/allInLoss.ts`, `options/sizing.ts`, `risk/riskEngine.ts`, `runtime/underlyingAgent.ts`, `research/replay.ts`, `config.ts`, `config.paper.yml` | `tests/allInLoss.test.ts`, `tests/riskEngine.test.ts`, `tests/config.test.ts` |
| OTA-501 | Readiness checklist run (README "Verification required before live") with phase 1 tests and the sandbox record attached | Signed-off checklist in the journal |
| OTA-502 | Restart drills: kill the process with an open position; with Redis down; with PostgreSQL down. Each recovers via broker reconciliation | Drill notes in `docs/PERSISTENCE.md` |
| OTA-503 | Daily contract-note reconciliation of charges vs `roundTripChargesInr` | Difference reported by `npm run reconcile` |
| OTA-504 | Minimum size (1 lot, one underlying) for the first 20 live trades; operator present | Live vs paper slippage compared |

Monitoring already exists (cockpit, ntfy alerts, journal summary). Add an alert for each new halt reason from phase 1; no
metrics stack until something needs a graph the cockpit cannot show.

### Phase 6 — Research automation (AI), only after phase 3 passes by hand

The proposal's eight-agent research plane is the end state, not the next step. The first useful version is small:

1. A script that reads the per-cell report and `runs.jsonl`, asks the local Ollama model for the next hypotheses, and
   writes them as pre-registration entries (not as live config).
2. The deterministic Time Machine runs them; the multiple-testing ledger (OTA-313) charges every one.
3. A candidate becomes a pull request for the operator to read. Promotion is a human merge, not code.

Fixed boundaries, unchanged from today's advisor: the model never places orders, never edits live config or risk limits,
and generated code never runs inside the trading process. Failed hypotheses stay in `runs.jsonl` so they count against k.

### Supporting tickets

| ID | Work | Where | Acceptance |
| --- | --- | --- | --- |
| OTA-312 | **Done (`8a2b56a`).** **Documentation and dependency alignment.** README lines that say `npm ci` installs 1.3.0 (it installs 2.0.1 from the lockfile) and the "exact pin" wording; `docs/TIME_MACHINE.md` and `docs/PERSISTENCE.md` SDK versions; "all five strategies" in `TIME_MACHINE.md` (five active, one research-only); the "ML-based" docstring on `adaptiveSuperTrend`. `package.json` is pinned exactly to `2.0.1`, and the lockfile matches | `README.md`, `docs/*.md`, `package.json`, `src/market/indicators.ts` | `tests/docs.test.ts` |
| OTA-314 | **Open, blocked on credentials.** **Fresh holdout data (operator).** Fetch premium and spot bars from 2026-10-01 to the latest session with `--dump-raw`, check the response layout against SDK 2.0.1, record `sdkVersion` in each dataset manifest, and log the period as untouched in `HOLDOUT.md`. The 2026-10-26 raw response was used for a layout check only, not for any P&L decision | `scripts/timemachine.ts`, `research/dataset.ts`, `docs/research/HOLDOUT.md` | Layout check recorded against 2.0.1; manifests carry `sdkVersion`; holdout window frozen before any pre-registered test runs on it |

**Expectation to state plainly.** The repository's historical data cannot give a clean holdout any more. A fresh window of
about a month holds roughly 46 priced trades per underlying (550 trades over the 12-month 2025H2–2026H1 window, which is
arithmetic from those counts, not a measured rate). Split across 60 cells, most cells would hold one or two trades. A
30-trade confirmation per cell therefore needs months of data, or far fewer pre-registered cells, pooled across
underlyings where the rule is the same. Plan for months. Do not shorten the gate to make the calendar fit.

---

## PR plan

Each row is one pull request, reviewed on its own. Order respects dependencies. Track B rows need credentials, so the
operator runs them.

| PR | Ticket | Scope | Depends on | Gate to merge |
| --- | --- | --- | --- | --- |
| 1 | OTA-312 · done `8a2b56a` | Docs and SDK version alignment; exact-pin decision | — | `npm run check`; no doc names 1.3.0 as installed |
| 2 | OTA-313 · done `c0bde8f` | Ledger keyed program-wide; seeded floors | — | Tests in OTA-313 |
| 3 | OTA-308 a–b · done `9b3855e` | `PREREG.md` and `HOLDOUT.md`, no code | — | Docs merged before any new run |
| 4 | OTA-308 c–e · done `a07afd8` | Holdout-only interval, minimum sample and days, cost stress in the verdict | 2, 3 | Tests in OTA-308 |
| 5 | OTA-307 · done `f0f98b5` | `--strategy` isolated replay and shadow report; report-only `candidates()` | — | Live `evaluate()` unchanged |
| 6 | OTA-310 · done `1e6f417` | Previous-session completeness, shared expected-count helper | — | `prev_day` still disabled by default |
| 7 | OTA-309 · done `1a157e2` | Context features with UNKNOWN | 2, 4 | Expiry shift open (see OTA-309) |
| 8 | OTA-311 · done `2e3c6c8`, flag on in paper only | All-in risk value shared by sizing, gate, open-risk book and restart booking | — | Operator sign-off before live |
| 9 | OTA-106 (a) · done `7596b9b` | Redacted wire recorder around SDK calls | — | Fake-client tests; secrets never written |
| 10 | OTA-106 (b) · **blocked: credentials** | Sandbox recording checked into `docs/sandbox/`; `BROKER_CONTRACT.md` updated | 9, credentials | Every "Assumed" row recorded or a failing test added |
| 11 | OTA-314 · **blocked: credentials** | Fresh window fetched, layout checked on SDK 2.0.1, `sdkVersion` in manifests | 1, credentials | Holdout window frozen in `HOLDOUT.md` before any test on it |
| 12 | Pre-registered cell run · **blocked: 10, 11** | Run the pre-registered hypothesis on the frozen window, once | 4, 7, 11 | Verdict under the OTA-308 rules, at 1% half-spread and 2× stop slippage |

PRs 1 to 9 are done on `ccr-e5f824c3-nhd407`, one commit each, and none has been opened as a pull request. PR 8 is on in paper and off in live: live needs operator sign-off. PRs 10 to 12 need Dhan credentials or the frozen window, so they wait for the operator. The earlier note said PRs 1 to 9 need no credentials, which was true when written.
PR 12 is the first run that can produce a confirmatory result. If it fails, the hypothesis is recorded as failed in
`runs.jsonl` and the next pre-registration starts from a new hypothesis, not from a parameter change.

---

## What is deliberately not on this roadmap

- Option selling, spreads, futures, other brokers.
- A `src/` restructure into new bounded-module folders.
- New PostgreSQL research schema (11 tables), Zod schemas for every domain object, OpenTelemetry, a strategy registry
  service. Each waits for a concrete need.
- Eight independent AI research agents, a strategy-ranking microservice, a Greeks engine before historical option data
  justifies it, and an autonomous promotion engine.
- Automatic promotion, automatic size scaling after profitable runs, LLM edits to live configuration.

## Decision and contract records

- `docs/DECISIONS.md`: architecture decisions, each with the test or review step that enforces it.
- `docs/BROKER_CONTRACT.md`: every broker touchpoint with its evidence level. Nothing is recorded from a sandbox yet, so
  OTA-106 is still the gate for the live path.
- `tests/architecture.test.ts`: enforces that research and strategy code never reach the broker, execution or runtime
  layers, and that only the two venue adapters write to the broker.
- `docs/research/PREREG.md` and `docs/research/HOLDOUT.md`: created by PR 3 (OTA-308).

## Success measures

| Measure | Target |
| --- | --- |
| Silently untracked broker orders or positions | Zero, by test |
| Kill-switch activation failures without an alert | Zero |
| Research runs without dataset hash, config fingerprint and SDK version | Zero |
| Research variants not counted in the multiple-testing divisor | Zero |
| Confirmatory runs on a period already marked spent in `HOLDOUT.md` | Zero |
| Live trading enabled without a passed phase 3 cell | Never |

Engineering correctness and trading edge are separate gates. Phase 1 can be complete and the agent still have no strategy
worth running; on current evidence it does not yet.
