/**
 * Model router for the research plane — adapted from agent-tui's `supervisor/router/` pattern.
 *
 * The agent-tui version classifies intent (CODE_REVIEW, TOOL_EXECUTION, etc.) and routes to a MiniCPM5
 * sub-agent model, escalating to a fallback model for complex tasks. The research-plane version does the
 * same thing but for hypothesis generation: simple diagnostics (few cells, no prior experiments, clear
 * negative-expectancy pattern) route to a small local model (e.g. qwen2.5:3b); complex diagnostics
 * (many cells, prior experiments to reason about, conflicting signals) escalate to a larger model
 * (e.g. qwen2.5:7b).
 *
 * Why this matters:
 *   - The ResearchAgent runs the LLM on every loop iteration. If every iteration uses the 7B model,
 *     a busy loop burns GPU cycles on easy cases that a 3B model could handle.
 *   - The complexity scorer is deterministic and cheap (a few field reads + comparisons), so the routing
 *     decision adds negligible latency.
 *   - The router is conservative: when in doubt, escalate. A false "simple" routing wastes an LLM call
 *     on a model too small to produce good hypotheses; a false "escalate" wastes GPU cycles but produces
 *     better hypotheses. The asymmetry favors escalation.
 *
 * Scoring dimensions:
 *   1. Number of worst/best cells — more cells = more context to reason about = harder.
 *   2. Whether prior experiments exist in the memory — reasoning over history is harder than cold-start.
 *   3. Whether the last experiment's verdict was REJECT — a failed experiment requires diagnosis, not
 *      just re-proposal, which is harder.
 *   4. Whether the worst cells have enough sample (n >= 30) — thin-sample cells require cautious
 *      proposals, which the small model may handle poorly.
 *   5. Whether the champion's params are at the seed defaults — a seed champion is a cold-start case
 *      (simpler); a mutated champion requires reasoning about what already changed.
 */

import type { ResearchDiagnostics } from './ResearchAgent.js';

/** The complexity score for a diagnostics digest. */
export interface ComplexityScore {
  /** 0..1 — probability this task is too complex for the small model alone. */
  score: number;
  /** Human-readable rationale for each contributing factor. */
  reasons: string[];
  /** Recommended action: route to the small model, or escalate to the large model. */
  recommendation: 'local' | 'escalate';
}

/** The default threshold above which the router escalates. Conservative: 0.5 = "when in doubt, escalate". */
export const DEFAULT_ESCALATION_THRESHOLD = 0.5;

/** Configuration for the model router. */
export interface ModelRouterConfig {
  /** The small model — used for simple diagnostics. Default: 'qwen2.5:3b'. */
  smallModel: string;
  /** The large model — used for complex diagnostics. Default: 'qwen2.5:7b'. */
  largeModel: string;
  /** The escalation threshold (0..1). Scores at or above this escalate. Default: 0.5. */
  threshold: number;
}

export const DEFAULT_MODEL_ROUTER_CONFIG: ModelRouterConfig = {
  smallModel: 'qwen2.5:3b',
  largeModel: 'qwen2.5:7b',
  threshold: DEFAULT_ESCALATION_THRESHOLD,
};

/** The router's decision: which model to use, and why. */
export interface ModelChoice {
  /** The model name to pass to the LLM client. */
  model: string;
  /** The complexity score that drove the decision. */
  score: ComplexityScore;
  /** 'local' (small model) or 'escalate' (large model). */
  kind: 'local' | 'escalate';
}

/**
 * Score the complexity of a diagnostics digest. Pure function: same input → same output, no side effects.
 *
 * The scoring is intentionally a heuristic — it's a cheap proxy for "how hard is this for an LLM?".
 * The weights are tunable; the defaults are conservative (favor escalation).
 */
