/**
 * Champion / Challenger registry.
 *
 * The StrategyRegistry is the *genealogy* (every spec that has ever existed). The ChampionRegistry is the
 * *runtime*: which spec is currently live, which are observing in shadow, which are staging for promotion.
 *
 * Stages (the only allowed transitions, enforced by `transition()` via the ALLOWED table):
 *
 *   SHADOW   → the candidate produces signals but does not trade. Compared against the champion on the same
 *              decisions. The candidate has no risk; it is being measured for divergence.
 *   PAPER    → the candidate trades on the paper engine. Realistic execution friction, no real money at risk.
 *   CANARY   → the candidate trades a small live notional. A canary failure (drawdown, kill-switch) rolls back.
 *   PROMOTED → the candidate is now the champion. The previous champion becomes FORMER and can be rolled back to.
 *   REJECTED → the candidate failed promotion and is shelved. It remains in the registry for audit but does not
 *              run again unless an operator explicitly re-stages it.
 *   FORMER   → the prior champion of a successful promotion. Kept so a rollback can restore it.
 *
 * The champion is always a single spec per strategy id. There is at most one challenger per (id, stage) at
 * SHADOW, PAPER, and CANARY — a new challenger at the same stage replaces the prior one (the prior one is
 * auto-REJECTED; if it had not been measured yet, that is a research-process problem to fix, not a runtime one).
 *
 * Event sourcing: every state transition emits a domain event via the supplied `ResearchEventBus`. The bus
 * subscribers persist the event to `data/research-events.jsonl` (the canonical audit trail) and may stream
 * to dashboards. The legacy in-memory `state.history` array is kept for backward compatibility with the
 * existing CLI, but the bus is the source of truth.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { specId, type SpecParams, type StrategySpec } from './StrategySpec.js';
import type { ResearchEventBus } from './Events.js';

export type ChallengerStage = 'SHADOW' | 'PAPER' | 'CANARY' | 'PROMOTED' | 'REJECTED' | 'FORMER';

export interface ChampionEntry {
  id: string;
  version: number;
  /** When this version became champion. */
  since: number;
  /** Optional: the experiment id that promoted it. */
  promotedBy?: string;
  /** Optional: the previous champion this one replaced. */
  replacedVersion?: number;
  /** Optional: free-text note for why this version is champion (e.g. "seed appointment"). */
  note?: string;
}

export interface ChallengerEntry {
  id: string;
  version: number;
  stage: ChallengerStage;
  since: number;
  /** Optional: the experiment id that authorized this stage. */
  experimentId?: string;
  /** Optional: free-text reason for the current stage. */
  note?: string;
}

export interface ChampionRegistryState {
  champions: ChampionEntry[];
  challengers: ChallengerEntry[];
  /** History of every transition, oldest first — the audit trail of who was champion when. Kept for
   * backward compatibility; the bus is the canonical audit trail going forward. */
  history: Array<{ at: number; from: string; to: string; kind: string; note?: string }>;
}

function isState(value: unknown): value is ChampionRegistryState {
  if (value === null || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return Array.isArray(s.champions) && Array.isArray(s.challengers) && Array.isArray(s.history);
}

/**
 * Allowed transitions for challenger stages. The default forward path is SHADOW → PAPER → CANARY → PROMOTED,
 * walked one stage at a time — skipping forward (SHADOW → CANARY) throws IllegalTransitionError.
 *
 * PROMOTED is reachable from any active stage (SHADOW / PAPER / CANARY): an operator may explicitly
 * promote a high-conviction candidate without walking the full pipeline. This is the operator-override
 * path; the auto-staging in SelfImprovementLoop only ever produces SHADOW candidates that the operator
 * then walks forward. REJECTED is reachable from any active stage too — a candidate can be killed at
 * any point.
 *
 * PROMOTED, REJECTED, and FORMER are terminal.
 *
 * Adapted from agent-tui's StateMachine.ALLOWED pattern: a declarative transition graph rather than an
 * imperative stage-order array. This makes "what can I do next?" a pure lookup (`reachableFrom`).
 */
const ALLOWED: Record<ChallengerStage, ChallengerStage[]> = {
  SHADOW: ['PAPER', 'PROMOTED', 'REJECTED'],
  PAPER: ['CANARY', 'PROMOTED', 'REJECTED'],
  CANARY: ['PROMOTED', 'REJECTED'],
  PROMOTED: [],
  REJECTED: [],
  FORMER: [],
};

/** Throws when a transition is not in the ALLOWED table. Adapted from agent-tui's IllegalTransitionError. */
export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: ChallengerStage,
    public readonly to: ChallengerStage,
    public readonly specKey: string,
  ) {
    super(`Illegal challenger transition: ${from} → ${to} for ${specKey}`);
    this.name = 'IllegalTransitionError';
  }
}

