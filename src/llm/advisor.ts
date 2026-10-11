import type { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { z } from 'zod';

/**
 * The advisor is a veto, never an originator. It receives a snapshot of a
 * deterministic entry candidate and may answer SKIP; it cannot create a trade,
 * change size or levels, or override a risk violation.
 */
export const ADVISORY_SCHEMA = z.object({
  decision: z.enum(['ENTER', 'SKIP']),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(240),
});

export type AdvisoryDecision = z.infer<typeof ADVISORY_SCHEMA>;

export interface AdvisoryVerdict extends AdvisoryDecision {
  readonly source: 'llm' | 'fail_closed';
}

export interface EntrySnapshot {
  readonly underlying: string;
  readonly direction: 'BULLISH' | 'BEARISH';
  readonly optionSymbol: string;
  readonly strike: number;
  readonly expiry: string;
  readonly daysToExpiry: number;
  readonly minuteOfDayIst: number;
  readonly spot: number;
  readonly entryReference: number;
  readonly stopLossPrice: number;
  readonly targetPrice: number;
  readonly spreadPct: number;
  readonly openInterest: number;
  readonly lots: number;
  readonly riskInr: number;
  readonly signalReasons: readonly string[];
}

export interface TradeAdvisor {
  review(snapshot: EntrySnapshot): Promise<AdvisoryVerdict>;
}

const SYSTEM_PROMPT = [
  'You review one proposed NSE index option BUY (long premium only).',
  'Decide ENTER only if nothing in the snapshot contradicts the signal: stretched spot away from the breakout level, a wide or thin contract, or an expiry too close for the holding horizon.',
  'Otherwise answer SKIP. Never suggest a different strike, size, stop or target.',
  'Reply with JSON only: {"decision":"ENTER"|"SKIP","confidence":0..1,"reason":"<max 25 words>"}.',
].join(' ');

export function describeAdvisorError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 200);
  }
  return String(error).slice(0, 200);
}

/** The slice of the Ollama SDK client this advisor depends on; injectable so tests never open a socket. */
export type AdvisorChatClient = Pick<OllamaClient, 'chatWithSchema'>;

export class OllamaTradeAdvisor implements TradeAdvisor {
  constructor(
    private readonly client: AdvisorChatClient,
    private readonly model: string,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Any failure (timeout, network, auth, malformed or schema-invalid output)
   * resolves to SKIP. An entry proceeds only on an explicit ENTER from a valid reply.
   */
  async review(snapshot: EntrySnapshot): Promise<AdvisoryVerdict> {
    try {
      const decision = await this.client.chatWithSchema(
        {
          model: this.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(snapshot) },
          ],
          options: { temperature: 0 },
          timeoutMs: this.timeoutMs,
        },
        ADVISORY_SCHEMA,
      );
      const checked = ADVISORY_SCHEMA.safeParse(decision);
      if (!checked.success) {
        return {
          decision: 'SKIP',
          confidence: 1,
          reason: 'advisor reply failed schema validation',
          source: 'fail_closed',
        };
      }
      return { ...checked.data, source: 'llm' };
    } catch (error) {
      return {
        decision: 'SKIP',
        confidence: 1,
        reason: `advisor unavailable: ${describeAdvisorError(error)}`,
        source: 'fail_closed',
      };
    }
  }
}
