/**
 * Hypothesis repair loop — adapted from agent-tui's `supervisor/tools/repair.ts` pattern.
 *
 * When the ResearchAgent asks the LLM for hypotheses, the response may be malformed: non-JSON, unknown
 * parameter keys, non-numeric values, missing fields. The current ResearchAgent silently falls back to the
 * deterministic proposer on any failure — wasting the LLM call. The repair loop instead re-prompts the LLM
 * with the specific validation errors, up to `maxRetries` times.
 *
 * Flow:
 *   1. Attempt 0: parse the original LLM output. If valid, return immediately.
 *   2. For each retry: build a repair prompt that includes the original diagnostics, the previous (invalid)
 *      output, and the specific validation errors. Re-prompt the LLM. Parse + validate.
 *   3. If a retry produces valid hypotheses, return them with `repaired: true` and the attempt count.
 *   4. If all retries fail, return `ok: false` with the full history so the caller can fall back.
 *
 * The repair prompt is intentionally specific: it names the exact validation error ("unknown parameter key
 * 'sweep_depth'", "value 'high' is not a number", "changes object is empty"). This is what makes repair
 * effective — the LLM can fix a specific error, not guess at what went wrong.
 *
 * The loop is *only* invoked when an LLM client is configured. The deterministic fallback proposer is the
 * caller's responsibility (ResearchAgent.propose) when the loop returns ok=false.
 */

import type { AdvisorClient } from '../ollama/advisor.js';
import type { Hypothesis, ResearchDiagnostics } from './ResearchAgent.js';
import { renderDiagnostics } from './ResearchAgent.js';

/** A single attempt in the repair history. */
export interface RepairAttempt {
  /** 0 = the original output; 1..N = retry attempts. */
  attempt: number;
  /** The raw LLM output for this attempt. */
  raw: string;
  /** The validation errors for this attempt (empty if the attempt succeeded). */
  errors: string[];
}

/** The result of a repair loop run. */
export interface RepairResult {
  /** True if any attempt (0..maxRetries) produced valid hypotheses. */
  ok: boolean;
  /** The number of retries that were attempted (0 = original succeeded). */
  attempts: number;
  /** The valid hypotheses from the successful attempt (empty when ok=false). */
  hypotheses: Hypothesis[];
  /** Every attempt's raw output + errors, for audit. */
  history: RepairAttempt[];
}

/** Default max retries — mirrors agent-tui's supervisorConfig.escalation.maxRetries. */
export const DEFAULT_MAX_REPAIR_RETRIES = 2;

/**
 * Validate a single LLM output. Returns the parsed hypotheses (possibly empty) and a list of human-readable
 * validation errors. The errors are *specific* so the repair prompt can name them: "unknown parameter key X",
 * "value Y is not a number", "changes object is empty", "response is not a JSON array".
 *
 * This is the same logic as `parseHypotheses` in ResearchAgent.ts, but it also returns the errors so the
 * repair loop can feed them back to the LLM.
 */
export function validateHypothesisOutput(raw: string): { hypotheses: Hypothesis[]; errors: string[] } {
  let json: unknown;
  try {
    const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    json = JSON.parse(trimmed);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { hypotheses: [], errors: [`response is not valid JSON: ${msg.slice(0, 100)}`] };
  }
  if (!Array.isArray(json)) {
    return { hypotheses: [], errors: [`response is not a JSON array (got ${typeof json})`] };
  }
  if (json.length === 0) {
    return { hypotheses: [], errors: ['response is an empty array — propose at least one hypothesis'] };
  }

  const allowed = ['minimumRewardRisk', 'maxSweepAgeCandles', 'minBreakDistanceAtr', 'stopBufferAtr', 'minStopAtr', 'maxStopAtr', 'minSweepDepthAtr', 'minSweepDisplacementAtr'];
  const out: Hypothesis[] = [];
  const errors: string[] = [];

  for (let i = 0; i < json.length; i += 1) {
    const item = json[i] as Record<string, unknown>;
    if (item === null || typeof item !== 'object') {
      errors.push(`hypothesis[${i}] is not an object`);
      continue;
    }
    if (typeof item.observation !== 'string') {
      errors.push(`hypothesis[${i}].observation is missing or not a string`);
      continue;
    }
    if (typeof item.proposal !== 'string') {
      errors.push(`hypothesis[${i}].proposal is missing or not a string`);
      continue;
    }
    if (item.changes === null || typeof item.changes !== 'object') {
      errors.push(`hypothesis[${i}].changes is missing or not an object`);
      continue;
    }

    const changes: Partial<Record<string, number>> = {};
    let valid = true;
    for (const [k, v] of Object.entries(item.changes as Record<string, unknown>)) {
      if (!allowed.includes(k)) {
        errors.push(`hypothesis[${i}].changes has unknown parameter key "${k}"; allowed: ${allowed.join(', ')}`);
        valid = false;
        continue;
      }
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        errors.push(`hypothesis[${i}].changes.${k} is not a finite number (got ${typeof v}: ${String(v).slice(0, 30)})`);
        valid = false;
        continue;
      }
      changes[k] = v;
    }
    if (!valid) continue;
    if (Object.keys(changes).length === 0) {
      errors.push(`hypothesis[${i}].changes is empty — include at least one parameter`);
      continue;
    }

    out.push({
      id: `h-${Date.now()}-${i}`,
      observation: item.observation,
      proposal: item.proposal,
      changes: changes as never,
      motivatedBy: [],
      source: 'llm',
    });
  }

  return { hypotheses: out, errors };
}