/**
 * Champion / Challenger registry with persistent state. The state file is *rewritten* on every transition
 * (not appended), because the registry is small and the runtime must always reflect the latest state — an append
 * file with stale champion entries would be ambiguous. Transitions are atomic (tmp + rename).
 *
 * An optional `ResearchEventBus` makes every transition observable. When supplied, the registry emits
 * `champion_appointed`, `challenger_staged`, `challenger_transitioned`, and `champion_rolled_back` events.
 */
export class ChampionRegistry {
  private state: ChampionRegistryState = { champions: [], challengers: [], history: [] };

  constructor(
    private readonly filePath: string | null = path.resolve('data/champion-registry.json'),
    private readonly bus: ResearchEventBus | null = null,
  ) {
    this.load();
  }

  /** The current champion for an id, or undefined if no champion has been appointed. */
  champion(id: string): ChampionEntry | undefined {
    return this.state.champions.find((c) => c.id === id);
  }

  /** Resolve the champion spec from a StrategyRegistry. Returns undefined if no champion or registry missing. */
  championSpec<P extends SpecParams = SpecParams>(id: string, registry: { get<P2 extends SpecParams>(id: string, version: number): StrategySpec<P2> | undefined }): StrategySpec<P> | undefined {
    const entry = this.champion(id);
    return entry ? registry.get<P>(id, entry.version) : undefined;
  }

  /** Every active challenger (SHADOW, PAPER, CANARY) across all strategy ids. */
  activeChallengers(): ChallengerEntry[] {
    return this.state.challengers.filter((c) => c.stage === 'SHADOW' || c.stage === 'PAPER' || c.stage === 'CANARY');
  }

  /** Active challengers for a specific strategy id. */
  challengersFor(id: string): ChallengerEntry[] {
    return this.state.challengers.filter((c) => c.id === id && (c.stage === 'SHADOW' || c.stage === 'PAPER' || c.stage === 'CANARY'));
  }

  /** Returns the set of stages reachable from `from` in one hop, per the ALLOWED table. */
  reachableFrom(from: ChallengerStage): ChallengerStage[] {
    return [...(ALLOWED[from] ?? [])];
  }

  /** Returns true if `from → to` is a legal forward transition. */
  canTransition(from: ChallengerStage, to: ChallengerStage): boolean {
    return (ALLOWED[from] ?? []).includes(to);
  }

  /**
   * Appoint a spec as champion immediately. Used for the initial seed: v1 of every strategy is appointed champion
   * with no challenger. For non-seed promotions, use `transition(id, version, 'PROMOTED', experimentId)` instead,
   * which demotes the previous champion to FORMER.
   */
  appoint(spec: StrategySpec, note?: string): void {
    const entry: ChampionEntry = { id: spec.id, version: spec.version, since: Date.now(), note };
    const existing = this.champion(spec.id);
    if (existing) entry.replacedVersion = existing.version;
    this.state.champions = [...this.state.champions.filter((c) => c.id !== spec.id), entry];
    this.state.history.push({ at: Date.now(), from: existing ? specId(existing) : '∅', to: specId(spec), kind: 'APPOINT', note });
    this.emit({
      type: 'champion_appointed',
      payload: { id: spec.id, version: spec.version, replacedVersion: existing?.version, note },
    });
    this.persist();
  }

