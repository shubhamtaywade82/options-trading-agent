import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { config } from '../config.js';
import { jsonFormatFor, parseJsonLoose } from './jsonMode.js';
import type { Position, LogEntry, VetoSnapshot } from '../types.js';

export interface VetoVerdict {
  verdict: 'PROCEED' | 'VETO';
  reason: string;
}

const VETO_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 60_000;

/** The slice of `OllamaClient` the advisor uses; injectable so tests never open a socket. */
export interface AdvisorClient {
  listModels(): Promise<unknown>;
  generateText(request: { model: string; prompt: string; format?: 'json' }): Promise<string>;
}

type GenerateRequest = Parameters<AdvisorClient['generateText']>[0];

/** One client per API key; the pool (round-robin + failover) lives in the advisor, so the SDK must not retry or time out on its own. */
const clientFor = (credential?: { apiKey: string }): AdvisorClient =>
  new OllamaClient({ baseUrl: config.ollama.host, timeoutMs: VETO_TIMEOUT_MS, retries: 0, ...credential });

/**
 * LLM layer via Ollama.
 * advise/ask enrich logs only. veto() may block an entry the deterministic agents proposed.
 *
 * Fail-open policy (intentional and bounded):
 *   - Ollama offline (no process, host unreachable): PROCEED — deterministic
 *     code owns the entry decision, the veto is a belt-and-braces check.
 *   - Ollama online but returned a malformed/unparseable reply: VETO with
 *     reason 'advisor sent an unparseable reply'. Issue #6: previously this
 *     was fail-open (PROCEED), which let an entry through when the safety
 *     layer had failed in a way the operator should investigate. If the
 *     model says something unparseable, the safest action is to refuse until
 *     an operator sees the log and re-runs with a healthier Ollama.
 *   - Network error mid-request (timeout, connection reset): PROCEED with
 *     reason 'advisor error: <message>'. Same as offline — the broker
 *     didn't say no, deterministic code owns the entry.
 */
