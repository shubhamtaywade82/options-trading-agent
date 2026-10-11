import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { SetupTransition } from '../decision/SetupLedger.js';
import type { SetupMap, SetupScenario, SetupVerdict } from '../decision/SetupTypes.js';
import type { CostRates } from '../risk/rrProfile.js';

export type SetupOutcome = 'OPEN' | 'TP1' | 'SL' | 'EXPIRED' | 'INVALIDATED' | 'NOT_FILLED' | 'UNRESOLVED';

export interface SetupOutcomeRecord {
  setupId: string;
  symbol: string;
  kind: SetupScenario['kind'];
  direction: SetupScenario['direction'];
  createdAt: number;
  expiresAt: number;
  entryLow: number;
  entryHigh: number;
  /** Conservative hypothetical fill: the worse edge of the entry zone for the direction. */
  entry: number;
  stop: number;
  target1: number;
  rr: number;
  effectiveRr: number | null;
  /** Everything a threshold could later be conditioned on, frozen at creation. */
  features: {
    quadrant: string | null;
    takerZ: number | null;
    oiDeltaPct: number | null;
    regime: string;
    volatility: string;
    htfTrend: string;
    ltfTrend: string;
    locationAtEntry: string | null;
    checks: Record<string, string> | null;
    verdictAtCreation: SetupVerdict | null;
    sweepDepthAtr: number | null;
    sweepDisplacementAtr: number | null;
  };
  statesReached: { state: SetupScenario['state']; at: number }[];
  eligibleSeenAt: number | null;
  entryTouchedAt: number | null;
  /** Excursions in R from the hypothetical entry, measured on marks sampled once per cycle (coarse, not tick data). */
  mfeR: number | null;
  maeR: number | null;
  outcome: SetupOutcome;
  closedAt: number | null;
  /** Hypothetical net R after round-trip costs; null when the entry was never touched. */
  netR: number | null;
}

interface Track { lastMark: number; lastR: number }

const isRecord = (value: unknown): value is SetupOutcomeRecord => {
  const r = value as Partial<SetupOutcomeRecord> | null;
  return r !== null && typeof r === 'object' && typeof r.setupId === 'string' && typeof r.outcome === 'string' && Array.isArray(r.statesReached);
};

const entryOf = (s: Pick<SetupScenario, 'direction' | 'entryLow' | 'entryHigh'>): number => (s.direction === 'LONG' ? s.entryHigh : s.entryLow);

/**
 * Records what every setup would have done, whether or not anything was traded. This is the dataset that
 * turns thresholds into measured numbers: which kind × flow state × RR bucket actually reached TP1 before SL,
 * net of costs. Append-only JSONL, last line per setupId wins; a null path keeps it in memory (tests, replay).
 */
export class SetupOutcomeLedger {
  private readonly records = new Map<string, SetupOutcomeRecord>();
  private readonly tracks = new Map<string, Track>();

  constructor(private readonly filePath: string | null, private readonly costs: CostRates) {
    this.load();
  }

  get(setupId: string): SetupOutcomeRecord | undefined { return this.records.get(setupId); }
  all(): SetupOutcomeRecord[] { return [...this.records.values()]; }

  observe(map: SetupMap, transitions: readonly SetupTransition[], at: number): void {
    const live = new Map(map.scenarios.map((s) => [s.lifecycle?.setupId ?? '', s] as const));
    for (const t of transitions) {
      if (t.kind === 'CREATED') {
        const scenario = live.get(t.setupId);
        if (scenario) this.create(map, scenario);
      } else if (t.kind === 'EXPIRED' || t.kind === 'INVALIDATED') {
        this.close(t.setupId, t.kind, at);
      }
    }
    // Every open record follows the mark, including ones the ledger has dropped from the map (entry missed,
    // thesis withheld): their hypothetical outcome is exactly what the calibration needs.
    for (const record of this.records.values()) {
      if (record.outcome === 'OPEN' && record.symbol === map.symbol) this.update(record, live.get(record.setupId), map.mark, at);
    }
  }

  private create(map: SetupMap, s: SetupScenario): void {
    const id = s.lifecycle!.setupId;
    if (this.records.has(id)) return;
    const record: SetupOutcomeRecord = {
      setupId: id, symbol: map.symbol, kind: s.kind, direction: s.direction,
      createdAt: s.lifecycle!.createdAt, expiresAt: s.lifecycle!.expiresAt,
      entryLow: s.entryLow, entryHigh: s.entryHigh, entry: entryOf(s), stop: s.stopLoss, target1: s.target1, rr: s.rewardRisk,
      effectiveRr: s.quality && Number.isFinite(s.quality.effectiveRr) ? s.quality.effectiveRr : null,
      features: {
        quadrant: map.flow?.quadrant ?? null, takerZ: map.flow?.takerZ ?? null, oiDeltaPct: map.flow?.oiDeltaPct ?? null,
        regime: map.regime, volatility: map.volatility, htfTrend: map.htfTrend, ltfTrend: map.ltfTrend,
        locationAtEntry: s.locationAtEntry?.location ?? null, checks: s.quality?.checks ?? null,
        verdictAtCreation: s.quality?.verdict ?? null,
        sweepDepthAtr: s.evidence?.depthAtr ?? null, sweepDisplacementAtr: s.evidence?.displacementAtr ?? null,
      },
      statesReached: [{ state: s.state, at: s.lifecycle!.createdAt }],
      eligibleSeenAt: null, entryTouchedAt: null, mfeR: null, maeR: null, outcome: 'OPEN', closedAt: null, netR: null,
    };
    this.records.set(id, record);
    this.persist(record);
  }

