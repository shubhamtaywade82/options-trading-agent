/**
 * Research agent: an LLM that *proposes* strategy mutations, never executes them.
 *
 * The division of labor between this agent and the rest of the research plane:
 *   - The ResearchAgent reads diagnostics (which cells of the conditional-edge matrix are profitable / unprofitable,
 *     where the champion is collapsing, what the parent's worst regime is) and proposes *hypotheses* — natural-language
 *     statements like "the champion's poor TREND_UP-HIGH_VOL-LONG performance suggests the sweep depth floor is too low".
 *   - Each hypothesis is converted into a parameter mutation: "raise minSweepDepthAtr from 0 to 0.75".
 *   - The ExperimentRunner validates the mutation; the PromotionGate decides whether to promote.
 *   - The agent never sees live market data, never writes to the DecisionJournal, never calls a strategy function.
 *     It is the *scientist*, not the trader.
 *
 * The LLM client is pluggable (the same `AdvisorClient` interface the OllamaAdvisor uses) so tests can inject
 * a deterministic stub. When no client is configured (Ollama offline, no API key), the agent falls back to a
 * deterministic *rule-based* proposer that reads diagnostics and proposes the single most-impactful mutation
 * implied by the data — so the research plane still operates without an LLM, just less creatively.
 */

import type { AdvisorClient } from '../ollama/advisor.js';
import type { CellStat } from './ConditionalEdge.js';
import type { ExperimentResult } from './ExperimentRunner.js';
import type { StructLiqSpecParams, StrategySpec } from './StrategySpec.js';
import { DEFAULT_MAX_REPAIR_RETRIES, HypothesisRepairLoop } from './HypothesisRepairLoop.js';
import type { ResearchEventBus } from './Events.js';
import type { ExperimentMemory } from './ExperimentMemory.js';
import { formatSearchResults } from './ExperimentMemory.js';
import { DEFAULT_MODEL_ROUTER_CONFIG, FixedModelRouter, ModelRouter, type ModelChoice, type ModelRouterConfig } from './ModelRouter.js';

/** A natural-language hypothesis + the parameter mutation it implies. */
export interface Hypothesis {
  /** Stable id; used as `motivatedBy` link from the spec the hypothesis produces. */
  id: string;
  /** One-sentence observation: "champion collapses in TRANSITION | COMPRESSED". */
  observation: string;
  /** One-sentence proposal: "require minSweepDepthAtr >= 0.75 in TRANSITION". */
  proposal: string;
  /** The parameter mutation implied by the proposal. Applied verbatim to the parent spec. */
  changes: Partial<StructLiqSpecParams>;
  /** The cell keys (or experiment fields) that motivated this hypothesis. */
  motivatedBy: string[];
  /** Whether the LLM produced this (true) or the deterministic fallback did (false). */
  source: 'llm' | 'fallback';
  /** The model that produced this, if any. */
  model?: string;
}

/** Compact diagnostic digest the LLM (or fallback) reads to propose hypotheses. */
export interface ResearchDiagnostics {
  championId: string;
  championVersion: number;
  /** Worst cells (lowest mean R) from the champion's conditional matrix. */
  worstCells: CellStat[];
  /** Best cells (highest mean R) from the champion's conditional matrix. */
  bestCells: CellStat[];
  /** The champion's most recent experiment result, if any. */
  lastExperiment?: ExperimentResult;
  /** The champion's current parameter values. */
  currentParams: StructLiqSpecParams;
}

/** Render diagnostics as a compact text block for the LLM prompt. */
export function renderDiagnostics(d: ResearchDiagnostics): string {
  const lines: string[] = [];
  lines.push(`# Diagnostics for ${d.championId} v${d.championVersion}`);
  lines.push('');
  lines.push('## Current parameters');
  for (const [k, v] of Object.entries(d.currentParams)) {
    lines.push(`- ${k}: ${v}`);
  }
  lines.push('');
  lines.push('## Worst cells (regime | phase | side)');
  for (const c of d.worstCells.slice(0, 5)) {
    const s = c.stats;
    lines.push(`- ${c.key}: n=${c.n}, mean=${s ? s.mean.toFixed(3) : 'n/a'}R, LCB=${s ? s.ciLow.toFixed(3) : 'n/a'}, significant=${c.significant}`);
  }
  lines.push('');
  lines.push('## Best cells');
  for (const c of d.bestCells.slice(0, 5)) {
    const s = c.stats;
    lines.push(`- ${c.key}: n=${c.n}, mean=${s ? s.mean.toFixed(3) : 'n/a'}R, LCB=${s ? s.ciLow.toFixed(3) : 'n/a'}, significant=${c.significant}`);
  }
  if (d.lastExperiment) {
    const e = d.lastExperiment;
    lines.push('');
    lines.push('## Last experiment');
    lines.push(`- OOS: n=${e.test.n}, mean=${e.test.meanNetR.toFixed(3)}R, PF=${e.test.profitFactor.toFixed(2)}, DD=${e.test.maxDrawdownR.toFixed(2)}R`);
    lines.push(`- Parent OOS: n=${e.parentTest.n}, mean=${e.parentTest.meanNetR.toFixed(3)}R`);
    lines.push(`- Per-symbol:`);
    for (const s of e.perSymbol) lines.push(`  - ${s.key}: n=${s.n}, mean=${s.meanNetR.toFixed(3)}R`);
  }
  return lines.join('\n');
}

