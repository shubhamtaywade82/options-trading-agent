import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { istParts } from '../time/ist.js';

/** File name for one IST trading day inside the journal directory. */
export function journalFileName(dayKey: string): string {
  return `events-${dayKey}.jsonl`;
}

/**
 * Append-only JSONL audit trail, one file per IST day. Each record goes to the
 * file for its own IST date, so the journal never grows without bound and a
 * restart only reads the current day (see restoreDayBook). Writes are serialised
 * so lines never interleave. A failed write is reported through `onError` and
 * never blocks trading.
 */
export class EventLog {
  private chain: Promise<void> = Promise.resolve();
  private directoryReady = false;

  constructor(
    private readonly directory: string,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  record(type: string, payload: Readonly<Record<string, unknown>>): void {
    const at = this.now();
    const line = `${JSON.stringify({ ts: new Date(at).toISOString(), type, ...payload })}\n`;
    const file = join(this.directory, journalFileName(istParts(at).date));
    this.chain = this.chain
      .then(async () => {
        if (!this.directoryReady) {
          await mkdir(this.directory, { recursive: true });
          this.directoryReady = true;
        }
        await appendFile(file, line, 'utf8');
      })
      .catch((error: unknown) => {
        this.onError(error);
      });
  }

  flush(): Promise<void> {
    return this.chain;
  }
}
