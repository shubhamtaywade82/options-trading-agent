import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Append-only JSONL audit trail. Writes are serialised so lines never interleave.
 * A failed write is reported through `onError` and never blocks trading: the
 * audit trail is important, but an I/O hiccup must not turn into a stuck position.
 */
export class EventLog {
  private chain: Promise<void> = Promise.resolve();
  private ready = false;

  constructor(
    private readonly path: string,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  record(type: string, payload: Readonly<Record<string, unknown>>): void {
    const line = `${JSON.stringify({ ts: new Date(this.now()).toISOString(), type, ...payload })}\n`;
    this.chain = this.chain
      .then(async () => {
        if (!this.ready) {
          await mkdir(dirname(this.path), { recursive: true });
          this.ready = true;
        }
        await appendFile(this.path, line, 'utf8');
      })
      .catch((error: unknown) => {
        this.onError(error);
      });
  }

  flush(): Promise<void> {
    return this.chain;
  }
}