  /**
   * Transition a challenger to a new stage. The transition is validated against the ALLOWED table — skipping a
   * stage (SHADOW → CANARY) throws IllegalTransitionError. PROMOTED is the terminal stage: the challenger
   * becomes champion and the previous champion becomes FORMER.
   */
  transition(id: string, version: number, to: ChallengerStage, note?: string, experimentId?: string): void {
    const current = this.state.challengers.find((c) => c.id === id && c.version === version);
    if (!current) throw new Error(`no challenger for ${specId({ id, version })}`);
    const from = current.stage;

    if (to === 'PROMOTED') {
      // PROMOTED is legal from any active stage (SHADOW / PAPER / CANARY). Skipping stages is allowed;
      // the operator decides when a candidate is ready.
      if (!this.canTransition(from, to)) {
        throw new IllegalTransitionError(from, to, specId({ id, version }));
      }
      const prior = this.champion(id);
      const entry: ChampionEntry = { id, version, since: Date.now(), promotedBy: experimentId, replacedVersion: prior?.version };
      this.state.champions = [...this.state.champions.filter((c) => c.id !== id), entry];
      // Demote the prior champion to FORMER so a rollback can restore it.
      if (prior) {
        this.state.challengers = this.state.challengers
          .filter((c) => !(c.id === id && c.version === version))
          .concat([{ id: prior.id, version: prior.version, stage: 'FORMER', since: Date.now(), note: 'demoted by promotion' }]);
      } else {
        this.state.challengers = this.state.challengers.filter((c) => !(c.id === id && c.version === version));
      }
      this.state.history.push({ at: Date.now(), from: prior ? specId(prior) : '∅', to: specId({ id, version }), kind: 'PROMOTE', note });
      this.emit({
        type: 'challenger_transitioned',
        payload: { id, version, from, to, note, experimentId },
      });
      this.persist();
      return;
    }

    if (to === 'REJECTED') {
      this.state.challengers = this.state.challengers
        .map((c) => (c.id === id && c.version === version ? { ...c, stage: 'REJECTED', since: Date.now(), note, experimentId: experimentId ?? c.experimentId } : c));
      this.state.history.push({ at: Date.now(), from: specId({ id, version }), to: 'REJECTED', kind: 'REJECT', note });
      this.emit({
        type: 'challenger_transitioned',
        payload: { id, version, from, to, note, experimentId },
      });
      this.persist();
      return;
    }

    // Forward-stage transition: must be allowed by the table.
    if (!this.canTransition(from, to)) {
      throw new IllegalTransitionError(from, to, specId({ id, version }));
    }
    this.state.challengers = this.state.challengers
      .map((c) => (c.id === id && c.version === version ? { ...c, stage: to, since: Date.now(), note, experimentId: experimentId ?? c.experimentId } : c));
    this.state.history.push({ at: Date.now(), from: specId({ id, version }), to, kind: 'TRANSITION', note });
    this.emit({
      type: 'challenger_transitioned',
      payload: { id, version, from, to, note, experimentId },
    });
    this.persist();
  }

  /**
   * Stage a new challenger at SHADOW. If a SHADOW challenger already exists for this id, it is auto-REJECTED —
   * a research process that stages two shadows without measuring the first is a process bug, not a runtime bug,
   * and the older one is preserved in history as REJECTED.
   */
  stageChallenger(spec: StrategySpec, note?: string): void {
    const existing = this.state.challengers.find((c) => c.id === spec.id && c.stage === 'SHADOW');
    let supersededVersion: number | undefined;
    if (existing) {
      supersededVersion = existing.version;
      this.state.challengers = this.state.challengers
        .map((c) => (c.id === spec.id && c.version === existing.version ? { ...c, stage: 'REJECTED', since: Date.now(), note: 'superseded by newer shadow' } : c));
    }
    this.state.challengers.push({ id: spec.id, version: spec.version, stage: 'SHADOW', since: Date.now(), note });
    this.state.history.push({ at: Date.now(), from: '∅', to: specId(spec), kind: 'STAGE', note });
    this.emit({
      type: 'challenger_staged',
      payload: { id: spec.id, version: spec.version, note, supersededVersion },
    });
    this.persist();
  }

  /**
   * Rollback: restore the previous champion. Used when a canary fails or an operator overrides a promotion.
   * The current champion is REJECTED (not demoted to FORMER — FORMER is reserved for the prior champion of a
   * successful promotion).
   */
  rollback(id: string, reason: string): ChampionEntry | undefined {
    const current = this.champion(id);
    if (!current || current.replacedVersion === undefined) return undefined;
    const restored: ChampionEntry = { id, version: current.replacedVersion, since: Date.now(), note: `rollback: ${reason}` };
    this.state.champions = [...this.state.champions.filter((c) => c.id !== id), restored];
    this.state.challengers = this.state.challengers
      .filter((c) => !(c.id === id && c.version === current.version))
      .concat([{ id, version: current.version, stage: 'REJECTED', since: Date.now(), note: `rollback: ${reason}` }]);
    this.state.history.push({ at: Date.now(), from: specId(current), to: specId(restored), kind: 'ROLLBACK', note: reason });
    this.emit({
      type: 'champion_rolled_back',
      payload: { id, fromVersion: current.version, toVersion: restored.version, reason },
    });
    this.persist();
    return restored;
  }

  /** Returns the full transition history (legacy in-memory trail). */
  auditTrail(): ChampionRegistryState['history'] {
    return [...this.state.history];
  }

  /** Snapshot of the entire state — used by the dashboard / CLI to render the current state. */
  snapshot(): ChampionRegistryState {
    return JSON.parse(JSON.stringify(this.state)) as ChampionRegistryState;
  }

  /** Emit an event via the bus if one is configured. Synchronous (fire-and-forget for async subscribers). */
  private emit(event: { type: string; payload: unknown }): void {
    if (!this.bus) return;
    this.bus.publishSync(event as never);
  }

  private load(): void {
    try {
      if (this.filePath === null || !existsSync(this.filePath)) return;
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (isState(parsed)) this.state = parsed;
    } catch {
      // best-effort
    }
  }

  private persist(): void {
    if (this.filePath === null) return;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      renameSync(tmp, this.filePath);
    } catch {
      // best-effort
    }
  }
}
