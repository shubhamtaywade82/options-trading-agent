# Roadmap

Where this agent goes next, in order, with the gate each step must pass. Written 2026-11-02 against `main` at
`1202372`. It extends what exists; it is not a rewrite.

## Where the repository actually stands

Read this before any plan. Two facts set the order of everything below.

1. **No strategy has shown a net edge.** Time Machine runs on real option premiums for NIFTY, BANKNIFTY and
   SENSEX (2025H2–2026H1, ~550 trades each) return mean net R between −0.004 and +0.046. The one
   `EDGE_SUPPORTED` verdict (NIFTY 2025H) used a 0.25% half-spread; at the 1% half-spread the same family is
   `NO_TRADE`. Exit variants (stop %, R target, time stop, IV-crush exit) moved mean R by under 0.02.
2. **Live execution has known open defects** (below). Paper results exercise the state machine, not Dhan.

So the order is: close the execution defects, then find an edge with deterministic research, then automate the
search. An AI research layer on top of a strategy set with no edge only searches noise faster.

### External review findings, checked against the code

| Finding | Status | Evidence |
| --- | --- | --- |
| Bracket-leg cancel treated as confirmed on request accept | **Open** | `src/dhan/liveExecution.ts` `cancelBracketLegs` adds the leg to `cancelledLegs` when `superOrders.cancel` resolves; no terminal-status read |
| Unconfirmed entry dropped after 10 min | **Open** | `UNCONFIRMED_ENTRY_RETENTION_MS`, `liveExecution.ts:617`; state is in memory only |
| Broker kill switch: no retry or confirmation | **Partly open** | Orchestrator waits until the book is flat (`maybeEngageBrokerKillSwitch`), but a failed `setKillSwitch` is logged once, `brokerKillSent` stays true, nothing re-reads the switch, no alert |
| Feed freshness from receipt time only | **Open** | `src/dhan/feed.ts` stamps `receivedAt`; `ltt` is only checked for being in the future |
| 25/60-min bars accepted with a 15-min ORB | **Open** | `src/config.ts` validates `BAR_MINUTES` and `ORB_MINUTES` separately |
| Late fill while HALTED left unmanaged | Fixed | `canExit` allows `HALTED && !exitSent` (`underlyingAgent.ts:1131`) |
| Daily P&L gross of costs | Fixed | `closedPnl` books net of `roundTripChargesInr` |
| Sizing on reference price under a MARKET fill | Fixed | Entry is a LIMIT at ask × (1 + buffer) and sizing uses that limit (`entryPlan.ts`) |
| Super Order without `price` | Fixed in code | `price: order.entryReference`; wire format still unverified against sandbox |

## The plan

Six phases, not eight. The proposed "Architecture" and "Tools & repositories" phases are folded in: the module
split already exists (`dhan/ execution/ risk/ strategy/ research/ runtime/ persistence/`), and a mass move into
`domain/ market/ strategy/ options/ ai/ …` subfolders would cost weeks and fix nothing. New code goes into the
existing folder that owns the concern.

| # | Phase | Gate to leave it |
| --- | --- | --- |
| 1 | Execution safety | Every lifecycle scenario has a failing-then-passing test; sandbox run of entry → cancel → exit |
| 2 | Data integrity | Each research dataset has a quality report and a checksum; replay is reproducible |
| 3 | Edge discovery | One strategy × context cell is `EDGE_SUPPORTED` out of sample at 1% half-spread |
| 4 | Paper validation | ≥ 30 paper trades of that cell, live-observed slippage within the TM cost model |
| 5 | Supervised live | Strict caps, operator present, rollback tested |
| 6 | Research automation (AI) | Only after phase 3 passes once by hand |

Phases 1 and 2 can run in parallel. 3 needs 2. 4 needs 1 and 3. 6 needs 3.

---

### Phase 1 — Execution safety

Each item: reproduce with a failing test against the fake Dhan client, fix, rerun `npm run check`.

