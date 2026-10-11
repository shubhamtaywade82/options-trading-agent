import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Mode } from '../types.js';
import type { PmState } from './PositionManager.js';

interface PmFile {
  version: 1;
  /** Manager states per account mode: paper and live positions are different books. */
  modes: Partial<Record<Mode, Record<string, PmState>>>;
}

const EXTREME_FLUSH_MS = 5_000;

function isStateMap(value: unknown): value is Record<string, PmState> {
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value).every((s) => {
    const st = s as Partial<PmState> | null;
    return st !== null && typeof st === 'object' && typeof st.key === 'string' && typeof st.entry === 'number'
      && typeof st.oneR === 'number' && typeof st.stop === 'number' && typeof st.initialQty === 'number'
      && (st.side === 'LONG' || st.side === 'SHORT');
  });
}

function load(filePath: string): PmFile {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<PmFile>;
    if (parsed.version !== 1 || parsed.modes === null || typeof parsed.modes !== 'object') return { version: 1, modes: {} };
    const modes: PmFile['modes'] = {};
    for (const [mode, states] of Object.entries(parsed.modes)) if (isStateMap(states)) modes[mode as Mode] = states;
    return { version: 1, modes };
  } catch {
    // Missing or corrupt: states are rebuilt from the venue's positions as INITIAL
    return { version: 1, modes: {} };
  }
}

/**
 * Persisted per-position manager state, atomic tmp+rename like the other data/ files. Material changes (flags, stop,
 * phase, quantities) write immediately; a mere new price extreme is flushed at most every few seconds.
 */
export class PositionManagerStore {
  private readonly file: PmFile;
  private lastFlushAt = 0;
  private dirty = false;

  constructor(private readonly mode: Mode, private readonly filePath = path.resolve('data/position-manager.json'), private readonly now: () => number = Date.now) {
    this.file = load(filePath);
    this.file.modes[mode] ??= {};
  }

  private get states(): Record<string, PmState> {
    return this.file.modes[this.mode]!;
  }

  get(key: string): PmState | undefined {
    return this.states[key];
  }

  keys(): string[] {
    return Object.keys(this.states);
  }

  set(state: PmState): void {
    const prev = this.states[state.key];
    this.states[state.key] = state;
    const material = !prev || prev.stop !== state.stop || prev.phase !== state.phase || prev.tp1Done !== state.tp1Done
      || prev.tp2Done !== state.tp2Done || prev.reducedQty !== state.reducedQty || prev.target !== state.target || prev.entry !== state.entry;
    if (material) this.flush();
    else if (prev?.extreme !== state.extreme) this.dirty = true;
  }

  delete(key: string): void {
    if (!(key in this.states)) return;
    delete this.states[key];
    this.flush();
  }

  /** Throttled write for extreme-only changes; call once per manage pass. */
  tick(): void {
    if (this.dirty && this.now() - this.lastFlushAt >= EXTREME_FLUSH_MS) this.flush();
  }

  flush(): void {
    this.dirty = false;
    this.lastFlushAt = this.now();
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.file, null, 2), 'utf-8');
      renameSync(tmp, this.filePath);
    } catch {
      // A disk failure must never interrupt trading; the state is rebuilt from the venue on restart
    }
  }
}
