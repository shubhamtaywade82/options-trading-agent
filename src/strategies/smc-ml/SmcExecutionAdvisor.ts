import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { jsonFormatFor, parseJsonLoose } from '../../ollama/jsonMode.js';
import {
  type ExecutionCandidate,
  type SMCDecisionContext,
  type SMCEntrySource,
  type SMCTradeDecision,
} from './types.js';

export interface SmcExecutionAdvisorOptions {
  host: string;
  model: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to an SDK client on `host` with the SDK's own retry and timeout disabled (the advisor is fail-closed and bounded here). */
  client?: Pick<OllamaClient, 'generateText'>;
}

const TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SMC advisor timeout')), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export class SmcExecutionAdvisor {
  private readonly client: Pick<OllamaClient, 'generateText'>;
  private readonly timeoutMs: number;
  private readonly model: string;
  private readonly host: string;

  constructor(options: SmcExecutionAdvisorOptions) {
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.client = options.client ?? new OllamaClient({ baseUrl: options.host, timeoutMs: this.timeoutMs, retries: 0 });
    this.model = options.model;
    this.host = options.host;
  }

  async decide(context: SMCDecisionContext): Promise<SMCTradeDecision> {
    const prompt = this.buildPrompt(context);
    try {
      const result = await withTimeout(
        this.client.generateText({ model: this.model, prompt, ...jsonFormatFor(this.host) }),
        this.timeoutMs,
      );
      return validateDecision(parseJsonLoose(result), context);
    } catch (error) {
      return {
        action: 'HOLD',
        side: 'NONE',
        entrySource: null,
        reason: 'LLM unavailable or invalid; autonomous execution is fail-closed.',
      };
    }
  }

  private buildPrompt(context: SMCDecisionContext): string {
    const candidates = buildCandidateTable(context.analysis.candidates);
    return [
      'You are the final decision gate for a deterministic crypto SMC engine.',
      'You DO NOT calculate indicators, fetch market data, invent prices, size positions, set leverage, or create new levels.',
      'Use only the supplied facts.',
      '',
      'Allowed state transitions:',
      'NO_POSITION -> OPEN or HOLD.',
      'LONG position + LONG confluence -> ADD or HOLD.',
      'SHORT position + SHORT confluence -> ADD or HOLD.',
      'LONG position + SHORT confluence -> EXIT or HOLD.',
      'SHORT position + LONG confluence -> EXIT or HOLD.',
      'An opposite position is never reversed in this decision. EXIT first.',
      '',
      'OPEN/ADD may choose only an entrySource that exists in candidates.',
      'Do not return numeric entry, stop, target, size, or leverage fields.',
      'When evidence is conflicting or the setup is stale, choose HOLD.',
      '',
      'PORTFOLIO STATE:',
      JSON.stringify({
        portfolioState: context.portfolioState,
        positionQty: context.positionQty,
        currentEntry: context.currentEntry ?? null,
        currentMark: context.currentMark,
      }),
      '',
      'CONFLUENCE:',
      JSON.stringify(context.analysis.confluence),
      '',
      'CANDIDATES:',
      candidates,
      '',
      'Return JSON only:',
      '{"action":"OPEN|ADD|EXIT|HOLD","side":"LONG|SHORT|NONE","entrySource":"MARKET|BREAK_CLOSE|RETEST_LEVEL|null","reason":"max 30 words"}',
    ].join('\n');
  }
}

function buildCandidateTable(candidates: ExecutionCandidate[]): string {
  return JSON.stringify(
    candidates.map((c) => ({
      direction: c.direction,
      entrySource: c.entrySource,
      entryPrice: c.entryPrice,
      stopLoss: c.stopLoss,
      tp1: c.tp1,
      tp2: c.tp2,
      riskPerUnit: c.riskPerUnit,
      riskAtr: c.riskAtr,
      sourceBreak: c.sourceBreak,
    })),
  );
}

export function validateDecision(raw: unknown, context: SMCDecisionContext): SMCTradeDecision {
  if (!raw || typeof raw !== 'object') throw new Error('invalid decision');

  const obj = raw as Record<string, unknown>;
  const action = obj.action;
  const side = obj.side;
  const entrySource = obj.entrySource;

  const validActions = new Set(['OPEN', 'ADD', 'EXIT', 'HOLD']);
  const validSides = new Set(['LONG', 'SHORT', 'NONE']);
  const validSources = new Set<SMCEntrySource>(['MARKET', 'BREAK_CLOSE', 'RETEST_LEVEL']);

  if (!validActions.has(String(action)) || !validSides.has(String(side))) {
    throw new Error('invalid decision enum');
  }

  const source: SMCEntrySource | null =
    entrySource === null || entrySource === undefined
      ? null
      : validSources.has(String(entrySource) as SMCEntrySource)
        ? String(entrySource) as SMCEntrySource
        : null;

  const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 200) : 'no reason supplied';
  const normalized: SMCTradeDecision = {
    action: action as SMCTradeDecision['action'],
    side: side as SMCTradeDecision['side'],
    entrySource: source,
    reason,
  };

  const confluenceDirection = context.analysis.confluence.direction;
  const hasCandidate = (requestedSide: 'LONG' | 'SHORT', requestedSource: SMCEntrySource) =>
    context.analysis.candidates.some(
      (candidate) => candidate.direction === requestedSide && candidate.entrySource === requestedSource,
    );

  if (normalized.action === 'HOLD') {
    return { action: 'HOLD', side: 'NONE', entrySource: null, reason };
  }

  if (context.portfolioState === 'NO_POSITION') {
    if (normalized.action !== 'OPEN') return { action: 'HOLD', side: 'NONE', entrySource: null, reason };
    if (
      confluenceDirection === 'NEUTRAL' ||
      context.analysis.confluence.noTradeReasons.length > 0 ||
      normalized.side !== confluenceDirection ||
      !source ||
      !hasCandidate(normalized.side, source)
    ) {
      return {
        action: 'HOLD',
        side: 'NONE',
        entrySource: null,
        reason: 'validator rejected OPEN: no admissible confluence candidate',
      };
    }
    return normalized;
  }

  const currentSide = context.portfolioState;
  if (normalized.action === 'EXIT') {
    if (normalized.side !== currentSide) {
      return { action: 'EXIT', side: currentSide, entrySource: null, reason };
    }
    return { action: 'EXIT', side: currentSide, entrySource: null, reason };
  }

  if (normalized.action !== 'ADD') {
    return { action: 'HOLD', side: 'NONE', entrySource: null, reason };
  }

  if (
    confluenceDirection !== currentSide ||
    context.analysis.confluence.noTradeReasons.length > 0 ||
    normalized.side !== currentSide ||
    !source ||
    !hasCandidate(normalized.side, source)
  ) {
    return { action: 'HOLD', side: 'NONE', entrySource: null, reason: 'validator rejected ADD: confluence does not match open position' };
  }

  return normalized;
}