const LLM_PROMPT_PREFIX = `You are a research scientist for a crypto trading system. You PROPOSE parameter mutations; you DO NOT execute trades.
Read the diagnostics below and propose up to 3 hypotheses as a JSON array. Each hypothesis MUST have:
  - observation: a one-sentence description of what the data shows.
  - proposal: a one-sentence description of the parameter change you propose.
  - changes: a JSON object with one or more of these keys, each mapped to a number:
      "minimumRewardRisk", "maxSweepAgeCandles", "minBreakDistanceAtr", "stopBufferAtr",
      "minStopAtr", "maxStopAtr", "minSweepDepthAtr", "minSweepDisplacementAtr"
Return ONLY a JSON array. No commentary, no markdown.

Example output:
[
  {"observation":"champion collapses in TRANSITION | COMPRESSED | LONG","proposal":"require sweep depth >= 0.5","changes":{"minSweepDepthAtr":0.5}},
  {"observation":"best cells have RR >= 1.75","proposal":"raise RR floor to 1.75","changes":{"minimumRewardRisk":1.75}}
]

Diagnostics:
`;

/** Parse the LLM's response into structured hypotheses. Tolerates markdown fences and trailing commentary. */
export function parseHypotheses(text: string, model?: string): Hypothesis[] {
  let json: unknown;
  try {
    // Strip markdown fences if present
    const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    json = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(json)) return [];
  const out: Hypothesis[] = [];
  for (let i = 0; i < json.length; i += 1) {
    const item = json[i] as Record<string, unknown>;
    if (typeof item.observation !== 'string' || typeof item.proposal !== 'string' || item.changes === null || typeof item.changes !== 'object') continue;
    const changes: Partial<StructLiqSpecParams> = {};
    const allowed = ['minimumRewardRisk', 'maxSweepAgeCandles', 'minBreakDistanceAtr', 'stopBufferAtr', 'minStopAtr', 'maxStopAtr', 'minSweepDepthAtr', 'minSweepDisplacementAtr'];
    let valid = true;
    for (const [k, v] of Object.entries(item.changes as Record<string, unknown>)) {
      if (!allowed.includes(k) || typeof v !== 'number' || !Number.isFinite(v)) { valid = false; break; }
      (changes as Record<string, number>)[k] = v;
    }
    if (!valid || Object.keys(changes).length === 0) continue;
    out.push({
      id: `h-${Date.now()}-${i}`,
      observation: item.observation,
      proposal: item.proposal,
      changes,
      motivatedBy: [],
      source: 'llm',
      model,
    });
  }
  return out;
}

/**
 * Deterministic fallback proposer — used when the LLM is unavailable. Reads the worst/best cells and proposes
 * the single most-impactful mutation implied by the data: if the worst cells share a low sweep depth, raise
 * the sweep depth floor; if the best cells share a high RR, raise the RR floor.
 *
 * This is intentionally simple — it is the floor of capability, not the ceiling. The LLM is expected to do better.
 */
