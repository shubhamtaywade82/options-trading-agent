# Self-Improving Agent — Research Plane

This document describes the **evolution plane** added on top of the existing trading core: a closed-loop
strategy-optimization system that turns the agent's measurements (decision lineage, setup outcomes, conditional
edges) into versioned, statistically-validated strategy changes.

> **Where this fits**: the trading core already has Binance WebSocket → MarketState → Strategies → Risk →
> Execution → DecisionJournal → Trade Outcome → Learning. The research plane adds the missing half of the
> loop: **OBSERVE → DIAGNOSE → HYPOTHESIZE → MUTATE → BACKTEST → WALK-FORWARD → CHALLENGE → PROMOTE / REJECT**.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          EXECUTION PLANE                              │
│  Market → Strategies → Risk → Execution → Portfolio                   │
│  (unchanged by this work — see src/runtime/Orchestrator.ts)          │
└───────────────────────────────────┬──────────────────────────────────┘
                                     │ DecisionJournal (existing)
                                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          LEARNING PLANE                              │
│  Journal → Outcomes → Features → SetupOutcomeLedger → Attribution   │
│  (existing — see src/learning/, src/decision/DecisionJournal.ts)    │
└───────────────────────────────────┬──────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          RESEARCH PLANE                              │
│  ConditionalEdge → Bootstrap → Diagnostics → ResearchAgent (LLM)     │
│  → Hypothesis → ExperimentRunner → PromotionGate                    │
│  (new — src/research/StrategySpec.ts, ExperimentRunner.ts,          │
│   PromotionGate.ts, ResearchAgent.ts, Optimizer.ts)                  │
└───────────────────────────────────┬──────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          EVOLUTION PLANE                             │
│  StrategyRegistry → ChampionRegistry → SHADOW → PAPER → CANARY →    │
│  PROMOTED → Rollback                                                │
│  (new — src/research/StrategyRegistry.ts, ChampionRegistry.ts)      │
└──────────────────────────────────────────────────────────────────────┘
```

## Modules

| Module | Role |
|--------|------|
| `StrategySpec.ts` | Versioned parameter record. The live trading core reads code; the research plane reads specs. |
| `StrategyRegistry.ts` | Append-only JSONL store of every spec that has ever existed. Supports lineage walks back to the seed. |
| `ExperimentRunner.ts` | Runs a candidate spec against the SetupOutcomeLedger over train/test windows; produces IS/OOS/walk-forward metrics. Does **not** re-run the setup engine — it re-applies the candidate's filters to the existing hypothetical outcomes (exact for entry-threshold mutations, approximate for sweep-age mutations). |
| `ExperimentStore.ts` | Append-only JSONL of every experiment ever run. The audit trail: "why does v18 exist as a challenger today?" |
| `PromotionGate.ts` | Statistical promotion policy. A candidate must clear OOS expectancy, bootstrap LCB, profit factor, drawdown ceiling, symbol coverage, OOS delta vs parent, regime stability, and walk-forward positivity. **Never** promotes on "candidate > champion in backtest" alone. |
| `ChampionRegistry.ts` | Champion/challenger state machine. Transitions are validated: SHADOW → PAPER → CANARY → PROMOTED, with auto-rollback to the previous champion on failure. |
| `Optimizer.ts` | Mathematical parameter search (random / grid / TPE-like). The LLM proposes *which parameter to mutate*; the optimizer searches the resulting subspace. |
| `ResearchAgent.ts` | LLM-driven hypothesis proposer. Reads diagnostics from the conditional-edge matrix and proposes parameter mutations. Falls back to a deterministic rule-based proposer when the LLM is unavailable. **Never executes trades.** |
| `SelfImprovementLoop.ts` | High-level orchestrator. One `run()` call = one full iteration of the loop. |

## The Closed Loop

1. **OBSERVE**: `SelfImprovementLoop` reads the current champion and computes its conditional-edge matrix from the `SetupOutcomeLedger` over the available data window.
2. **DIAGNOSE**: The matrix is summarized into worst/best cells (regime × phase × side).
3. **HYPOTHESIZE**: `ResearchAgent` (LLM via OllamaAdvisor, or deterministic fallback) reads the diagnostics and proposes up to N hypotheses, each a partial parameter mutation.
4. **MUTATE**: Each hypothesis becomes a candidate spec via `StrategyRegistry.registerMutation`.
5. **BACKTEST**: `ExperimentRunner.runExperiment` applies the candidate's filters to the historical ledger, producing train/test metrics with cluster-bootstrap intervals.
6. **WALK-FORWARD**: The runner also runs `ConditionalEdge.walkForward` over the candidate's hypothetical trades — the same selection mechanism the existing research code uses, so an in-sample profit is never sufficient.
7. **CHALLENGE**: If the candidate clears the `PromotionGate`, it is staged as a SHADOW challenger in `ChampionRegistry`. The operator decides when to transition SHADOW → PAPER → CANARY → PROMOTED.
8. **PROMOTE / REJECT**: The gate's verdict is persisted to `ExperimentStore` alongside the candidate and result. The audit trail is complete: every transition is recorded in `ChampionRegistry.auditTrail()`.

## Key Design Rules

- **LLM is the researcher, not the trader.** The ResearchAgent proposes mutations; it never executes trades, never writes to the DecisionJournal, never calls a strategy function. Its proposals are validated by the experiment engine.
- **Mathematical optimizer first, LLM second.** The optimizer searches the parameter space; the LLM interprets diagnostics and proposes *which direction to explore*. They compose: the LLM proposes a slice, the optimizer searches that slice.
- **Re-evaluation, not re-running.** The `SetupOutcomeLedger` records what every setup would have done, whether or not it was traded. Candidate specs are applied as post-hoc filters on the ledger — no re-run of the setup engine is required for entry-threshold mutations.
- **Never promote on backtest alone.** The PromotionGate enforces OOS expectancy, bootstrap LCB, profit factor, drawdown, symbol coverage, regime stability, OOS delta vs parent, and walk-forward positivity.
- **Champion is single, challengers are staged.** At most one champion per strategy id; SHADOW/PAPER/CANARY stages gate real money at risk. A failed canary auto-rolls back to the previous champion.
- **Operator owns the final stage.** The loop auto-stages SHADOW; the operator decides SHADOW → PAPER → CANARY → PROMOTED.

## Running the Loop

```bash
# Status check — shows champion, challengers, experiment count
npm run self-improve:status

# Run one iteration with the deterministic fallback proposer
npx tsx scripts/self-improve.ts --iters 1

# Run with the LLM (requires Ollama running)
npx tsx scripts/self-improve.ts --iters 3 --llm

# Customize train/test windows
npx tsx scripts/self-improve.ts --train-days 90 --test-days 30 --max-hypotheses 5
```

## Persistence

All state lives under `data/` (gitignored):

- `data/strategy-registry.jsonl` — every spec that has ever existed (append-only)
- `data/champion-registry.json` — current champion + challengers + transition history (atomic rewrite)
- `data/experiments.jsonl` — every experiment ever run (append-only)
- `data/setup-outcomes.jsonl` — the existing setup outcome ledger (input to the loop)

## Tests

```bash
# All research-plane tests
npx tsx --test tests/strategySpec.test.ts tests/strategyRegistry.test.ts \
  tests/experimentRunner.test.ts tests/promotionGate.test.ts \
  tests/championRegistry.test.ts tests/optimizer.test.ts \
  tests/researchAgent.test.ts tests/selfImprovementLoop.test.ts

# Full suite (existing 1211 + new 67 = 1278 tests)
npm test
```
