import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AuditEvent {
  id: string;
  at: number;
  type: string;
  decisionId?: string;
  symbol?: string;
  payload: Record<string, unknown>;
}

export type AuditInput = Omit<AuditEvent, 'id' | 'at'> & { at?: number };

interface EventStoreOptions {
  maxBytes?: number;
  now?: () => number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const NEWLINE_BYTE = 10;

const isAuditEvent = (value: unknown): value is AuditEvent => {
  if (value === null || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return typeof e.id === 'string' && typeof e.at === 'number' && typeof e.type === 'string'
    && e.payload !== null && typeof e.payload === 'object';
};

const readEvents = (file: string): AuditEvent[] => {
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const events: AuditEvent[] = [];
  for (const line of text.split('\n')) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isAuditEvent(parsed)) events.push(parsed);
    } catch {
      // A crash mid-append leaves a torn line; the rest of the trail is still usable
    }
  }
  return events;
};

const fileSize = (file: string): number => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

const endsWithNewline = (file: string, size: number): boolean => {
  const fd = openSync(file, 'r');
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === NEWLINE_BYTE;
  } finally {
    closeSync(fd);
  }
};

/** Append-only JSONL audit trail; a failing disk must never reach the trading loop. */
export class EventStore {
  lastError?: string;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private counter = 0;
  private tailChecked = false;

  constructor(private readonly filePath: string, opts: EventStoreOptions = {}) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = opts.now ?? Date.now;
  }

  /** Stamps id/at and appends one JSONL line; failures are recorded in `lastError`, never thrown. */
  append(input: AuditInput): void {
    try {
      this.write(input);
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  /** Last `n` valid events, oldest first; reads `<file>.1` only when the live file is short. */
  readTail(n: number): AuditEvent[] {
    if (n <= 0) return [];
    const current = readEvents(this.filePath);
    const events = current.length >= n ? current : [...readEvents(`${this.filePath}.1`), ...current];
    return events.slice(-n);
  }

  private write(input: AuditInput): void {
    const { at: givenAt, ...rest } = input;
    const at = givenAt !== undefined && Number.isFinite(givenAt) ? givenAt : this.now();
    let line = `${JSON.stringify({ id: `${at}-${++this.counter}`, at, ...rest })}\n`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const size = fileSize(this.filePath);
    if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) {
      renameSync(this.filePath, `${this.filePath}.1`);
    } else if (!this.tailChecked && size > 0 && !endsWithNewline(this.filePath, size)) {
      // Without this, the first line after a crash would fuse with the torn one and be lost too
      line = `\n${line}`;
    }
    appendFileSync(this.filePath, line);
    this.tailChecked = true;
  }
}
