import { z } from 'zod';
import { describeAdvisorError, type AdvisoryVerdict, type AdvisorOptions, type EntrySnapshot, type TradeAdvisor } from './advisor.js';
import { backoffDelayMs, cappedRetryAfterMs, delay } from './retry.js';

/**
 * Trade advisor backed by an Ollama decision model (System One, `POST /v1/systemone`).
 *
 * The chat advisor spends a generative model on a one-word answer and then has to
 * parse it. A decision model scores the question instead: it returns the probability
 * that the entry may proceed (`noul`) from one pass that generates no tokens, so
 * there is no JSON to validate and no thinking trace to wait for. The contract is
 * the same as the chat advisor's: veto only, and any failure resolves to SKIP.
 *
 * The SDK's `systemOne()` is not used. The pinned 1.13 SDK marks the operation
 * local-only and throws before sending when the host is https://ollama.com, and the
 * endpoint is small enough to call directly.
 */

const DEFAULT_ENTER_THRESHOLD = 0.5;

/** Statuses worth another attempt. 400, 401, 402, 404 and 413 are the server's final answer, so they fail closed at once. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/**
 * One typed question. `noul` is the probability that the answer is true, so the
 * verdict is the same ENTER-or-SKIP the chat advisor gives, read from one number.
 * Snapshot fields are named in backticks so the model reads them instead of guessing.
 */
export const DECISION_QUESTIONS = {
  proceed: {
    type: 'noul',
    instructions:
      'Review one proposed NSE index option BUY (long premium only), given by this state. Should the entry proceed?' +
      ' It should unless the snapshot contradicts the signal in `signalReasons`: `spot` stretched away from the breakout level,' +
      ' a wide contract (`spreadPct`), a thin contract (`openInterest`), or an expiry (`daysToExpiry`) too close for the holding horizon.',
    criteria: {
      true: 'Nothing in the snapshot contradicts the entry signal, so the entry may proceed.',
      false: 'The snapshot contradicts the entry: stretched spot, a wide or thin contract, or an expiry too close for the holding horizon.',
    },
  },
} as const;

const NOUL_ANSWER = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) });
/** Only the answer is required; `usage` is reported when the server sends it. */
const REPLY = z.object({
  answers: z.object({ proceed: NOUL_ANSWER }),
  usage: z.object({ input_tokens: z.number().int().nonnegative() }).optional(),
});

/** A refused or unreadable /v1/systemone reply. Transient ones are retried; the rest fail closed at once. */
export class DecisionModelError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    /** Wait the server asked for on a 429, ms. */
    readonly retryAfterMs: number | undefined = undefined,
  ) {
    super(message);
    this.name = 'DecisionModelError';
  }
}

export interface DecisionAdvisorOptions extends AdvisorOptions {
  /** Ollama host, local daemon or https://ollama.com. */
  readonly host: string;
  /** Ollama Cloud API key, sent as a bearer header and never logged. Undefined on a local daemon. */
  readonly apiKey: string | undefined;
  /** Minimum P(enter) for an ENTER verdict. Default 0.5: the verdict follows the more likely side. */
  readonly enterThreshold?: number;
  readonly fetch?: typeof fetch;
}

interface Scored {
  readonly probabilityOfEnter: number;
  readonly inputTokens: number | undefined;
}

/** Retry-After is delay seconds or an HTTP date; undefined when absent, unparsable or already past. */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) {
    return undefined;
  }
  const seconds = Number(header);
  if (header.trim() !== '' && Number.isFinite(seconds)) {
    return cappedRetryAfterMs(seconds * 1_000);
  }
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : cappedRetryAfterMs(at - Date.now());
}

/** The server's own words when it sent any, for example 402's "Add usage credits or upgrade". */
async function describeFailure(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  let detail = text.slice(0, 160);
  try {
    const error: unknown = (JSON.parse(text) as { error?: unknown }).error;
    if (typeof error === 'string' && error !== '') {
      detail = error.slice(0, 160);
    }
  } catch {
    // Not JSON: the raw text is the best explanation there is.
  }
  return detail === '' ? `HTTP ${response.status}` : `HTTP ${response.status}: ${detail}`;
}

