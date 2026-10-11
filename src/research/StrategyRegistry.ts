/**
 * Strategy registry: persistent lookup of versioned specs by (id, version) and lineage walk back to the seed.
 *
 * Storage: append-only JSONL at `data/strategy-registry.jsonl`. Each line is a `StrategySpec`. A later line with
 * the same (id, version) supersedes earlier ones (last-write-wins), so updates never rewrite history — they
 * append it. A null path keeps the registry in memory (tests, ephemeral research sessions).
 *
 * The registry is the canonical record of "what strategies exist". The ChampionRegistry reads from it to resolve
 * "which version is currently champion"; the ExperimentRunner reads from it to fetch the parent of a candidate;
 * the live trading core reads from it (via `getActiveSpec`) to know which thresholds to apply at decision time.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  mutateSpec,
  paramsEqual,
  seedStructLiqSpec,
  specId,
  type SpecParams,
  type StrategySpec,
  type StrategyFamily,
} from './StrategySpec.js';

type AnySpec = StrategySpec<SpecParams>;

function isSpec(value: unknown): value is AnySpec {
  if (value === null || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return typeof s.id === 'string'
    && typeof s.version === 'number' && Number.isInteger(s.version) && s.version > 0
    && (s.parentVersion === null || (typeof s.parentVersion === 'number' && Number.isInteger(s.parentVersion)))
    && typeof s.family === 'string'
    && typeof s.hypothesis === 'string'
    && typeof s.createdAt === 'number'
    && s.params !== null && typeof s.params === 'object';
}

/**
 * Registry of versioned strategy specs. Append-only persistence; in-memory cache for reads.
 *
 * Mutators return the registered spec (with `createdAt` stamped). Re-registering an identical spec is a no-op
 * and returns the existing record — this is the registry's deduplication rule, so the optimizer can propose the
 * same candidate twice and the experiment engine will only run it once.
 */
export class StrategyRegistry {
  private readonly byKey = new Map<string, AnySpec>();
  private readonly byId = new Map<string, AnySpec[]>();

  constructor(private readonly filePath: string | null = path.resolve('data/strategy-registry.jsonl')) {
    this.load();
  }

  /**
   * Register a new spec. Deduplication: if a spec with the same id and params (after a param-equal check)
   * already exists, that spec is returned without persisting a new version. This stops the optimizer from
   * polluting the registry with parameter-equivalent duplicates.
   */
  register<P extends SpecParams>(spec: StrategySpec<P>): StrategySpec<P> {
    const history = this.byId.get(spec.id) ?? [];
    const prior = history.find((h) => paramsEqual(h.params as P, spec.params));
    if (prior) return prior as StrategySpec<P>;

    const stamped = { ...spec, createdAt: spec.createdAt || Date.now() };
    const key = specId(stamped);
    this.byKey.set(key, stamped);
    this.byId.set(stamped.id, [...history, stamped].sort((a, b) => a.version - b.version));
    this.persist(stamped);
    return stamped;
  }

  /**
   * Convenience: register a child spec produced by mutating a parent in-place. The parent must exist; the child
   * gets the next version number automatically. This is the path the ResearchAgent and Optimizer use.
   */
  registerMutation<P extends SpecParams>(
    parentId: string,
    parentVersion: number,
    changes: Partial<P>,
    hypothesis: string,
    provenance: StrategySpec['provenance'],
    motivatedBy?: string[],
  ): StrategySpec<P> {
    const parent = this.get(parentId, parentVersion);
    if (!parent) throw new Error(`unknown parent ${parentId}:v${parentVersion}`);
    const child = mutateSpec(parent as StrategySpec<P>, changes, hypothesis, provenance, motivatedBy);
    return this.register(child);
  }

  /** Returns the spec for (id, version), or undefined if neither exists. */
  get<P extends SpecParams = SpecParams>(id: string, version: number): StrategySpec<P> | undefined {
    return this.byKey.get(specId({ id, version })) as StrategySpec<P> | undefined;
  }

  /** Latest registered version of a spec id, or undefined if the id is unknown. */
  latest<P extends SpecParams = SpecParams>(id: string): StrategySpec<P> | undefined {
    const history = this.byId.get(id);
    if (!history || history.length === 0) return undefined;
    return history[history.length - 1] as StrategySpec<P>;
  }

  /** Every version of a spec id, oldest first. */
  history<P extends SpecParams = SpecParams>(id: string): StrategySpec<P>[] {
    return (this.byId.get(id) ?? []) as StrategySpec<P>[];
  }

  /** The chain of parent links back to the seed. Includes the spec itself as the first element. */
  lineage<P extends SpecParams = SpecParams>(id: string, version: number): StrategySpec<P>[] {
    const chain: StrategySpec<P>[] = [];
    let cursor = this.get<P>(id, version);
    while (cursor) {
      chain.push(cursor);
      if (cursor.parentVersion === null) break;
      cursor = this.get<P>(id, cursor.parentVersion);
    }
    return chain;
  }

  /** All known specs across all ids, sorted by (id, version). */
  all(): AnySpec[] {
    return [...this.byKey.values()].sort((a, b) =>
      a.id === b.id ? a.version - b.version : a.id.localeCompare(b.id));
  }

  /**
   * Ensures the registry has at least one seed spec for each family known to the research plane.
   * Safe to call multiple times — the dedup rule makes it a no-op after the first call.
   */
  ensureSeeds(): void {
    if (!this.latest(seedStructLiqSpec().id)) this.register(seedStructLiqSpec());
  }

  /** Lists every distinct strategy id in the registry. */
  ids(): string[] {
    return [...this.byId.keys()].sort();
  }

  /** Lists every distinct family in the registry. */
  families(): StrategyFamily[] {
    return [...new Set([...this.byKey.values()].map((s) => s.family))].sort();
  }

  private load(): void {
    try {
      if (this.filePath === null || !existsSync(this.filePath)) return;
      for (const line of readFileSync(this.filePath, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (isSpec(parsed)) {
            const key = specId(parsed);
            this.byKey.set(key, parsed);
            const list = this.byId.get(parsed.id) ?? [];
            this.byId.set(parsed.id, [...list, parsed].sort((a, b) => a.version - b.version));
          }
        } catch {
          // a torn final line from a crash is skipped, not fatal
        }
      }
    } catch {
      // best-effort: research data must never take the trading loop down
    }
  }

  private persist(spec: AnySpec): void {
    if (!this.filePath) return;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, JSON.stringify(spec) + '\n', 'utf8');
    } catch {
      // best-effort, like every persistence in this codebase
    }
  }
}