/**
 * Build the repair prompt. Includes the original diagnostics, the previous (invalid) output, and the
 * specific validation errors. The LLM is told to output ONLY a JSON array matching the schema.
 */
export function buildRepairPrompt(
  diagnostics: ResearchDiagnostics,
  previousRaw: string,
  errors: string[],
): string {
  return [
    `Your previous response was INVALID. Repair it.`,
    ``,
    `## Original diagnostics`,
    renderDiagnostics(diagnostics),
    ``,
    `## Your previous (invalid) response`,
    '```',
    previousRaw.slice(0, 2000),
    '```',
    ``,
    `## Validation errors`,
    ...errors.map((e) => `- ${e}`),
    ``,
    `## Output format (read carefully)`,
    `Return ONLY a JSON array. Each element MUST have:`,
    `  - observation: string (one sentence)`,
    `  - proposal: string (one sentence)`,
    `  - changes: object with one or more of these keys, each mapped to a finite number:`,
    `      "minimumRewardRisk", "maxSweepAgeCandles", "minBreakDistanceAtr", "stopBufferAtr",`,
    `      "minStopAtr", "maxStopAtr", "minSweepDepthAtr", "minSweepDisplacementAtr"`,
    ``,
    `No markdown fences, no commentary, no trailing text. Just the JSON array.`,
  ].join('\n');
}

/**
 * The repair loop. Wraps an LLM client and re-prompts on validation failure.
 *
 * Usage:
 *   const result = await repairLoop.run({ diagnostics, originalRawOutput, client, model });
 *   if (result.ok) return result.hypotheses;
 *   else return fallbackHypotheses(diagnostics);  // caller's responsibility
 */
export class HypothesisRepairLoop {
  constructor(
    private readonly client: AdvisorClient,
    private readonly model: string,
    private readonly maxRetries: number = DEFAULT_MAX_REPAIR_RETRIES,
  ) {}

  async run(params: {
    diagnostics: ResearchDiagnostics;
    originalRawOutput: string;
  }): Promise<RepairResult> {
    const history: RepairAttempt[] = [];

    // Attempt 0: validate the original output.
    let validation = validateHypothesisOutput(params.originalRawOutput);
    history.push({ attempt: 0, raw: params.originalRawOutput, errors: validation.errors });

    if (validation.hypotheses.length > 0) {
      return { ok: true, attempts: 0, hypotheses: validation.hypotheses, history };
    }

    // Retries 1..maxRetries
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      const repairPrompt = buildRepairPrompt(params.diagnostics, params.originalRawOutput, validation.errors);
      let raw: string;
      try {
        const response = await this.client.generateText({ model: this.model, prompt: repairPrompt });
        raw = typeof response === 'string' ? response : String(response);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        history.push({ attempt, raw: '', errors: [`LLM call failed: ${msg.slice(0, 100)}`] });
        // Network errors are not repairable by retrying the same prompt — bail out.
        return { ok: false, attempts: attempt, hypotheses: [], history };
      }

      validation = validateHypothesisOutput(raw);
      history.push({ attempt, raw, errors: validation.errors });

      if (validation.hypotheses.length > 0) {
        return { ok: true, attempts: attempt, hypotheses: validation.hypotheses, history };
      }
    }

    return { ok: false, attempts: this.maxRetries, hypotheses: [], history };
  }
}
