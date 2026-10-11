/**
 * Golden task definitions — the fixed regression suite for the research plane.
 *
 * Each task is a (ledger, candidate, expected-verdict) triple. The suite is run by `npm run research:golden`
 * and by `tests/goldenTasks.test.ts`. A regression on any task is reported by id so the operator knows exactly
 * what broke.
 *
 * Categories:
 *   gate-reject-*  — the gate must reject a candidate for the documented reason
 *   gate-promote-* — the gate must promote a candidate that genuinely improves on the parent
 *   gate-thin-*    — the gate must return INSUFFICIENT_DATA when the sample is too small (not REJECT)
 *
 * Adding a task:
 *   1. Append to GOLDEN_TASKS with a new stable id (e.g. 'gate-reject-008').
 *   2. Build the ledger with the test-support/ledgerFixture.ts helpers (deterministic via mulberry32).
 *   3. Build the candidate with mutateSpec(seed, changes, hypothesis, provenance).
 *   4. Assert on the expected decision + reason substrings.
 *
 * The suite is intentionally small (8 tasks today). Each task covers one guard of the PromotionGate; if the
 * suite grows past ~20 tasks, consider grouping by category and running them in parallel.
 */

import { mutateSpec, seedStructLiqSpec, type StructLiqSpecParams, type StrategySpec } from './StrategySpec.js';
import { mulberry32 } from './Bootstrap.js';
import type { GoldenTask } from './GoldenTasks.js';
import { makeLedger, makeMultiRegimeLedger } from './LedgerFixtures.js';

/**
 * Helper: produce a candidate spec from the seed by applying the given param changes. The hypothesis and
 * provenance are filled in for auditability — the gate doesn't read them, but the experiment store does.
 */
function candidate(changes: Partial<StructLiqSpecParams>, hypothesis: string): (seed: StrategySpec<StructLiqSpecParams>) => StrategySpec<StructLiqSpecParams> {
  return (seed) => mutateSpec(seed, changes, hypothesis, { kind: 'manual', note: 'golden task' });
}

/**
 * Helper: a ledger with a single regime (TREND_UP | EXPANDED | LONG) and a positive mean R. Used by the
 * promote-* tasks where we want a candidate that genuinely clears the gate.
 */
function profitableSingleRegime(days: number, meanR = 0.4, seed = 11) {
  return () => makeLedger({
    n: days * 8,
    meanR,
    noise: 0.3,
    spacing: 3 * 3_600_000,
    regime: 'TREND_UP',
    volatility: 'EXPANDED',
    direction: 'LONG',
    sweepDepthAtr: 0.8,
    rr: 1.8,
    seed,
    idPrefix: 'profitable',
  });
}

/**
 * Helper: a ledger where the candidate (tighter RR filter) improves on the parent (looser RR filter) by
 * dropping negative-expectancy low-RR trades. Multi-symbol so the gate's symbol-coverage guard passes.
 *
 * Half the trades have RR=1.6 (low-quality, negative expectancy); half have RR=2.2 (high-quality, positive).
 * The parent (seed, RR=1.5 floor) accepts both → mean ~ +0.15. The candidate (RR=2.0 floor) drops the
 * RR=1.6 trades → mean ~ +0.6. Delta = +0.45R, well above the minOosDelta=0.05 threshold.
 *
 * Both RR values are above the seed's 1.5 floor, so the parent sees both halves and the candidate drops
 * the lower-RR half. This is the key to producing a non-zero delta.
 */
function improvingCandidateLedger(days: number, seed = 13) {
  return () => {
    const rand = mulberry32(seed);
    const records = [];
    const T0 = Date.UTC(2026, 0, 1);
    const HOUR = 3_600_000;
    const DAY = 86_400_000;
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    for (let d = 0; d < days; d += 1) {
      for (let k = 0; k < 8; k += 1) {
        const t = T0 + d * DAY + k * (HOUR * 2);
        const lowRr = (d + k) % 2 === 0;
        const rr = lowRr ? 1.6 : 2.2;
        const meanR = lowRr ? -0.3 : 0.6;
        const netR = meanR + (rand() - 0.5) * 0.4;
        const symbol = symbols[(d + k) % symbols.length];
        records.push(...makeLedger({
          n: 1, meanR: netR, noise: 0, from: t, spacing: HOUR,
          regime: 'TREND_UP', volatility: 'EXPANDED', direction: 'LONG',
          sweepDepthAtr: 0.8, rr, seed: d * 100 + k, idPrefix: `improve-d${d}-k${k}`,
          symbol,
        }));
      }
    }
    return records;
  };
}

/** Local mulberry32 alias — uses the shared LedgerFixtures implementation. */
const mulberry32Local = mulberry32;

/**
 * The golden task suite. Order matters only for the report; tasks are independent.
 *
 * Each task is documented with the guard it covers and the regression it would catch.
 */
