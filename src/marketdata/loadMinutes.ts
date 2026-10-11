import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { MinuteRecord } from './MinuteAggregator.js';

const isRecord = (v: unknown): v is MinuteRecord => {
  const r = v as Partial<MinuteRecord> | null;
  return r !== null && typeof r === 'object' && typeof r.t === 'number' && typeof r.symbol === 'string' && typeof r.trades === 'number';
};

/** All recorded minutes for a symbol, oldest first, one per minute (a repeated minute keeps its last record). */
export function loadMinutes(dir: string, symbol: string): MinuteRecord[] {
  if (!existsSync(dir)) return [];
  const byT = new Map<number, MinuteRecord>();
  for (const file of readdirSync(dir).filter((f) => f.startsWith(`${symbol}-`) && f.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed)) byT.set(parsed.t, parsed);
      } catch { /* a torn last line from a crash is skipped */ }
    }
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}