| ID | Work | Where | Acceptance |
| --- | --- | --- | --- |
| OTA-101 | Confirm bracket-leg cancellation by reading leg status (super order book) after `cancel`, polling until `CANCELLED`/`TRADED`; if a leg shows `TRADED`, skip the manual SELL and report the protective exit; on timeout, HALT and alert | `liveExecution.ts` `cancelBracketLegs`, `cancelBracketLegsWithRetry` | Tests: cancel accepted but leg still pending; stop fills during manual exit (no SELL sent); poll timeout halts |
| OTA-102 | Never drop an unconfirmed entry on age alone. Resolve against order book + positions until terminal; keep the unresolved record in the event log so a restart reloads it | `liveExecution.ts` reconcile loop, `ops/eventLog.ts` | Tests: fill appears at minute 15 and is adopted; restart with an unresolved entry reloads it |
| OTA-103 | Broker kill switch: on failure clear `brokerKillSent` so the next clock tick retries; after success read the switch status back; alert (`ops/alerts.ts`) on failure | `orchestrator.ts`, `liveExecution.ts` `engageBrokerKillSwitch` | Tests: first call rejects, second succeeds; status read-back mismatch alerts |
| OTA-104 | Freshness on exchange time: refuse entries when `receivedAt − ltt` exceeds `feed.staleMs`, not only when no packet arrived | `dhan/feed.ts`, staleness check in `underlyingAgent.ts` | Test: steady packets with an old `ltt` mark the feed stale |
| OTA-105 | Reject `ORB_MINUTES` not a multiple of `BAR_MINUTES`; refuse a range signal when any opening-range bar is missing | `config.ts` validation, `strategy/session.ts` | Tests: `BAR_MINUTES=25, ORB_MINUTES=15` throws; gap in ORB bars yields no signal |
| OTA-106 | Sandbox lifecycle run: entry, partial fill if reproducible, bracket armed, manual exit with leg cancel, kill switch. Capture serialized requests and responses into `docs/` | `scripts/smoke-trade-cycle.ts` | Recorded run checked into docs; any field mismatch becomes a test |

Out of scope here: a new order-manager or recovery module. The fixes live in the adapter that already owns them.

### Phase 2 — Data integrity

The Time Machine already prices on real premiums, splits chronologically and block-bootstraps. What it lacks is
proof that each dataset is complete and identical across runs.

| ID | Work | Where | Acceptance |
| --- | --- | --- | --- |
| OTA-201 | Dataset quality report on load: missing/duplicate/out-of-order bars, invalid OHLC, sessions missing vs calendar, `DATA_GAP` share. Print it with every `run` and refuse a dataset above a gap threshold | `research/dataset.ts` | Test on a fixture with each defect |
| OTA-202 | SHA-256 of the dataset file in every `runs.jsonl` line (next to the config fingerprint) | `scripts/timemachine.ts` | Two runs on the same file and config give identical lines except `ts` |
| OTA-203 | Expiry calendar per underlying, so the expiry-day cutoff stops being skipped in replay (TIME_MACHINE item 5) | `time/calendar.ts` | Replay report no longer warns; BANKNIFTY monthly expiry checked like NIFTY/SENSEX |
| OTA-204 | Use recorded chain snapshots (`ops/chainRecorder.ts`, live since 2026-10-27) in replay for chain bias and real bid/ask on the days they exist; elsewhere keep the configured spread and say so in the report | `research/replay.ts` | Replay on a recorded day uses snapshot spreads; report states coverage |
| OTA-205 | India VIX bars (already fetched) as a replay feature column | `research/dataset.ts` | Available to context tagging in phase 3 |

Not now: a feature registry service, Greeks engine, event-calendar feed, PostgreSQL research tables. Datasets
are JSON files with a manifest line in `runs.jsonl`; that is enough until a query needs more.

### Phase 3 — Edge discovery (context-conditioned)

The useful idea in the proposal is that one strategy need not work everywhere. Test it directly: tag every
replayed trade with the context the live gate already computes (`strategy/marketContext.ts`: day trend,
regime, structure, chain bias) plus time-of-day bucket, days-to-expiry and VIX tercile, then measure each
strategy family (range, trend, ema_cross, momentum, continuation × scout/confirmed) per cell.