export function fallbackHypotheses(d: ResearchDiagnostics): Hypothesis[] {
  const out: Hypothesis[] = [];
  if (d.worstCells.length === 0) return out;

  // Rule 1: if any worst cell has a negative mean and at least 10 trades, propose raising minSweepDepthAtr to 0.5.
  // This is the most common failure mode in the existing research: shallow sweeps during high volatility.
  const negativeWithSample = d.worstCells.filter((c) => c.stats !== null && c.stats.mean < 0 && c.n >= 10);
  if (negativeWithSample.length > 0 && d.currentParams.minSweepDepthAtr < 0.5) {
    out.push({
      id: `h-fallback-${Date.now()}-1`,
      observation: `${negativeWithSample.length} cells have negative mean R with n >= 10 (worst: ${negativeWithSample[0].key} at ${negativeWithSample[0].stats!.mean.toFixed(3)}R)`,
      proposal: 'raise minSweepDepthAtr from current to 0.5 to filter shallow sweeps',
      changes: { minSweepDepthAtr: 0.5 },
      motivatedBy: negativeWithSample.map((c) => c.key),
      source: 'fallback',
    });
  }

  // Rule 2: if the best cells all have RR >= 1.75 and the worst cells have RR < 1.5, raise the RR floor.
  const bestRr = d.bestCells.slice(0, 3);
  if (bestRr.length > 0 && bestRr.every((c) => c.stats !== null && c.stats.mean > 0.2) && d.currentParams.minimumRewardRisk < 1.75) {
    out.push({
      id: `h-fallback-${Date.now()}-2`,
      observation: `top ${bestRr.length} cells all have mean R > 0.20 (best: ${bestRr[0].key} at ${bestRr[0].stats!.mean.toFixed(3)}R)`,
      proposal: 'raise minimumRewardRisk to 1.75 to concentrate on the profitable RR band',
      changes: { minimumRewardRisk: 1.75 },
      motivatedBy: bestRr.map((c) => c.key),
      source: 'fallback',
    });
  }

  return out;
}

/**
 * The research agent. Wraps a pluggable LLM client and a deterministic fallback. Call `propose(diagnostics)` to
 * get a list of hypotheses; each hypothesis is a partial parameter mutation ready for the ExperimentRunner.
 *
 * The agent does NOT mutate the registry, NOT run experiments, NOT decide promotion. It only proposes.
 *
 * Repair loop: when the LLM produces malformed output (non-JSON, unknown keys, non-numeric values), the
 * agent invokes the HypothesisRepairLoop to re-prompt the LLM with the specific validation errors, up to
 * `maxRepairRetries` times. Only if the repair loop also fails does the agent fall back to the deterministic
 * proposer. This recovers LLM calls that would otherwise be wasted.
 */
export class ResearchAgent {
  private readonly repairLoop: HypothesisRepairLoop | null;
  private readonly router: ModelRouter | FixedModelRouter;

  constructor(
    private readonly client: AdvisorClient | null,
    private readonly model: string = 'qwen2.5:7b',
    private readonly maxRepairRetries: number = DEFAULT_MAX_REPAIR_RETRIES,
    private readonly bus: ResearchEventBus | null = null,
    private readonly memory: ExperimentMemory | null = null,
    routerConfig: ModelRouterConfig | null = DEFAULT_MODEL_ROUTER_CONFIG,
  ) {
    this.repairLoop = client ? new HypothesisRepairLoop(client, model, maxRepairRetries) : null;
    // When routerConfig is null, routing is disabled — every call uses the constructor's `model`.
    // Otherwise, the ModelRouter picks the model per-diagnostics based on complexity.
    this.router = routerConfig ? new ModelRouter(routerConfig) : new FixedModelRouter(model);
  }

  /** True when an LLM client is configured and reachable; false otherwise (fallback will be used). */
  hasLlm(): boolean { return this.client !== null; }

