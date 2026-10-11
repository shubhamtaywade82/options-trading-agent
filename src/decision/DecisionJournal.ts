import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentId, Side, SignalType } from '../types.js';
import type { EvidenceBreakdown } from './types.js';
import type { DecisionContext } from '../market/VolatilityPhase.js';

/** Terminal status of a decision; every candidate follows exactly one of these paths. */
export type DecisionStatus =
  | 'EXECUTED'
  | 'RISK_REJECTED'
  | 'VETOED'
  | 'EQ_REJECTED'
  | 'EXECUTION_REFUSED'
  | 'EXECUTION_FAILED';

/**
 * What the system believed at decision time. `breakdown` is the deterministic
 * rubric (regime/structure/liquidity/location/derivatives/execution) computed
 * from the MarketState; `score` is the composite that actually drove the
 * decision (fusion evidence when the signal went through fusion, otherwise the
 * rubric total, otherwise confidence).
 */
export interface DecisionEvidence {
  breakdown: EvidenceBreakdown | null;
  score: number;
  factors: string[];
}

export interface DecisionRisk {
  approved: boolean;
  size: number;
  leverage: number;
  reason: string;
}

export interface DecisionExecution {
  ts: number;
  spreadBps: number | null;
  slippageBps: number | null;
  effectiveCostBps: number | null;
}

export interface DecisionOutcome {
  closedAt: number;
  exit: number;
  qty: number;
  pnl: number;
  rMultiple: number;
  reason: string;
}

/**
 * The persisted link between a decision and everything that followed it.
 *
 * One record per gated signal: what the market looked like, what the strategy
 * proposed, what risk said, whether execution went out, and (once the position
 * closes) what actually happened. Together with the TradeRecord journal this is
 * the research dataset that answers "which conditions produced profitable
 * decisions?" — the question the learning system was previously guessing at.
 */
export interface DecisionRecord {
  decisionId: string;
  timestamp: number;
  symbol: string;
  strategy: AgentId;
  signalType: SignalType;
  side: Side | null;
  signalId: string;
  confidence: number;
  marketStateTime: number | null;
  marketStateVersion: number | null;
  evidence: DecisionEvidence;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  notionalUsdt: number | null;
  riskDecision: DecisionRisk;
  status: DecisionStatus;
  rejectionReason: string | null;
  /** Regime and volatility phase at decision time; absent on records written before it existed. */
  context?: DecisionContext;
  execution?: DecisionExecution;
  outcome?: DecisionOutcome;
}

/** Compaction bound: the journal is rewritten once it exceeds this many folded records. */
const MAX_RECORDS = 10_000;

function isDecisionRecord(value: unknown): value is DecisionRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.decisionId === 'string'
    && typeof record.timestamp === 'number'
    && typeof record.symbol === 'string'
    && typeof record.status === 'string'
    && record.evidence !== null
    && typeof record.evidence === 'object'
    && typeof record.riskDecision === 'object';
}

/**
 * Append-only JSONL decision journal (data/decisions.jsonl).
 *
 * Lines are full DecisionRecord snapshots; a later line with the same
 * decisionId supersedes earlier ones (last-write-wins), so execution and
 * outcome updates never rewrite history — they append it. Reads fold the file
 * into the latest record per decisionId, and a file that outgrows MAX_RECORDS
 * is compacted to its folded form on the next load. A null path keeps the
 * journal purely in memory (replay).
 */
export class DecisionJournal {
  private records = new Map<string, DecisionRecord>();
  private overflowed = false;

  constructor(private readonly filePath: string | null = path.resolve('data/decisions.jsonl')) {
    this.load();
  }

  /** Appends a record (new decision, or an updated snapshot of an existing one). */
  record(entry: DecisionRecord): void {
    this.records.set(entry.decisionId, entry);
    this.append(entry);
  }

  /** Fills in the execution facts once the order went out. No-op for unknown ids. */
  attachExecution(decisionId: string, execution: DecisionExecution): void {
    const current = this.records.get(decisionId);
    if (!current) return;
    this.record({ ...current, execution });
  }

  /** Fills in the realized outcome once the position closed. No-op for unknown ids. */
  attachOutcome(decisionId: string, outcome: DecisionOutcome): void {
    const current = this.records.get(decisionId);
    if (!current) return;
    this.record({ ...current, outcome });
  }

  get(decisionId: string): DecisionRecord | undefined {
    return this.records.get(decisionId);
  }

  /** All known decisions, oldest first. */
  all(): DecisionRecord[] {
    return [...this.records.values()].sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Decisions that went out and closed — the executable research slice. */
  completed(): DecisionRecord[] {
    return this.all().filter((record) => record.outcome !== undefined);
  }

  private load(): void {
    try {
      if (this.filePath === null || !existsSync(this.filePath)) return;
      const lines = readFileSync(this.filePath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (isDecisionRecord(parsed)) this.records.set(parsed.decisionId, parsed);
        } catch {
          // A torn final line (crash mid-append) is skipped, not fatal
        }
      }
      this.overflowed = this.records.size > MAX_RECORDS;
    } catch {
      // An unreadable journal must never block trading
      this.records = new Map();
    }
  }

  private append(entry: DecisionRecord): void {
    try {
      if (this.filePath === null) return;
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
      if (this.records.size > MAX_RECORDS) this.compact();
    } catch {
      // Best-effort, like every persistence in this codebase: losing a line loses research, not money
    }
  }

  /** Rewrites the file to its folded form so an unbounded journal cannot grow forever. */
  private compact(): void {
    if (this.filePath === null) return;
    const folded = this.all().slice(this.records.size - MAX_RECORDS);
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, folded.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf-8');
      renameSync(tmp, this.filePath);
      this.records = new Map(folded.map((entry) => [entry.decisionId, entry]));
      this.overflowed = false;
    } catch {
      // Compaction failing is non-fatal; it retries once the journal grows again
    }
  }
}