export function scoreComplexity(diagnostics: ResearchDiagnostics): ComplexityScore {
  const reasons: string[] = [];
  let s = 0;

  // 1. Number of worst cells — each cell is a context the LLM must reason about.
  const worstCellCount = diagnostics.worstCells.length;
  if (worstCellCount >= 5) {
    s += 0.20;
    reasons.push(`${worstCellCount} worst cells (>= 5)`);
  } else if (worstCellCount >= 3) {
    s += 0.10;
    reasons.push(`${worstCellCount} worst cells (>= 3)`);
  }

  // 2. Number of best cells — same logic, but best cells are signal not noise.
  const bestCellCount = diagnostics.bestCells.length;
  if (bestCellCount >= 5) {
    s += 0.10;
    reasons.push(`${bestCellCount} best cells (>= 5)`);
  }

  // 3. Last experiment verdict — a REJECT requires diagnosis (why did it fail?), which is harder than
  //    a PROMOTE (which just says "do more of this") or no prior experiment (cold start).
  const lastExp = diagnostics.lastExperiment;
  if (lastExp) {
    // There's a prior experiment — the LLM must reason over it.
    s += 0.15;
    reasons.push('prior experiment exists (reasoning over history)');
    // If the test n is large, the statistics are reliable — the LLM can trust them. If small, the LLM
    // must reason about uncertainty, which is harder.
    if (lastExp.test.n < 30) {
      s += 0.10;
      reasons.push(`last experiment test n=${lastExp.test.n} (< 30, thin sample)`);
    }
  }

  // 4. Worst cells with thin sample — the LLM must be cautious about proposing changes on thin data.
  const thinWorstCells = diagnostics.worstCells.filter((c) => c.n < 30).length;
  if (thinWorstCells >= 2) {
    s += 0.15;
    reasons.push(`${thinWorstCells} worst cells with n < 30 (thin-sample reasoning)`);
  }

  // 5. Champion at seed defaults — cold start. The LLM doesn't need to reason about what already changed.
  //    This is the simplest case.
  const params = diagnostics.currentParams;
  const isSeed = (
    params.minimumRewardRisk === 1.50 &&
    params.maxSweepAgeCandles === 6 &&
    params.minSweepDepthAtr === 0 &&
    params.minSweepDisplacementAtr === 0
  );
  if (isSeed && !lastExp) {
    // Cold start with no prior experiments — the simplest case. Reduce the score.
    s -= 0.15;
    reasons.push('cold start (seed champion, no prior experiments)');
  }

  // Clamp to [0, 1].
  s = Math.max(0, Math.min(1, s));

  return {
    score: s,
    reasons,
    recommendation: s >= DEFAULT_ESCALATION_THRESHOLD ? 'escalate' : 'local',
  };
}

/**
 * The model router. Wraps a ComplexityScorer + a ModelRouterConfig. Call `decide(diagnostics)` to get
 * the model name to use for the next ResearchAgent.propose() call.
 *
 * The router is pure: same diagnostics + same config → same choice. No side effects, no LLM calls.
 */
export class ModelRouter {
  constructor(private readonly config: ModelRouterConfig = DEFAULT_MODEL_ROUTER_CONFIG) {}

  /** Score the complexity of the diagnostics. */
  score(diagnostics: ResearchDiagnostics): ComplexityScore {
    return scoreComplexity(diagnostics);
  }

  /** Decide which model to use for the given diagnostics. Uses the config's threshold, not the
   * score's recommendation (which uses the default threshold). */
  decide(diagnostics: ResearchDiagnostics): ModelChoice {
    const score = this.score(diagnostics);
    const kind: 'local' | 'escalate' = score.score >= this.config.threshold ? 'escalate' : 'local';
    return {
      model: kind === 'escalate' ? this.config.largeModel : this.config.smallModel,
      score,
      kind,
    };
  }
}

/**
 * A model router that always returns the same model. Used as a no-op when routing is disabled (e.g. the
 * operator wants to force a specific model for all iterations). The ResearchAgent accepts this as a
 * drop-in replacement for the real router.
 */
export class FixedModelRouter {
  constructor(private readonly model: string) {}

  decide(_diagnostics: ResearchDiagnostics): ModelChoice {
    return {
      model: this.model,
      score: { score: 0, reasons: ['fixed model (routing disabled)'], recommendation: 'local' },
      kind: 'local',
    };
  }
}
