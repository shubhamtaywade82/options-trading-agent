# Pre-registration

A hypothesis is tested once, on a window nobody has used for it, under rules fixed before the run. This file is the record.
An entry is committed to git before the run it describes, so the commit date is the evidence.

## Rules

1. **One entry per hypothesis.** A parameter change is a new hypothesis. A rerun with the same rules on the same window is
   not a new test: it is the same test again, and its result stands.
2. **The window must be `Frozen` in `HOLDOUT.md`** before the entry is committed. A window that has been used for any
   decision is `Spent` and cannot confirm anything.
3. **Thresholds are written before the run.** Minimum trades (30), minimum independent sessions (30), the best-session test, the 25% profit-share cap, the
   holdout interval rule, and the cost stress (1% half-spread and 2× stop slippage) apply as written in `docs/ROADMAP.md`
   (OTA-308). An entry that changes them must say so, and the change is reviewed as a rule change.
4. **A failed hypothesis is recorded as failed.** It stays in the research ledger (`docs/research/experiments.jsonl`) and counts in the
   multiple-testing divisor (OTA-313, OTA-315). It is not replaced by a tweak on the same window. The next hypothesis is registered as a new entry.
5. **Discovery is not confirmation.** A pattern found while looking at a window is a hypothesis for a later, frozen
   window. It cannot be confirmed on the window that suggested it.
6. **Registration is recorded in the ledger.** Before a confirmation runs, `npm run ledger -- register --hypothesis <id>` writes a registration to `docs/research/experiments.jsonl`. The ledger refuses a confirmation without one, and refuses a confirmation on a window that is not Frozen.

## Entry template

```
### PRE-<yyyy-mm-dd>-<n>: <one-line hypothesis>
- Committed: <git commit that adds this entry>
- Family and cells: <strategy family> | <context dimension=value, or "pooled">
- Underlyings: <NIFTY | BANKNIFTY | SENSEX, pooled only if the rule is the same across them>
- Window: <a window from HOLDOUT.md with status Frozen>
- Dataset sha256 and sdkVersion: <from the frozen manifest>
- Metric and rule: <e.g. holdout block-bootstrap 95% lower bound of mean net R > 0, rules as in OTA-308>
- Minimum holdout trades and sessions: 30 and 30, with the best-session test, the 25% profit-share cap and the five-session block floor. These are eligibility floors, not statistical significance (unless changed here, with the reason)
- Cost stress: 1% half-spread and 2× stop slippage, both must pass
- Variants counted in the divisor at registration: <value of priorVariantCount>
- Result: <pending | PASS | FAIL, with the ledger sequence number>
```

## Registered hypotheses

None yet. The first entry is registered once OTA-314 freezes a fresh window (`docs/research/HOLDOUT.md`).
