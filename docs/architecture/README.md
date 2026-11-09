# Architecture diagrams

Six levels, from the system context down to the code. Each diagram is a standalone HTML page. Open it in a browser; no
server is needed. The typed JSON under [`source/`](source/) is the editable source for each page.

Every diagram is pinned to commit `27e3e0a` of this repository. Components and states cite `file:line` at that commit
(evidence is `local-only`: the pages show the file and line, with no web links). When the code changes, regenerate the
affected page rather than editing its HTML.

## Level 0: context

| Diagram | What it shows |
| --- | --- |
| [System context](00-system-context.html) ([source](source/00-system-context.json)) | The operator, the session runner, the agent, DhanHQ, the sandbox, Ollama, alerts, paper_exchange, and what stays on the local host. |

## Level 1: layers and planes

| Diagram | What it shows |
| --- | --- |
| [Layers and planes](01-layers-and-planes.html) ([source](source/01-layers-and-planes.json)) | The twelve layers of [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md), their dependency direction, and the offline research plane with no broker path (ADR-001). |
| [Market to order pipeline](02-market-to-order-pipeline.html) ([source](source/02-market-to-order-pipeline.json)) | The data path from a WebSocket tick to a placed order, with the gates and the durable intent in order. |

## Level 2: one diagram per layer

| Diagram | Layer |
| --- | --- |
| [Market data and time](03-market-data-and-time.html) ([source](source/03-market-data-and-time.json)) | Config, auth, the Dhan client, market data, the feed, the scrip master, and the clock guard. |
| [Signal and contract](04-signal-and-contract.html) ([source](source/04-signal-and-contract.json)) | The strategy families, market context, the chain, contract selection, bracket levels and sizing. |
| [Risk and advice](05-risk-and-advice.html) ([source](source/05-risk-and-advice.json)) | The trading gate, the rollout policy, the pre-trade gate, the day book, all-in loss, the advisor, and the kill switch. |
| [Execution venues](06-execution-venues.html) ([source](source/06-execution-venues.json)) | The execution port and its four destinations, and the single path to the broker. |
| [Orchestration](07-orchestration.html) ([source](source/07-orchestration.json)) | The runtime wiring, the orchestrator, one agent per index, the serial queue, and the operator inputs. |
| [Audit, persistence and cockpit](08-audit-persistence-cockpit.html) ([source](source/08-audit-persistence-cockpit.json)) | The journal, the PostgreSQL ledger and its immutability, day restore, Redis, alerts, and the read-only cockpit. |
| [Research plane](09-research-plane.html) ([source](source/09-research-plane.json)) | Dhan data to a verdict: fetch, replay, judge and record, with pre-registration before a confirmation. |

## Level 3: behaviour

| Diagram | What it shows |
| --- | --- |
| [Trade lifecycle](10-trade-lifecycle.html) ([source](source/10-trade-lifecycle.json)) | The normal path of the per-side state machine, with every exit and the protective close. |
| [Halt and recovery](10b-halt-and-recovery.html) ([source](source/10b-halt-and-recovery.json)) | Every HALT, both UNCONFIRMED triggers, and RESET. Together with the lifecycle, this covers all 24 rows of `TRANSITIONS`. |
| [Entry sequence](11-entry-sequence.html) ([source](source/11-entry-sequence.json)) | From a closed bar through the chain, the risk gate, the advisor, the durable intent, and the placed order. |
| [Exit with an unknown outcome](12-exit-and-unknown-outcomes.html) ([source](source/12-exit-and-unknown-outcomes.json)) | An ambiguous exit, the halt, the kill switch, and reconciliation. |
| [Startup and recovery](13-startup-and-recovery.html) ([source](source/13-startup-and-recovery.json)) | Lease, day restore, the broker checks, and the warm-up before the first tick. |

## Level 4: data

| Diagram | What it shows |
| --- | --- |
| [Persistence schema](14-persistence-schema.html) ([source](source/14-persistence-schema.json)) | Migrations 001 to 006: every table and column, the keys, and the foreign keys. The view `v_closed_trades` is not drawn. |
| [Domain model](15-domain-model.html) ([source](source/15-domain-model.json)) | The order, event and position types, the execution port and its implementations, and the agent and orchestrator. |

## Level 5: code map

| Diagram | What it shows |
| --- | --- |
| [Code map](16-code-map.html) ([source](source/16-code-map.json)) | Where each layer lives in `src/`, plus `scripts/`, `tests/` and `docs/`. |

## Regenerate a page

Pages are produced with the [Archify](https://github.com/tt-a1i/archify) skill (`archify/archify/bin/archify.mjs`, a
local checkout). From the repository root, for example:

```bash
node <archify>/archify/bin/archify.mjs finalize architecture docs/architecture/source/00-system-context.json \
  docs/architecture/00-system-context.html --repo-root . --quality showcase --json
```

Use the type from each source (`architecture`, `dataflow`, `lifecycle`, `sequence`, `erd`, `class`, `tree`). The
command validates the source, checks the evidence against the pinned commit, renders the page, and runs a browser check.
