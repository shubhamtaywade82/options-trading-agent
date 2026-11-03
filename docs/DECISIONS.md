# Architecture decisions

The decisions the roadmap (`docs/ROADMAP.md`) and the target design depend on. Each entry says where it is enforced.
A decision is changed by a new entry that supersedes the old one, not by editing the old one.

Enforcement levels: **test** (a failing test catches a violation), **type** (the compiler does), **review** (only the
review checklist does). Review-only decisions are called out as such.

---

## ADR-001 Trading and research are separate planes

**Context.** A research result must never reach a live order without a human decision.

**Decision.** `src/research/`, `src/strategy/`, `src/options/` and `src/market/` never import `src/dhan/`,
`src/execution/` or `src/runtime/`. Broker writes (`orders`, `superOrders`, `traderControls` place, cancel, modify and
kill-switch calls) exist only in `src/dhan/liveExecution.ts` and `src/dhan/sandboxGateway.ts`.

**Enforced by.** test: `tests/architecture.test.ts`.

## ADR-002 Keep the existing module layout

**Context.** The proposal's `domain/ market/ strategy/ options/ ai/ …` tree would move every file to fix nothing.

**Decision.** New code goes into the existing folder that owns the concern. The tree in `docs/ARCHITECTURE.md` is the
map. No mass move.

**Enforced by.** review.

## ADR-003 The trade lifecycle is one transition table

**Context.** Ambiguous transitions are how an unmanaged position appears.

**Decision.** `src/domain/fsm.ts` is the only source of trade-state transitions. A (state, event) pair not in its table
throws `IllegalTransitionError` and leaves the state unchanged. HALT is never legal inside HALTED.

**Enforced by.** test: `tests/fsm.test.ts`; type for the state and event unions.

## ADR-004 Buy-to-open only, with a mandatory stop and target

**Context.** The agent trades long CE and PE options only. Option selling is out of scope.

**Decision.** `EntryOrder.side` is the literal `'BUY'`. The pre-trade gate rejects any other side. A bracket without a
stop or target is never built. Risk is recomputed from the order's own numbers, not from the sizing step.

**Enforced by.** type (`side: 'BUY'`); test: `tests/riskEngine.test.ts` (`NOT_A_BUY_ORDER`, `STOP_LOSS_INVALID`,
`TARGET_INVALID`, `RISK_EXCEEDS_BUDGET`).

## ADR-005 An unknown broker outcome is never replayed

**Context.** A write that timed out may still have reached the matching engine. Sending it again can double the trade.

**Decision.**
- Only a definitive client rejection is `REJECTED`: a validation error, or a 4xx other than 401, 408 and 429. Everything
  else is `UNCONFIRMED`, which halts the underlying (`classifyPlacementError`).
- An exit SELL whose outcome is unknown blocks any further SELL for that position until a definitive outcome arrives
  or reconciliation shows the position flat. Added 2026-11-03 (`70c7f57`); before it, a second `submitExit` could send
  a second SELL for the same quantity.

**Enforced by.** test: `tests/liveExecution.test.ts` ("ambiguous exits (failure injection)" and
"classifyPlacementError").

## ADR-006 Restart is fail-closed

**Context.** A restart resets in-memory state. Whatever the broker holds, and whatever the journal cannot prove, must
not be silently forgotten.

**Decision.**
- Startup refuses while the broker shows an open option position or a live order (`orchestrator.ts` `startInternal`).
- The day book is rebuilt from today's journal only. A malformed line refuses startup.
- An entry journalled as submitted with no outcome is booked at its planned loss at the stop, net of estimated charges.
  It is not booked at zero, because the bracket may have closed it during the outage. A superseded unresolved entry is
  booked the same way when a new entry for that underlying appears. Added 2026-11-03 (`07d0778`).
- An unresolved entry without a usable stop refuses startup, because there is no loss to book.

**Enforced by.** test: `tests/dayState.test.ts`; `tests/runtime.test.ts` for the broker-state refusals.

## ADR-007 Research data is files with a manifest, not a schema

**Context.** Eleven PostgreSQL research tables would cost weeks before any query needs them.

**Decision.** Datasets are JSON files. Each replay appends one line to `runs.jsonl` with the dataset's SHA-256 and the
verdict. Failed runs stay in the file so they count against the multiple-testing correction. Revisit when a query
cannot be answered from the manifest.

**Enforced by.** review. The manifest fields are produced by `scripts/timemachine.ts`.

## ADR-008 Verdicts are deterministic and the model cannot change them

**Context.** An LLM that can flip a verdict can promote noise.

**Decision.** The Time Machine verdict is `TimeMachineVerdict` (`INSUFFICIENT_EVIDENCE`, `NO_TRADE`, `EDGE_SUPPORTED`),
computed from the bootstrap interval, the out-of-sample days and the trade count. The advisor is a veto with two
outputs; any failure is SKIP.

**Enforced by.** test: `tests/timeMachine.test.ts` (verdict cases); review for the advisor.

## ADR-009 The proposal's contracts map onto types that already exist

**Context.** The proposal lists twelve domain contracts. Most are already implemented under other names. Renaming them
would churn every caller.

**Decision.** Keep the existing names. Add a new contract only when a second caller needs it. Version identifiers are
not added to these types. Research reproducibility is carried by the manifest (`dataSha256`, OTA-202).

| Proposed contract | Existing type | Location |
| --- | --- | --- |
| MarketSnapshot | `Tick`, `Candle[]` | `src/domain/types.ts` |
| MarketContext | `MarketContext` | `src/strategy/marketContext.ts` |
| StrategyDefinition | `STRATEGY_CATALOG`, `StrategyId` | `src/strategy/session.ts` |
| StrategySignal | `Signal` | `src/domain/types.ts` |
| OptionContract | `OptionContract` | `src/domain/types.ts` |
| OptionQuote | `OptionQuote` | `src/domain/types.ts` |
| RiskVerdict | `RiskVerdict` | `src/risk/riskEngine.ts` |
| OrderIntent | `EntryOrder`, `ExitOrder` | `src/execution/ports.ts` |
| ExecutionReport | `ExecutionEvent` | `src/execution/ports.ts` |
| PositionSnapshot | `OpenPosition`, `DaySnapshot` | `src/domain/types.ts`, `src/risk/dayBook.ts` |
| Experiment | one `runs.jsonl` line | `scripts/timemachine.ts` |
| ValidationReport | `TimeMachineVerdict` and report | `src/research/timeMachine.ts` |

## Deliberately not decided yet

Each waits for a concrete need, as `docs/ROADMAP.md` states: a strategy registry service, a Zod schema for every domain
object, OpenTelemetry, the PostgreSQL research schema, and a Redis-backed research store. Research code does not use Redis;
Redis serves the runtime's cache, rate gate and lease (`src/persistence/`).
