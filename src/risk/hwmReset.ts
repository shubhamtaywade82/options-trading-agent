import { copyFileSync, existsSync } from 'node:fs';
import type { Mode } from '../types.js';
import { EquityHwmStore } from './equityHwm.js';

export interface ResetOptions {
  filePath: string;
  mode: Mode;
  /** Without it nothing is written: the report says what would happen. */
  confirm: boolean;
  /** Resetting the drawdown stop of a live account needs its own explicit flag. */
  allowLive: boolean;
  now?: () => number;
}

export interface ResetReport {
  mode: Mode;
  status: 'DRY_RUN' | 'RESET' | 'REFUSED' | 'NOTHING_TO_RESET';
  previousPeak: number;
  previousResetAt: number;
  backupPath?: string;
  lines: string[];
}

const isoOrNever = (at: number): string => (at > 0 ? new Date(at).toISOString() : 'never');

/** Operator reset of the drawdown baseline. Backs the file up first and reports exactly what was cleared. */
export function resetRiskBaseline(options: ResetOptions): ResetReport {
  const now = options.now ?? Date.now;
  const store = new EquityHwmStore(options.filePath, now);
  const previousPeak = store.peak(options.mode);
  const previousResetAt = store.resetAt(options.mode);
  const base = { mode: options.mode, previousPeak, previousResetAt };
  const header = `mode ${options.mode}: stored equity peak ${previousPeak > 0 ? previousPeak.toFixed(2) : 'none'}, last reset ${isoOrNever(previousResetAt)} (${options.filePath})`;

  if (options.mode === 'live' && !options.allowLive) {
    return { ...base, status: 'REFUSED', lines: [header, 'REFUSED: this clears the drawdown stop of a LIVE account. Re-run with --allow-live if that is what you want.'] };
  }
  if (!options.confirm) {
    return {
      ...base, status: 'DRY_RUN',
      lines: [header, 'DRY RUN, nothing written. With --confirm this will: back the file up, forget the stored peak, and ignore realized peaks in the trade journal from before now.', 'The next equity reading becomes the new peak (drawdown 0%). Daily-loss and loss-streak limits are NOT reset.'],
    };
  }

  let backupPath: string | undefined;
  if (existsSync(options.filePath)) {
    backupPath = `${options.filePath}.bak-${now()}`;
    copyFileSync(options.filePath, backupPath);
  }
  const { resetAt } = store.resetDrawdown(options.mode);
  return {
    ...base, status: 'RESET', ...(backupPath === undefined ? {} : { backupPath }),
    lines: [
      header,
      backupPath === undefined ? 'No existing file to back up.' : `Backed up to ${backupPath}`,
      `RESET at ${isoOrNever(resetAt)}: stored peak ${previousPeak > 0 ? previousPeak.toFixed(2) : 'none'} cleared; journal peaks before this time no longer count.`,
      'Restart the agent (or wait for the next cycle) so it picks the new baseline up. Daily-loss and loss-streak limits still apply.',
    ],
  };
}
