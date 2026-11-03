# Holdout ledger

Every period the research has touched, and what it was used for. A period is `Spent` once it has informed any decision:
a choice of family, cell, threshold, exit rule or parameter. A `Spent` period can still describe the market; it cannot
confirm a hypothesis. A period is `Frozen` when a dataset manifest for it is committed here and no decision has used it.
Only a `Frozen` window can confirm a pre-registered hypothesis (`PREREG.md`).

## Windows

The labels below are copied from `docs/TIME_MACHINE.md` and `docs/ROADMAP.md`. They are not consistent with one another
(for example "2025H" and "2025H2–2026H1" use different half-year conventions), and the dataset files that fix the exact
dates are in `data/`, which is not in the repository. Each window must be restated with exact `from`/`to` dates from its
manifest before it is used for anything. Until then, every label here is `Spent`.

| Window (as labelled) | Underlyings | Used for | Status |
| --- | --- | --- | --- |
| NIFTY 2025H | NIFTY | First context-cell pass, 60 cells: discovery of the two best cells. The 0.25% half-spread EDGE_SUPPORTED verdict and the 1% NO_TRADE verdict | Spent (discovery) |
| NIFTY 2026H | NIFTY | Confirmation of the two best 2025H cells, checked once: mean net R −0.020 and −0.040 | Spent (confirmation) |
| NIFTY 2025-10..2026-09 | NIFTY | Exit sweeps (stop %, R target, time stop) and the IV-crush exit test. Contains NIFTY 2026H | Spent (confirmation) |
| SENSEX and BANKNIFTY 2026-04..09 | SENSEX, BANKNIFTY | Exit sweeps and the IV-crush exit test | Spent (confirmation) |
| 2025H2–2026H1 | NIFTY, BANKNIFTY, SENSEX | The ~550-trades-per-underlying counts and the mean net R range in `ROADMAP.md` fact 1 | Spent (description) |
| 2026-10-01 onward | NIFTY, BANKNIFTY, SENSEX | One raw-response layout check on 2026-10-26, which is not a P&L decision. Otherwise untouched | Not yet Frozen. OTA-314 freezes it |

## Entries

| Date | Window | Action | Who |
| --- | --- | --- | --- |
| 2026-11-02 | NIFTY 2025H | Discovery pass, 60 cells | research |
| 2026-11-02 | NIFTY 2026H | Single confirmation of the two best cells | research |
| 2026-11-03 | all windows above | Recorded in this file. Exit-sweep and IV-crush windows marked as overlapping NIFTY 2026H | research |

## What must happen before the next confirmatory run

1. OTA-314: fetch the window from 2026-10-01 to the latest session, check its layout against SDK 2.0.1, record its
   `sha256` and `sdkVersion` in its manifest, and change its status to `Frozen` here, with the date.
2. Register the hypothesis in `PREREG.md` and commit it, before the run.
3. Run once. Record the result in `PREREG.md` and in `runs.jsonl`.