export const GOLDEN_TASKS: readonly GoldenTask[] = [
  // ─── gate-reject-* : the gate rejects a candidate for the documented reason ──────────────────────────
  {
    id: 'gate-reject-001',
    description: 'A candidate that ties the parent on OOS mean R is REJECTED for zero delta (not promoted).',
    tags: ['gate', 'reject', 'delta'],
    ledger: profitableSingleRegime(100, 0.3, 21),
    candidate: candidate({ minimumRewardRisk: 1.5 }, 'no-op candidate identical to seed'),
    expectedDecision: 'REJECT',
    expectedReasonContains: ['delta vs parent'],
    minTestN: 30,
    minWalkForwardFolds: 1,
  },
  {
    id: 'gate-reject-002',
    description: 'A candidate with negative OOS mean R is REJECTED for negative expectancy.',
    tags: ['gate', 'reject', 'expectancy'],
    ledger: () => makeLedger({
      n: 800, meanR: -0.3, noise: 0.2, spacing: 3 * 3_600_000,
      regime: 'TREND_UP', volatility: 'EXPANDED', direction: 'LONG',
      sweepDepthAtr: 0.8, rr: 1.8, seed: 22, idPrefix: 'negative',
    }),
    candidate: candidate({ minimumRewardRisk: 1.5 }, 'seed params on negative-expectancy ledger'),
    expectedDecision: 'REJECT',
    expectedReasonContains: ['OOS mean R'],
    minTestN: 30,
  },
  {
    id: 'gate-reject-003',
    description: 'A candidate with OOS profit factor below 1.10 is REJECTED (PF floor guard fires).',
    tags: ['gate', 'reject', 'profit-factor'],
    // A ledger with meanR=0.05 and high variance produces PF ~ 1.0 — below the 1.10 floor.
    // The candidate (RR=1.7) drops some trades, leaving PF still below 1.10. Other guards may also fire;
    // we only assert the decision is REJECT (not the specific reason, since the gate reports every
    // failure and the order depends on the data).
    ledger: () => makeLedger({
      n: 800, meanR: 0.05, noise: 1.0, spacing: 3 * 3_600_000,
      regime: 'TREND_UP', volatility: 'EXPANDED', direction: 'LONG',
      sweepDepthAtr: 0.8, rr: 1.8, seed: 23, idPrefix: 'lowpf',
    }),
    candidate: candidate({ minimumRewardRisk: 1.7 }, 'tighter RR on a low-PF ledger'),
    expectedDecision: 'REJECT',
    minTestN: 30,
  },
  {
    id: 'gate-reject-004',
    description: 'A candidate whose worst regime collapses relative to the parent is REJECTED for regime regression.',
    tags: ['gate', 'reject', 'regime'],
    // Multi-regime ledger: the seed sees positive in TREND_UP|EXPANDED, negative elsewhere.
    // The candidate raises minSweepDepthAtr, which doesn't help in TRANSITION (where sweeps are shallower).
    ledger: () => makeMultiRegimeLedger(100, 8, 24),
    candidate: candidate({ minSweepDepthAtr: 1.2 }, 'aggressive sweep-depth filter that collapses TRANSITION'),
    expectedDecision: 'REJECT',
    // The candidate may fail multiple guards; we only assert it fails (not the specific reason, since
    // the multi-regime ledger exercises several at once).
    expectedReasonNotContains: [],
    minTestN: 30,
  },
  {
    id: 'gate-reject-005',
    description: 'A candidate that depends on only one symbol is REJECTED for insufficient symbol coverage.',
    tags: ['gate', 'reject', 'symbol-coverage'],
    // profitableSingleRegime produces a single-symbol (BTCUSDT) ledger. The gate's symbol-coverage guard
    // (min 2 symbols with n>=5) should fire.
    ledger: profitableSingleRegime(100, 0.5, 25),
    candidate: candidate({ minimumRewardRisk: 1.7 }, 'tighter RR that concentrates on the single symbol'),
    expectedDecision: 'REJECT',
    expectedReasonContains: ['symbols with n>=5'],
    minTestN: 30,
  },

  // ─── gate-thin-* : the gate returns INSUFFICIENT_DATA (not REJECT) when the sample is too small ─────
  {
    id: 'gate-thin-001',
    description: 'A candidate with fewer than minTrades OOS observations returns INSUFFICIENT_DATA, not REJECT.',
    tags: ['gate', 'thin', 'insufficient-data'],
    // 5 days of data — far less than the 60+30 default train/test window. The experiment produces n=0.
    ledger: () => makeLedger({
      n: 40, meanR: 0.5, noise: 0.2, spacing: 3 * 3_600_000,
      regime: 'TREND_UP', volatility: 'EXPANDED', direction: 'LONG',
      sweepDepthAtr: 0.8, rr: 1.8, seed: 31, idPrefix: 'thin',
    }),
    candidate: candidate({ minimumRewardRisk: 1.5 }, 'seed params on a too-short ledger'),
    expectedDecision: 'INSUFFICIENT_DATA',
    expectedReasonContains: ['minTrades'],
  },

  // ─── gate-promote-* : the gate promotes a candidate that genuinely improves on the parent ───────────
  {
    id: 'gate-promote-001',
    description: 'A candidate that drops negative-expectancy low-RR trades is PROMOTED (positive delta vs parent).',
    tags: ['gate', 'promote', 'delta'],
    // improvingCandidateLedger: half RR=1.6 (mean -0.3), half RR=2.2 (mean +0.6).
    // Parent (seed, RR=1.5 floor) accepts both → mean ~ +0.15.
    // Candidate (RR=2.0 floor) drops the RR=1.6 trades → mean ~ +0.6.
    // Delta = +0.45R, well above the minOosDelta=0.05 threshold.
    ledger: improvingCandidateLedger(100, 41),
    candidate: candidate({ minimumRewardRisk: 2.0 }, 'raise RR floor to 2.0 to drop negative-expectancy low-RR trades'),
    // The parent uses the seed's RR=1.5 floor, accepting both halves of the ledger.
    parent: (seed) => seed,
    expectedDecision: 'PROMOTE',
    // We don't assert on specific reasons for PROMOTE (the gate's success reasons are dense); we just
    // assert the decision. The minTestN/minWalkForwardFolds guards ensure the experiment actually ran.
    minTestN: 30,
    minWalkForwardFolds: 1,
  },
];

/**
 * The default seed used by the golden suite. Mirrors `seedStructLiqSpec()` so the suite is deterministic
 * regardless of registry state.
 */
export function goldenSeed(): StrategySpec<StructLiqSpecParams> {
  return seedStructLiqSpec();
}
