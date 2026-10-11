/**
 * Experiment memory — local vector store for prior experiments.
 *
 * Adapted from agent-tui's `toolbox/embeddings.ts` pattern. The agent-tui version is a general-purpose
 * RAG tool (chunk documents, embed, search). The research-plane version is specialized for one job:
 * remembering what experiments have already been run, so the ResearchAgent doesn't propose the same
 * hypothesis twice.
 *
 * What gets indexed:
 *   - Every experiment's candidate hypothesis text + the worst/best cells it was proposed for + the
 *     verdict + the reasons. This is the "what did we try and what happened" record.
 *
 * What gets queried:
 *   - The current champion's worst/best cells. The memory returns the most similar prior experiments,
 *     so the ResearchAgent can read "we already tried raising minSweepDepthAtr to 0.5 on these cells
 *     and it was REJECTED for regime collapse" before proposing the same thing.
 *
 * Embedding strategy:
 *   - Primary: an LLM embedding model (e.g. nomic-embed-text via Ollama) — produces a dense vector.
 *   - Fallback: deterministic Jaccard similarity on token sets — no LLM required, works offline.
 *     This is the same offline-first philosophy as the ResearchAgent's fallback proposer.
 *
 * Persistence: `data/experiment-memory.json` — a single JSON file with all records + embeddings.
 * Loaded on construction; saved on every index() call. A null path keeps it in memory (tests).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ExperimentRecord } from './ExperimentStore.js';
import type { ResearchDiagnostics } from './ResearchAgent.js';

/**
 * The embedding function interface. Implementations:
 *   - OllamaEmbedder: uses `nomic-embed-text` via the AdvisorClient (production).
 *   - null: the memory uses Jaccard text similarity instead of vector similarity (tests, offline).
 */
export interface Embedder {
  embed(texts: readonly string[]): Promise<number[][]>;
  /** The model name (for persistence — records the embedding model version). */
  readonly model: string;
  /** The vector dimension. 0 when the embedder is not a real vector embedder (Jaccard fallback). */
  readonly dimension: number;
}

/**
 * A single record in the experiment memory. One per experiment that has been indexed.
 */
export interface ExperimentMemoryRecord {
  /** The experiment id (matches ExperimentRecord.experimentId). */
  experimentId: string;
  /** The candidate spec id + version. */
  candidateId: string;
  candidateVersion: number;
  /** The hypothesis text (candidate.hypothesis) — the searchable content. */
  hypothesis: string;
  /** The candidate's parameter changes, as a compact string. */
  changes: string;
  /** The worst-cell keys at the time the hypothesis was proposed (the "where" of the experiment). */
  worstCells: string[];
  /** The verdict the gate produced. */
  verdict: 'PROMOTE' | 'REJECT' | 'INSUFFICIENT_DATA';
  /** The verdict reasons (the "why" of the experiment). */
  reasons: string[];
  /** When the experiment ran. */
  ranAt: number;
  /** The embedding of the searchable text (hypothesis + worstCells + changes). null when using Jaccard. */
  embedding: number[] | null;
}

/** The on-disk JSON format. */
interface ExperimentMemoryStore {
  model: string;
  dimension: number;
  records: ExperimentMemoryRecord[];
}

/** A search result: a prior experiment + its similarity score to the query. */
export interface ExperimentMemorySearchResult {
  record: ExperimentMemoryRecord;
  /** 0..1, higher is more similar. */
  score: number;
}

/**
 * Cosine similarity between two equal-length vectors. Returns 0 when either is zero-length.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    magA += a[i]! ** 2;
    magB += b[i]! ** 2;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Jaccard similarity between two token sets. Used as the fallback when no embedding model is available.
 * Tokens are lowercased alphanumeric runs of length >= 3.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const tokensOf = (s: string): Set<string> => {
    const tokens = s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
    return new Set(tokens);
  };
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Build the searchable text for an experiment. This is what gets embedded / Jaccard-compared.
 * Combines the hypothesis, the changes, and the worst-cell keys so similar experiments on similar
 * cells score high.
 */
export function searchableTextOf(record: Pick<ExperimentMemoryRecord, 'hypothesis' | 'changes' | 'worstCells' | 'verdict' | 'reasons'>): string {
  return [
    record.hypothesis,
    record.changes,
    `worst cells: ${record.worstCells.join(', ')}`,
    `verdict: ${record.verdict}`,
    `reasons: ${record.reasons.join('; ')}`,
  ].join('\n');
}

/**
 * Build the searchable query text from diagnostics. This is what the ResearchAgent queries with —
 * the current champion's worst cells + current params, so prior experiments on similar cells surface.
 */
export function searchableQueryOf(diagnostics: ResearchDiagnostics): string {
  return [
    `champion ${diagnostics.championId} v${diagnostics.championVersion}`,
    `worst cells: ${diagnostics.worstCells.map((c) => c.key).join(', ')}`,
    `best cells: ${diagnostics.bestCells.map((c) => c.key).join(', ')}`,
    `current params: ${Object.entries(diagnostics.currentParams).map(([k, v]) => `${k}=${v}`).join(', ')}`,
  ].join('\n');
}

/**
 * The experiment memory. Index every experiment that completes; query before proposing new hypotheses.
 *
 * Construction:
 *   - `new ExperimentMemory(filePath, embedder)` — production: persists to disk, uses the supplied embedder.
 *   - `new ExperimentMemory(filePath, null)` — offline: persists to disk, uses Jaccard similarity.
 *   - `new ExperimentMemory(null, null)` — tests: in-memory only, Jaccard similarity.
 */