| ID | Work | Where | Acceptance |
| --- | --- | --- | --- |
| OTA-301 | Attach context tags to each replayed trade | `research/replay.ts` | Every trade row carries its tags |
| OTA-302 | Per-cell report: n, mean net R with block-bootstrap CI, profit factor, max drawdown, verdict; cells under a minimum n print `INSUFFICIENT_EVIDENCE` | `research/stats.ts`, `scripts/timemachine.ts` | Report reproduces from dataset hash + config fingerprint |
| OTA-303 | Multiple-testing control: count cells × variants tried on a dataset from `runs.jsonl`; widen intervals (Bonferroni is enough) before any verdict | `research/stats.ts` | A cell chosen from k candidates must clear the corrected bound |
| OTA-304 | Hold-out discipline: choose cells on 2025 data, confirm on 2026 data never used for choosing | runbook in `TIME_MACHINE.md` | The confirm run is a single logged run per candidate |
| OTA-305 | If a cell passes: gate the live entry on that cell (a context allow-list in config), nothing else | `runtime/tradingGate.ts` / entry plan | Paper agent only trades in passed cells |

Not now: a strategy registry with lifecycle states, a weighted scoring formula, a ranking engine. With zero
proven cells, a config allow-list is the whole selector. Build ranking when two cells compete for the same bar.

New strategy families (VWAP reversion, squeeze breakout, PDH/PDL break, failed-breakout reversal) are added one
at a time as functions in `strategy/session.ts`, each judged by the same per-cell report.

### Phase 4 — Paper validation

| ID | Work | Acceptance |
| --- | --- | --- |
| OTA-401 | `report:performance` split by the same context cells, and compared to the TM expectation for that cell | Paper vs replay mean R and slippage shown side by side |
| OTA-402 | Slippage distribution from paper fills vs the TM cost model | If paper slippage exceeds the model, rerun phase 3 with the observed cost |

Gate: ≥ 30 trades in the passed cell; result inside the TM confidence interval.

### Phase 5 — Supervised live

Existing safeguards stay (live caps on risk %, `ENFORCE_DAILY_LOSS=true`, explicit live acknowledgement).

| ID | Work | Acceptance |
| --- | --- | --- |
| OTA-501 | Readiness checklist run (README "Verification required before live") with phase 1 tests and the sandbox record attached | Signed-off checklist in the journal |
| OTA-502 | Restart drills: kill the process with an open position; with Redis down; with PostgreSQL down. Each recovers via broker reconciliation | Drill notes in `docs/PERSISTENCE.md` |
| OTA-503 | Daily contract-note reconciliation of charges vs `roundTripChargesInr` | Difference reported by `npm run reconcile` |
| OTA-504 | Minimum size (1 lot, one underlying) for the first 20 live trades; operator present | Live vs paper slippage compared |

Monitoring already exists (cockpit, ntfy alerts, journal summary). Add an alert for each new halt reason from
phase 1; no metrics stack until something needs a graph the cockpit cannot show.

### Phase 6 — Research automation (AI), only after phase 3 passes by hand

The proposal's eight-agent research plane is the end state, not the next step. The first useful version is
small:

1. A script that reads the per-cell report and `runs.jsonl`, asks the local Ollama model for the next
   hypotheses (a parameter range, a filter, a new family), and writes them as config files.
2. The deterministic Time Machine runs them; the multiple-testing counter charges every one.
3. A candidate becomes a pull request for the operator to read. Promotion is a human merge, not code.

Fixed boundaries, unchanged from today's advisor: the model never places orders, never edits live config or risk
limits, and generated code never runs inside the trading process. Failed hypotheses stay in `runs.jsonl` so
they count against k and are not retried.

---

## What is deliberately not on this roadmap

- Option selling, spreads, futures, other brokers.
- A `src/` restructure into new bounded-module folders.
- New PostgreSQL research schema (11 tables), Zod schemas for every domain object, OpenTelemetry, a strategy
  registry service. Each waits for a concrete need.
- Automatic promotion, automatic size scaling after profitable runs, LLM edits to live configuration.

## Success measures

| Measure | Target |
| --- | --- |
| Silently untracked broker orders or positions | Zero, by test |
| Kill-switch activation failures without an alert | Zero |
| Research runs without dataset hash + config fingerprint | Zero |
| Live trading enabled without a passed phase 3 cell | Never |

Engineering correctness and trading edge are separate gates. Phase 1 can be complete and the agent still have
no strategy worth running; on current evidence it does not yet.
