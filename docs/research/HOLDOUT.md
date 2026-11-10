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
| 2026-10-01..2026-12-31 | NIFTY, BANKNIFTY, SENSEX | One raw-response layout check on 2026-10-26, which is not a P&L decision. Otherwise untouched. Reserved on 2026-11-10 for the three hypotheses under "Reserved window" below | Not yet Frozen. OTA-314 freezes it after the window closes |
| 2027-01-01 onward | NIFTY, BANKNIFTY, SENSEX | Untouched | Not yet Frozen |

## Entries

| Date | Window | Action | Who |
| --- | --- | --- | --- |
| 2026-11-02 | NIFTY 2025H | Discovery pass, 60 cells | research |
| 2026-11-02 | NIFTY 2026H | Single confirmation of the two best cells | research |
| 2026-11-03 | all windows above | Recorded in this file. Exit-sweep and IV-crush windows marked as overlapping NIFTY 2026H | research |
| 2026-11-10 | 2026-10-01..2026-12-31 | End date fixed and the window reserved for three pooled paper-profile hypotheses (NIFTY, SENSEX, BANKNIFTY). Nothing was fetched or run | operator |
| 2026-11-03 | ledger | The documented evidence written to `docs/research/experiments.jsonl` as backfills, once each, with citations | research |

## Reserved window

Decided by the operator on 2026-11-10, before any data in the window was fetched.

- **Window.** 2026-10-01 to 2026-12-31. The end date is fixed now so that it cannot be chosen after seeing results. On
  2026-11-10 the window held fewer than the 30 sessions the holdout floor needs, so no run on it was possible.
- **Hypotheses.** The strategy set of `config.paper.yml`, pooled, has a holdout block-bootstrap 95% lower bound of mean
  net R above zero after costs, under the OTA-308 rules. One hypothesis each for NIFTY, SENSEX and BANKNIFTY (the third
  added on 2026-11-10, the same day, before any fetch). The profile is the
  one at the commit named in the `PREREG.md` entry, and it is not changed between now and the run.
- **BANKNIFTY limits, known before the run.** BANKNIFTY options are monthly, and the replay has no expiry rule for a monthly
  series (OTA-203). The replay also follows the dataset's expiry code, not `MIN_DAYS_TO_EXPIRY` and `MAX_DAYS_TO_EXPIRY`,
  so it prices the monthly contract on every session, while the paper profile only trades contracts within its expiry
  limit. The BANKNIFTY result therefore describes the replay's rule, not exactly what the paper agent trades. It still
  counts as one variant in the divisor.
- **Not a registration.** `PREREG.md` rule 2 needs a Frozen window first. This section records the choice and its date.
  The entries are committed to `PREREG.md` after the freeze, with the same hypotheses.
- **Fetch date.** The fetch reads expired contracts only, so it runs after the last weekly expiry that the window's final
  sessions traded has passed.
- **No look before the freeze.** No replay, cell pass or description is run on any part of this window before the run in
  step 3 below. A look of any kind makes the window `Spent`.

## What must happen before the next confirmatory run

1. OTA-314: after the reserved window closes, fetch it from 2026-10-01 to 2026-12-31, check its layout against SDK 2.0.1, record its
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