export class ExperimentMemory {
  private store: ExperimentMemoryStore = { model: 'jaccard', dimension: 0, records: [] };

  constructor(
    private readonly filePath: string | null = path.resolve('data/experiment-memory.json'),
    private readonly embedder: Embedder | null = null,
  ) {
    this.store.model = this.embedder?.model ?? 'jaccard';
    this.store.dimension = this.embedder?.dimension ?? 0;
    this.load();
  }

  /**
   * Index an experiment record. Embeds the searchable text (if an embedder is configured) and persists.
   * Idempotent: re-indexing an experiment with the same id replaces the prior record.
   */
  async index(record: ExperimentRecord): Promise<void> {
    // De-dup by experimentId — a re-index replaces the prior record.
    this.store.records = this.store.records.filter((r) => r.experimentId !== record.experimentId);

    const hypothesis = record.candidate.hypothesis;
    const changes = Object.entries(record.candidate.params)
      .filter(([k, _v]) => {
        // Only include params that differ from the parent — those are the "changes".
        const parentVal = (record.parent.params as unknown as Record<string, unknown>)[k];
        return parentVal !== undefined;
      })
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    const worstCells = record.result.perRegime.map((r) => r.key);
    const verdict = record.verdict.decision;
    const reasons = record.verdict.reasons;

    const text = searchableTextOf({ hypothesis, changes, worstCells, verdict, reasons });
    let embedding: number[] | null = null;
    if (this.embedder) {
      const vectors = await this.embedder.embed([text]);
      embedding = vectors[0] ?? null;
    }

    const memoryRecord: ExperimentMemoryRecord = {
      experimentId: record.experimentId,
      candidateId: record.candidate.id,
      candidateVersion: record.candidate.version,
      hypothesis,
      changes,
      worstCells,
      verdict,
      reasons,
      ranAt: record.ranAt,
      embedding,
    };

    this.store.records.push(memoryRecord);
    this.persist();
  }

  /**
   * Search for prior experiments similar to the given diagnostics. Returns the top-K results, sorted by
   * similarity (highest first). Each result includes the prior experiment's verdict — so the ResearchAgent
   * can read "we already tried this and it was REJECTED for X" before re-proposing.
   *
   * When an embedder is configured, uses cosine similarity on the dense vectors. When no embedder is
   * configured, uses Jaccard similarity on the text — slower but works offline.
   */
  async search(diagnostics: ResearchDiagnostics, topK = 5): Promise<ExperimentMemorySearchResult[]> {
    if (this.store.records.length === 0) return [];

    const queryText = searchableQueryOf(diagnostics);

    // If the embedder is configured AND records have embeddings, use cosine similarity.
    if (this.embedder && this.store.records.some((r) => r.embedding !== null)) {
      const [queryVec] = await this.embedder.embed([queryText]);
      if (queryVec) {
        return this.store.records
          .map((r) => ({
            record: r,
            score: r.embedding ? cosineSimilarity(queryVec, r.embedding) : 0,
          }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);
      }
    }

    // Fallback: Jaccard similarity on the text.
    return this.store.records
      .map((r) => {
        const text = searchableTextOf(r);
        return { record: r, score: jaccardSimilarity(queryText, text) };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** Returns true if an experiment with the given id is already indexed. */
  has(experimentId: string): boolean {
    return this.store.records.some((r) => r.experimentId === experimentId);
  }

  /** Returns the number of indexed experiments. */
  get size(): number {
    return this.store.records.length;
  }

  /** Returns the embedding model name (or 'jaccard' when no embedder is configured). */
  get model(): string {
    return this.store.model;
  }

  /** Returns all indexed records (for tests / inspection). */
  all(): readonly ExperimentMemoryRecord[] {
    return [...this.store.records];
  }

  private load(): void {
    try {
      if (this.filePath === null || !existsSync(this.filePath)) return;
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (isMemoryStore(parsed)) this.store = parsed;
    } catch {
      // best-effort: a corrupted store starts empty
    }
  }

  private persist(): void {
    if (this.filePath === null) return;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.store, null, 2), 'utf8');
    } catch {
      // best-effort: research data must never break the loop
    }
  }
}

function isMemoryStore(value: unknown): value is ExperimentMemoryStore {
  if (value === null || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return typeof s.model === 'string' && typeof s.dimension === 'number' && Array.isArray(s.records);
}

/**
 * Render a search-results list as a compact text block for inclusion in the ResearchAgent's LLM prompt.
 * The LLM sees "here are prior experiments on similar cells; don't propose the same thing":
 *
 *   [1] score=0.82 | verdict=REJECT | candidate v2 (raise minSweepDepthAtr to 0.5)
 *       reasons: OOS mean R -0.060 < 0.05 | OOS bootstrap LCB -0.102 <= 0
 *   [2] score=0.71 | verdict=PROMOTE | candidate v3 (raise minimumRewardRisk to 1.75)
 *       reasons: OOS mean 0.310R (n=50), LCB 0.050, PF 1.40, DD 4.20R
 */
export function formatSearchResults(results: readonly ExperimentMemorySearchResult[]): string {
  if (results.length === 0) return '(no prior experiments found on similar cells)';
  return results.map((r, i) => {
    const m = r.record;
    return [
      `[${i + 1}] score=${r.score.toFixed(2)} | verdict=${m.verdict} | ${m.candidateId}:v${m.candidateVersion}`,
      `    hypothesis: ${m.hypothesis.slice(0, 200)}`,
      `    changes: ${m.changes}`,
      `    reasons: ${m.reasons.join('; ').slice(0, 300)}`,
    ].join('\n');
  }).join('\n\n');
}