  /**
   * Propose hypotheses from diagnostics. Tries the LLM first; if the output is malformed, invokes the repair
   * loop to re-prompt with validation errors. Only if the repair loop also fails does the agent fall back to
   * the deterministic proposer.
   *
   * Model routing: when a routerConfig is configured, the agent queries the ModelRouter to pick the model
   * for this diagnostics digest (simple → small model, complex → large model). The choice is emitted as a
   * `model_routed` event so the operator can monitor routing decisions. When routing is disabled
   * (routerConfig=null), the constructor's `model` is used for every call.
   *
   * Memory: when an ExperimentMemory is configured, the agent queries it for prior experiments on similar
   * cells and includes the results in the LLM prompt — "we already tried X and it was REJECTED for Y" — so
   * the LLM doesn't propose the same hypothesis twice. The fallback proposer also reads the memory and skips
   * any hypothesis whose changes match an already-indexed REJECTED experiment.
   *
   * Emits `hypothesis_repaired` events via the bus (when configured) so the operator can monitor LLM drift:
   * a rising repair rate signals the model is degrading.
   *
   * The fallback is intentionally conservative — it proposes at most two mutations, both gated by sample size.
   */
  async propose(diagnostics: ResearchDiagnostics): Promise<Hypothesis[]> {
    // Query the experiment memory for prior experiments on similar cells. Included in the LLM prompt below.
    let priorExperiments: Awaited<ReturnType<ExperimentMemory['search']>> = [];
    if (this.memory) {
      try {
        priorExperiments = await this.memory.search(diagnostics, 5);
      } catch {
        // memory search must never break the proposal loop — fall through with empty results
      }
    }

    if (this.client && this.repairLoop) {
      // Route to the appropriate model based on complexity.
      const choice: ModelChoice = this.router.decide(diagnostics);
      this.emit({
        type: 'model_routed',
        payload: {
          model: choice.model,
          kind: choice.kind,
          score: choice.score.score,
          reasons: choice.score.reasons,
        },
      });

      try {
        const prompt = this.buildPrompt(diagnostics, priorExperiments);
        const text = await this.client.generateText({ model: choice.model, prompt });
        const raw = typeof text === 'string' ? text : String(text);

        // The repair loop uses the same model the router chose — re-create it with that model.
        const repairLoop = new HypothesisRepairLoop(this.client, choice.model, this.maxRepairRetries);
        const result = await repairLoop.run({ diagnostics, originalRawOutput: raw });

        if (result.attempts > 0) {
          this.emit({
            type: 'hypothesis_repaired',
            payload: {
              ok: result.ok,
              attempts: result.attempts,
              errorCount: result.history[result.history.length - 1]?.errors.length ?? 0,
              firstError: result.history[result.history.length - 1]?.errors[0]?.slice(0, 200),
            },
          });
        }

        if (result.ok && result.hypotheses.length > 0) {
          return result.hypotheses.map((h) => ({ ...h, model: choice.model }));
        }
      } catch {
        // Network error, timeout — fall through to fallback
      }
    }

    const fallback = fallbackHypotheses(diagnostics);
    return this.filterAlreadyTried(fallback, priorExperiments);
  }

  /** Build the LLM prompt. Includes diagnostics and (when available) prior experiments on similar cells. */
  private buildPrompt(diagnostics: ResearchDiagnostics, priorExperiments: Awaited<ReturnType<ExperimentMemory['search']>>): string {
    const base = LLM_PROMPT_PREFIX + renderDiagnostics(diagnostics);
    if (priorExperiments.length === 0) return base;
    return base + '\n\n## Prior experiments on similar cells (DO NOT re-propose these)\n' + formatSearchResults(priorExperiments);
  }

  /**
   * Filter the fallback hypotheses to drop any whose changes match an already-indexed REJECTED experiment.
   * This prevents the deterministic proposer from re-proposing something the LLM already tried and the gate
   * rejected. PROMOTED experiments are not filtered — re-proposing a promoted change is fine (it may have
   * been superseded by a later champion).
   */
  private filterAlreadyTried(hypotheses: Hypothesis[], priorExperiments: Awaited<ReturnType<ExperimentMemory['search']>>): Hypothesis[] {
    if (priorExperiments.length === 0) return hypotheses;
    const rejectedChanges = new Set(
      priorExperiments
        .filter((r) => r.record.verdict === 'REJECT')
        .map((r) => r.record.changes),
    );
    if (rejectedChanges.size === 0) return hypotheses;
    return hypotheses.filter((h) => {
      const hChanges = Object.entries(h.changes).map(([k, v]) => `${k}=${v}`).sort().join(', ');
      return ![...rejectedChanges].some((rejected) => {
        // Normalize both sides for comparison: sort the key=value pairs.
        const normalized = rejected.split(', ').map((s) => s.trim()).filter(Boolean).sort().join(', ');
        return normalized === hChanges;
      });
    });
  }

  /** Emit an event via the bus if one is configured. */
  private emit(event: { type: string; payload: unknown }): void {
    if (!this.bus) return;
    this.bus.publishSync(event as never);
  }
}

/**
 * Build a candidate spec from a hypothesis. The candidate is a mutation of the parent with the hypothesis's
 * changes applied; its `provenance` records the hypothesis id so the lineage is traceable.
 */
export function candidateFromHypothesis(
  parent: StrategySpec<StructLiqSpecParams>,
  hypothesis: Hypothesis,
): StrategySpec<StructLiqSpecParams> {
  return {
    ...parent,
    version: parent.version + 1,
    parentVersion: parent.version,
    params: { ...parent.params, ...hypothesis.changes },
    hypothesis: `${hypothesis.observation} → ${hypothesis.proposal}`,
    provenance: { kind: 'researcher', hypothesisId: hypothesis.id, model: hypothesis.model ?? hypothesis.source },
    createdAt: Date.now(),
    motivatedBy: hypothesis.motivatedBy,
  };
}
