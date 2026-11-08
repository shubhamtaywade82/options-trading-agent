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
| Trail study, `TRAILING_STOPS.md` §12 (2026-11-03): NIFTY 2025H2 and 2026H1, BANKNIFTY 2026H1, SENSEX 2026H1, months before 2026-08 | NIFTY, BANKNIFTY, SENSEX | Selection of trail methods: 68 configurations over 3 study runs (Holm family 204), the coupled-replay and 1-minute checks, and the clean 1-minute NIFTY 2026H1 check. Not entered here when it ran; entered 2026-11-08 | Spent (selection) |
| 2026-10-01 onward | NIFTY, BANKNIFTY, SENSEX | One raw-response layout check on 2026-10-26, which is not a P&L decision. Otherwise untouched | Not yet Frozen. OTA-314 freezes it |

## Entries

| Date | Window | Action | Who |
| --- | --- | --- | --- |
| 2026-11-02 | NIFTY 2025H | Discovery pass, 60 cells | research |
| 2026-11-02 | NIFTY 2026H | Single confirmation of the two best cells | research |
| 2026-11-03 | all windows above | Recorded in this file. Exit-sweep and IV-crush windows marked as overlapping NIFTY 2026H | research |
| 2026-11-03 | ledger | The documented evidence written to `docs/research/experiments.jsonl` as backfills, once each, with citations | research |
| 2026-11-08 | Trail study windows (§12, 2026-11-03) | Entered late. The study's windows are now Spent (selection). Its 204-variant family and two re-checks are backfilled to the ledger as `doc:TRAILING_STOPS.md:*` | research |

## What must happen before the next confirmatory run

1. OTA-314: fetch the window from 2026-10-01 to the latest session, check its layout against SDK 2.0.1, record its
   `sha256` and `sdkVersion` in its manifest, and change its status to `Frozen` here, with the date.
2. Register the hypothesis in `PREREG.md`, commit it, and register it in the ledger with `npm run ledger -- register`, before the run.
3. Run once. The run appends its record to the ledger. Record the result in `PREREG.md` with its ledger sequence number.

## Preserved evidence

The 2026H results are kept permanently as historical research evidence. They are not deleted, and they are not relabelled
as an untouched holdout.

- **NIFTY 2026H, confirmation of the two best 2025H cells (2026-11-02).** Mean net R −0.020 and −0.040, both NO_TRADE.
  This window was already spent when it was checked: the exit-rule sweeps and the IV-crush test had run on NIFTY
  2025-10..2026-09, which contains it. The result stands as the record of what happened, and stays `Spent`.
- The ledger holds it as `doc:TIME_MACHINE.md:confirmation-2026H-spent`, a backfill with `holdout_status: Spent`, linked to
  the overlap group of the exit sweep that covered it (`docs/research/experiments.jsonl`). `scripts/ledger.ts verify` and the
  committed-ledger tests fail if it is removed, edited, or relabelled `Frozen`.
- A new confirmation on NIFTY 2026H is not possible. A confirmation needs a Frozen window, and no such window exists in the
  repository's data. The next confirmation runs on a window frozen after the fresh data is fetched (OTA-314).
- **Trailing study holdout, recorded 2026-11-08.** Gate 6 of `TRAILING_STOPS.md` §7 tests a "locked holdout", and §12 says "the holdout is kept". No window is registered as that holdout in this file, and none is Frozen. The only candidate is the 2026-10-01 onward window, which becomes one when OTA-314 freezes it. Until then gate 6 cannot run, so no trailing method can pass all gates.