export class OllamaDecisionAdvisor implements TradeAdvisor {
  private readonly url: string;
  private readonly fetch: typeof fetch;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly keepAlive: string | false;
  private readonly enterThreshold: number;

  constructor(
    private readonly model: string,
    private readonly timeoutMs: number,
    private readonly options: DecisionAdvisorOptions,
  ) {
    this.url = `${options.host.replace(/\/+$/, '')}/v1/systemone`;
    this.fetch = options.fetch ?? fetch;
    this.maxAttempts = options.maxAttempts ?? 1;
    this.backoffMs = options.backoffMs ?? 250;
    this.keepAlive = options.keepAlive ?? '30m';
    this.enterThreshold = options.enterThreshold ?? DEFAULT_ENTER_THRESHOLD;
  }

  /** Any failure (timeout, network, auth, billing, malformed reply) resolves to SKIP, as for the chat advisor. */
  async review(snapshot: EntrySnapshot): Promise<AdvisoryVerdict> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return this.toVerdict(await this.score(snapshot));
      } catch (error) {
        if (attempt >= this.maxAttempts || !(error instanceof DecisionModelError) || !error.transient) {
          return {
            decision: 'SKIP',
            confidence: 1,
            reason: `advisor unavailable: ${describeAdvisorError(error)}`,
            source: 'fail_closed',
          };
        }
        await delay(error.retryAfterMs ?? backoffDelayMs(attempt, this.backoffMs));
      }
    }
  }

  private toVerdict(scored: Scored): AdvisoryVerdict {
    const { probabilityOfEnter, inputTokens } = scored;
    const usage = inputTokens === undefined ? '' : ` (${inputTokens} input tokens)`;
    if (probabilityOfEnter >= this.enterThreshold) {
      return {
        decision: 'ENTER',
        confidence: probabilityOfEnter,
        reason: `decision model ${this.model}: P(enter)=${probabilityOfEnter.toFixed(2)}, at or above ${this.enterThreshold}${usage}`,
        source: 'decision',
      };
    }
    return {
      decision: 'SKIP',
      // Confidence belongs to the verdict, so a SKIP carries the probability the model did not give to ENTER.
      confidence: Math.round((1 - probabilityOfEnter) * 10_000) / 10_000,
      reason: `decision model ${this.model}: P(enter)=${probabilityOfEnter.toFixed(2)}, below ${this.enterThreshold}${usage}`,
      source: 'decision',
    };
  }

  private async score(snapshot: EntrySnapshot): Promise<Scored> {
    const response = await this.post(snapshot);
    if (!response.ok) {
      const transient = TRANSIENT_STATUSES.has(response.status);
      throw new DecisionModelError(
        await describeFailure(response),
        transient,
        transient ? parseRetryAfterMs(response.headers.get('retry-after')) : undefined,
      );
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new DecisionModelError(`reply is not JSON: ${text.slice(0, 80)}`, false);
    }
    const reply = REPLY.safeParse(body);
    if (!reply.success) {
      throw new DecisionModelError(`reply has no noul answer for the proceed question: ${text.slice(0, 120)}`, false);
    }
    return {
      probabilityOfEnter: reply.data.answers.proceed.noul,
      inputTokens: reply.data.usage?.input_tokens,
    };
  }

  private async post(snapshot: EntrySnapshot): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.apiKey !== undefined) {
      headers.authorization = `Bearer ${this.options.apiKey}`;
    }
    try {
      return await this.fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          state: snapshot,
          questions: DECISION_QUESTIONS,
          // keep_alive only pins a model in local VRAM; the cloud host is serverless, so it is omitted there.
          ...(this.keepAlive === false ? {} : { keep_alive: this.keepAlive }),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // A timeout has already spent the whole budget, so it is not retried. A refused connection is instant
      // and worth another attempt, like OllamaNetworkError in the chat advisor.
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new DecisionModelError(describeAdvisorError(error), error instanceof TypeError && !timedOut);
    }
  }
}
