import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentId } from '../types.js';
import type { PersonaId, Stance } from '../llm/types.js';

export interface AgentStats {
  trades: number;
  wins: number;
  totalR: number;
}

export interface TradeObservation {
  actorId: string;
  symbol?: string;
  win: boolean;
  rMultiple: number;
  at: number;
}

export interface PredictionRecord {
  id: string;
  actorId: PersonaId;
  symbol: string;
  stance: Stance;
  probability: number;
  mark: number;
  thresholdPct: number;
  horizonMinutes: number;
  createdAt: number;
  resolvedAt?: number;
  correct?: boolean;
  realizedReturnPct?: number;
  brierScore?: number;
}

export interface AgentLedgerData {
  version: 2;
  agents: Partial<Record<AgentId | string, AgentStats>>;
  tradeHistory: TradeObservation[];
  processedTradeKeys: string[];
  predictions: PredictionRecord[];
}

export interface PersonaStats {
  actorId: PersonaId;
  symbol: string;
  resolved: number;
  correct: number;
  accuracy: number | null;
  brierScore: number | null;
}

const EMPTY: AgentStats = { trades: 0, wins: 0, totalR: 0 };
const MAX_HISTORY = 50;
const MAX_TRADE_HISTORY = 2_000;
const MAX_PROCESSED_KEYS = 2_000;
const MAX_PREDICTIONS = 5_000;

/** Per-agent trade outcomes and LLM forecast memory. Persists to disk across restarts; `null` path = in-memory only. */
export class AgentLedger {
  private data: AgentLedgerData = emptyData();

  /** A real path persists to disk; `null` keeps the ledger purely in memory (replay, tests). */
  constructor(private readonly path: string | null) {
    this.load();
  }

  get(id: AgentId | string): AgentStats {
    const history = this.data.tradeHistory.filter((row) => row.actorId === id).slice(-MAX_HISTORY);
    if (history.length) return statsFromTrades(history);
    return { ...(this.data.agents[id] ?? EMPTY) };
  }

  record(id: AgentId | string, win: boolean, rMultiple: number, context?: { symbol?: string; at?: number }): void {
    const observation: TradeObservation = {
      actorId: id,
      symbol: context?.symbol,
      win,
      rMultiple: Number.isFinite(rMultiple) ? rMultiple : 0,
      at: context?.at ?? Date.now(),
    };
    this.data.tradeHistory.push(observation);
    this.data.tradeHistory = this.data.tradeHistory.slice(-MAX_TRADE_HISTORY);
    this.data.agents[id] = statsFromTrades(
      this.data.tradeHistory.filter((row) => row.actorId === id).slice(-MAX_HISTORY),
    );
    this.save();
  }

  winRate(id: AgentId | string): number | null {
    const stats = this.get(id);
    return stats.trades < 3 ? null : stats.wins / stats.trades;
  }

  avgR(id: AgentId | string): number | null {
    const stats = this.get(id);
    return stats.trades < 3 ? null : stats.totalR / stats.trades;
  }

  tradeStats(id: AgentId | string, symbol: string): AgentStats {
    const rows = this.data.tradeHistory
      .filter((row) => row.actorId === id && row.symbol === symbol)
      .slice(-MAX_HISTORY);
    return rows.length ? statsFromTrades(rows) : { ...EMPTY };
  }

  hasProcessedTrade(key: string): boolean {
    return this.data.processedTradeKeys.includes(key);
  }

  markProcessedTrade(key: string): void {
    if (this.hasProcessedTrade(key)) return;
    this.data.processedTradeKeys = [...this.data.processedTradeKeys, key].slice(-MAX_PROCESSED_KEYS);
    this.save();
  }

  recordPrediction(prediction: PredictionRecord): void {
    if (this.data.predictions.some((row) => row.id === prediction.id)) return;
    this.data.predictions = [...this.data.predictions, prediction].slice(-MAX_PREDICTIONS);
    this.save();
  }

  personaMemory(actorId: PersonaId, symbol: string): PersonaStats {
    const rows = this.data.predictions.filter(
      (row) => row.actorId === actorId && row.symbol === symbol && row.resolvedAt !== undefined,
    );
    const resolved = rows.length;
    const correct = rows.filter((row) => row.correct === true).length;
    const brierValues = rows.map((row) => row.brierScore).filter((v): v is number => v !== undefined);
    return {
      actorId,
      symbol,
      resolved,
      correct,
      accuracy: resolved ? correct / resolved : null,
      brierScore: brierValues.length
        ? brierValues.reduce((sum, value) => sum + value, 0) / brierValues.length
        : null,
    };
  }

  resolvePredictions(marks: Record<string, number>, now = Date.now()): PredictionRecord[] {
    const resolved: PredictionRecord[] = [];
    let changed = false;
    this.data.predictions = this.data.predictions.map((prediction) => {
      if (prediction.resolvedAt !== undefined || now < prediction.createdAt + prediction.horizonMinutes * 60_000) {
        return prediction;
      }
      const current = marks[prediction.symbol];
      if (!(prediction.mark > 0) || !(current > 0)) return prediction;
      const realizedReturnPct = ((current / prediction.mark) - 1) * 100;
      const moveThresholdPct = prediction.thresholdPct * 100;
      const movedEnough = Math.abs(realizedReturnPct) >= moveThresholdPct;
      const directionalMove = prediction.stance === 'LONG' ? realizedReturnPct > 0 : realizedReturnPct < 0;
      const correct = prediction.stance === 'NEUTRAL' ? !movedEnough : movedEnough && directionalMove;
      const brierScore = (prediction.probability - (correct ? 1 : 0)) ** 2;
      const result = { ...prediction, resolvedAt: now, correct, realizedReturnPct, brierScore };
      resolved.push(result);
      changed = true;
      return result;
    });
    if (changed) this.save();
    return resolved;
  }

  private load(): void {
    if (this.path === null) return;
    try {
      this.data = normalize(JSON.parse(readFileSync(this.path, 'utf-8')));
    } catch {
      this.data = emptyData();
    }
  }

  private save(): void {
    if (this.path === null) return; // in-memory ledger: nothing to persist
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.data, null, 2));
    } catch {
      // Learning is best-effort and must never block trading.
    }
  }
}

function emptyData(): AgentLedgerData {
  return { version: 2, agents: {}, tradeHistory: [], processedTradeKeys: [], predictions: [] };
}

function statsFromTrades(history: TradeObservation[]): AgentStats {
  return {
    trades: history.length,
    wins: history.filter((row) => row.win).length,
    totalR: history.reduce((sum, row) => sum + row.rMultiple, 0),
  };
}

function normalize(raw: unknown): AgentLedgerData {
  if (!raw || typeof raw !== 'object') return emptyData();
  const value = raw as Partial<AgentLedgerData>;
  if (value.version === 2 && value.agents && Array.isArray(value.tradeHistory)) {
    return {
      version: 2,
      agents: value.agents,
      tradeHistory: value.tradeHistory,
      processedTradeKeys: Array.isArray(value.processedTradeKeys) ? value.processedTradeKeys : [],
      predictions: Array.isArray(value.predictions) ? value.predictions : [],
    };
  }
  const legacy = raw as Partial<Record<AgentId, AgentStats>>;
  return { ...emptyData(), agents: legacy as Partial<Record<AgentId | string, AgentStats>> };
}