export function parseVerdict(text: string): VetoVerdict {
  try {
    const parsed = parseJsonLoose(text) as { verdict?: unknown; reason?: unknown };
    const reason = String(parsed.reason ?? '');
    if (parsed.verdict === 'VETO') return { verdict: 'VETO', reason };
    if (parsed.verdict === 'PROCEED') return { verdict: 'PROCEED', reason };
    // Unknown verdict string — model said something, but not what we asked.
    // Fail-closed: refuse until the operator checks Ollama.
    return { verdict: 'VETO', reason: `advisor sent an unknown verdict "${parsed.verdict}"` };
  } catch {
    // Unparseable reply — fail-closed for the same reason.
    return { verdict: 'VETO', reason: 'advisor sent an unparseable reply' };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * LLM layer via Ollama.
 * advise/ask enrich logs only. veto() may block an entry the deterministic agents proposed,
 * but can never originate one; when Ollama is offline, slow or malformed, the entry proceeds.
 */
export class OllamaAdvisor {
  private available = false;
  private lastPingAt = 0;
  private clients: AdvisorClient[] = [];
  private keyIndex = 0;

  constructor(clientOverride?: AdvisorClient) {
    if (clientOverride) {
      this.clients = [clientOverride];
    } else if (config.ollama.apiKeys.length > 0) {
      this.clients = config.ollama.apiKeys.map((apiKey) => clientFor({ apiKey }));
    } else {
      this.clients = [clientFor()];
    }
    this.ping();
  }

  get isOnline(): boolean {
    return this.available;
  }

  async generateJson<T>(prompt: string, model = config.ollama.model): Promise<T | null> {
    if (!this.available && Date.now() - this.lastPingAt >= PING_INTERVAL_MS) await this.ping();
    if (!this.available) return null;
    try {
      const text = await this.executeGenerate({ model, prompt, ...jsonFormatFor(config.ollama.host) });
      try {
        return parseJsonLoose(text) as T;
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  }

  private async executeGenerate(request: GenerateRequest): Promise<string> {
    let lastErr: Error | null = null;
    const count = this.clients.length;
    for (let attempt = 0; attempt < count; attempt++) {
      const idx = (this.keyIndex + attempt) % count;
      try {
        const res = await withTimeout(this.clients[idx].generateText(request), VETO_TIMEOUT_MS);
        this.keyIndex = (idx + 1) % count;
        return res;
      } catch (err: any) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error('All Ollama clients failed');
  }

  private async ping(): Promise<void> {
    this.lastPingAt = Date.now();
    for (const client of this.clients) {
      try {
        await withTimeout(client.listModels(), VETO_TIMEOUT_MS);
        this.available = true;
        return;
      } catch {
        // try next key if one is unreachable or rate limited
      }
    }
    this.available = false;
  }

  async veto(snapshot: VetoSnapshot): Promise<VetoVerdict> {
    // Ollama often starts after the bot; without a re-ping the veto stays disabled until restart.
    if (!this.available && Date.now() - this.lastPingAt >= PING_INTERVAL_MS) await this.ping();
    if (!this.available) return { verdict: 'PROCEED', reason: 'advisor offline' };
    const prompt = `You review a proposed crypto futures entry. Snapshot: ${JSON.stringify(snapshot)}. ` +
      'Reply with JSON only: {"verdict":"PROCEED"|"VETO","reason":"<max 15 words>"}. ' +
      'VETO only for a concrete reason such as an overextended entry or crowded funding.';
    try {
      const text = await this.executeGenerate({ model: config.ollama.model, prompt, ...jsonFormatFor(config.ollama.host) });
      return parseVerdict(text);
    } catch (err) {
      return { verdict: 'PROCEED', reason: `advisor error: ${(err as Error).message}` };
    }
  }

  async advise(positions: Position[], signals: string[]): Promise<LogEntry | null> {
    if (!this.available) return null;
    try {
      const prompt = `You are a crypto futures risk analyst. Portfolio: ${JSON.stringify(positions.slice(0, 3))}. Recent signals: ${signals.slice(-5).join('; ')}. Provide ONE sentence risk assessment, max 20 words.`;
      const text = await this.executeGenerate({ model: config.ollama.model, prompt });
      return {
        ts: Date.now(),
        agent: 'SYSTEM',
        msg: `OLLAMA-ADVISOR: ${text.trim().slice(0, 120)}`,
        level: 'info',
      };
    } catch {
      return null;
    }
  }

  async ask(question: string, context?: { positions: Position[]; equity: number }): Promise<LogEntry> {
    if (!this.available) {
      return this.localAssessment(question, context);
    }
    try {
      const portfolioBrief = context
        ? `Equity: $${context.equity.toFixed(2)}, Positions: ${context.positions.length}`
        : 'Portfolio: active';
      const prompt = `You are an institutional crypto risk advisor. Context: ${portfolioBrief}. Question: ${question}. Answer concisely in at most 25 words.`;
      const text = await this.executeGenerate({ model: config.ollama.model, prompt });
      return {
        ts: Date.now(),
        agent: 'SYSTEM',
        msg: `ADVISOR-AUDIT: ${text.trim().slice(0, 120)}`,
        level: 'info',
      };
    } catch {
      return this.localAssessment(question, context);
    }
  }

  private localAssessment(question: string, context?: { positions: Position[]; equity: number }): LogEntry {
    const posCount = context?.positions.length ?? 0;
    const upnl = context?.positions.reduce((sum, p) => sum + p.upnl, 0) ?? 0;
    return {
      ts: Date.now(),
      agent: 'SYSTEM',
      msg: `LOCAL-AUDIT: [${question}] ${posCount} pos open, net uPnL $${upnl.toFixed(1)}. Margin safe, SLs active.`,
      level: 'info',
    };
  }
}