  private update(r: SetupOutcomeRecord, s: SetupScenario | undefined, mark: number, at: number): void {
    let changed = false;
    if (s && r.statesReached[r.statesReached.length - 1].state !== s.state) { r.statesReached.push({ state: s.state, at }); changed = true; }
    if (s && r.eligibleSeenAt === null && s.quality?.verdict === 'ENTRY_ELIGIBLE') { r.eligibleSeenAt = at; changed = true; }

    const prev = this.tracks.get(r.setupId)?.lastMark ?? mark;
    const risk = Math.abs(r.entry - r.stop);
    if (r.entryTouchedAt === null && risk > 0 && Math.min(prev, mark) <= r.entryHigh && Math.max(prev, mark) >= r.entryLow) {
      r.entryTouchedAt = at; changed = true;
    }
    this.tracks.set(r.setupId, { lastMark: mark, lastR: 0 });
    if (r.entryTouchedAt !== null && risk > 0) {
      const sign = r.direction === 'LONG' ? 1 : -1;
      const excursion = ((mark - r.entry) * sign) / risk;
      r.mfeR = Math.max(r.mfeR ?? excursion, excursion);
      r.maeR = Math.min(r.maeR ?? excursion, excursion);
      this.tracks.set(r.setupId, { lastMark: mark, lastR: excursion });
      // Both levels inside one sampling gap is resolved against us
      const hitStop = r.direction === 'LONG' ? mark <= r.stop : mark >= r.stop;
      const hitTarget = r.direction === 'LONG' ? mark >= r.target1 : mark <= r.target1;
      if (hitStop) return this.finish(r, 'SL', at, -1);
      if (hitTarget) return this.finish(r, 'TP1', at, Math.abs(r.target1 - r.entry) / risk);
    }
    if (changed) this.persist(r);
  }

  private close(setupId: string, why: 'EXPIRED' | 'INVALIDATED', at: number): void {
    const r = this.records.get(setupId);
    if (!r || r.outcome !== 'OPEN') return;
    if (r.entryTouchedAt === null) return this.finish(r, 'NOT_FILLED', at, null);
    this.finish(r, why, at, this.tracks.get(setupId)?.lastR ?? 0);
  }

  private finish(r: SetupOutcomeRecord, outcome: SetupOutcome, at: number, grossR: number | null): void {
    const risk = Math.abs(r.entry - r.stop);
    r.outcome = outcome;
    r.closedAt = at;
    r.netR = grossR === null || !(risk > 0) ? null : grossR - (r.entry * 2 * (this.costs.feeRate + this.costs.slippageRate)) / risk;
    this.tracks.delete(r.setupId);
    this.persist(r);
  }

  private persist(record: SetupOutcomeRecord): void {
    if (!this.filePath) return;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, JSON.stringify(record) + '\n');
    } catch {
      // Research data must never take the trading loop down
    }
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    for (const line of readFileSync(this.filePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed)) this.records.set(parsed.setupId, parsed);
      } catch { /* a torn last line from a crash is skipped */ }
    }
    // Setups still OPEN belong to a session that no longer exists; their outcome can no longer be observed
    for (const r of this.records.values()) {
      if (r.outcome === 'OPEN') { r.outcome = 'UNRESOLVED'; this.persist(r); }
    }
  }
}

export interface OutcomeGroup {
  key: string;
  created: number;
  filled: number;
  resolved: number;
  tp1Rate: number | null;
  meanNetR: number | null;
  lcbNetR: number | null;
}

/** Groups resolved, filled setups and reports hit-rate and net expectancy with a one-sided lower bound. */
export function summarizeSetupOutcomes(records: readonly SetupOutcomeRecord[], keyOf: (r: SetupOutcomeRecord) => string, z = 1.2816): OutcomeGroup[] {
  const groups = new Map<string, SetupOutcomeRecord[]>();
  for (const r of records) groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r]);
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => {
    const filled = list.filter((r) => r.entryTouchedAt !== null);
    const resolved = filled.filter((r) => r.netR !== null);
    const n = resolved.length;
    const mean = n > 0 ? resolved.reduce((sum, r) => sum + r.netR!, 0) / n : null;
    const sd = n > 1 && mean !== null ? Math.sqrt(resolved.reduce((sum, r) => sum + (r.netR! - mean) ** 2, 0) / (n - 1)) : null;
    return {
      key, created: list.length, filled: filled.length, resolved: n,
      tp1Rate: n > 0 ? resolved.filter((r) => r.outcome === 'TP1').length / n : null,
      meanNetR: mean,
      lcbNetR: mean !== null && sd !== null ? mean - z * (sd / Math.sqrt(n)) : null,
    };
  });
}
