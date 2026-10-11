import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface KillSwitchState {
  halted: boolean;
  reason: string;
  at: number;
}

const NOT_HALTED: KillSwitchState = { halted: false, reason: '', at: 0 };

function isKillSwitchState(value: unknown): value is KillSwitchState {
  if (value === null || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return typeof state.halted === 'boolean' && typeof state.reason === 'string' && typeof state.at === 'number';
}

function loadState(filePath: string): KillSwitchState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    return isKillSwitchState(parsed) ? parsed : NOT_HALTED;
  } catch {
    // A missing or corrupt file means nobody halted the agent, so trading must not be blocked by it
    return NOT_HALTED;
  }
}

/** Operator halt for new entries, persisted so a restart cannot silently resume trading. */
export class KillSwitch {
  /** Set when the last save failed: the halt still holds in memory, but a restart would lose it. */
  lastError?: string;
  private current: KillSwitchState;

  constructor(
    private readonly filePath = path.resolve('data/kill-switch.json'),
    private readonly now: () => number = Date.now,
  ) {
    this.current = loadState(filePath);
  }

  isHalted(): boolean {
    return this.current.halted;
  }

  state(): KillSwitchState {
    return { ...this.current };
  }

  /** Flips the halt and saves it atomically; a failed save is recorded in `lastError`, never thrown. */
  toggle(reason: string): KillSwitchState {
    this.current = { halted: !this.current.halted, reason, at: this.now() };
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.current));
      renameSync(tmp, this.filePath);
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    return this.state();
  }
}
