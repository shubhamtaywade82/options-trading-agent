import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface PersistedSymbolState {
  symbol: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  breakEvenMoved?: boolean;
  openedAt: number;
  reason: string;
}

export interface StateStore {
  positions: Record<string, PersistedSymbolState>;
  updatedAt: number;
}

const FILE_PATH = path.resolve('data/minicpm-state.json');

export function loadMiniCpmState(): StateStore {
  try {
    if (existsSync(FILE_PATH)) {
      const content = readFileSync(FILE_PATH, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed.positions === 'object') return parsed;
    }
  } catch {}
  return { positions: {}, updatedAt: Date.now() };
}

export function saveMiniCpmPosition(state: PersistedSymbolState): void {
  const current = loadMiniCpmState();
  current.positions[state.symbol] = state;
  current.updatedAt = Date.now();
  try {
    writeFileSync(FILE_PATH, JSON.stringify(current, null, 2), 'utf-8');
  } catch {}
}

export function removeMiniCpmPosition(symbol: string): void {
  const current = loadMiniCpmState();
  if (current.positions[symbol]) {
    delete current.positions[symbol];
    current.updatedAt = Date.now();
    try {
      writeFileSync(FILE_PATH, JSON.stringify(current, null, 2), 'utf-8');
    } catch {}
  }
}
