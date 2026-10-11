import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EventStore, type AuditEvent } from '../src/ops/eventStore.js';

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'eventstore-'));
const fixedClock = (at: number) => () => at;
const linesOf = (file: string): string[] => readFileSync(file, 'utf-8').split('\n').filter(Boolean);

const validLine = (id: string, at = 1): string =>
  `${JSON.stringify({ id, at, type: 't', payload: {} })}\n`;

test('append then readTail returns events oldest-first with monotonic ids', () => {
  const store = new EventStore(join(tempDir(), 'events.jsonl'), { now: fixedClock(5_000) });
  store.append({ type: 'a', payload: { n: 1 } });
  store.append({ type: 'b', payload: { n: 2 } });
  store.append({ type: 'c', payload: { n: 3 } });

  const events = store.readTail(10);
  assert.deepEqual(events.map((e) => e.type), ['a', 'b', 'c']);
  assert.deepEqual(events.map((e) => e.id), ['5000-1', '5000-2', '5000-3']);
  assert.ok(events.every((e) => e.at === 5_000));
});

test('append keeps decisionId, symbol and an explicit at', () => {
  const store = new EventStore(join(tempDir(), 'events.jsonl'), { now: fixedClock(1) });
  store.append({ type: 'signal', decisionId: 'd-1', symbol: 'SOLUSDT', at: 42, payload: { side: 'LONG' } });

  const [event] = store.readTail(1);
  assert.equal(event?.decisionId, 'd-1');
  assert.equal(event?.symbol, 'SOLUSDT');
  assert.equal(event?.at, 42);
  assert.equal(event?.id, '42-1');
});

test('readTail(n) returns only the last n events', () => {
  const store = new EventStore(join(tempDir(), 'events.jsonl'));
  for (let i = 0; i < 10; i++) store.append({ type: 'e', payload: { i } });

  assert.deepEqual(store.readTail(3).map((e) => e.payload.i), [7, 8, 9]);
  assert.equal(store.readTail(100).length, 10);
  assert.deepEqual(store.readTail(0), []);
});

test('readTail on a missing file returns an empty list', () => {
  const store = new EventStore(join(tempDir(), 'never-written.jsonl'));
  assert.deepEqual(store.readTail(5), []);
});

test('append creates the parent directory on demand', () => {
  const file = join(tempDir(), 'nested', 'deeper', 'events.jsonl');
  const store = new EventStore(file);
  store.append({ type: 'a', payload: {} });

  assert.equal(store.lastError, undefined);
  assert.equal(store.readTail(1).length, 1);
});

test('rotates to <file>.1 when the next line would exceed maxBytes', () => {
  const file = join(tempDir(), 'events.jsonl');
  const store = new EventStore(file, { maxBytes: 600 });
  for (let i = 0; i < 12; i++) store.append({ type: 'e', payload: { i, pad: 'x'.repeat(40) } });

  assert.ok(existsSync(`${file}.1`));
  assert.ok(readFileSync(file).length <= 600);
  assert.ok(readFileSync(`${file}.1`).length <= 600);
});

test('rotation replaces a pre-existing <file>.1', () => {
  const file = join(tempDir(), 'events.jsonl');
  writeFileSync(`${file}.1`, 'stale-sentinel\n');
  const store = new EventStore(file, { maxBytes: 300 });
  for (let i = 0; i < 6; i++) store.append({ type: 'e', payload: { i, pad: 'x'.repeat(40) } });

  assert.ok(!readFileSync(`${file}.1`, 'utf-8').includes('stale-sentinel'));
});

test('1000 appends across rotations leave a contiguous, fully valid suffix', () => {
  const file = join(tempDir(), 'events.jsonl');
  const store = new EventStore(file, { maxBytes: 20_000, now: fixedClock(1) });
  for (let i = 1; i <= 1000; i++) store.append({ type: 'e', payload: { i } });

  const rotated = linesOf(`${file}.1`).map((l) => JSON.parse(l) as AuditEvent);
  const current = linesOf(file).map((l) => JSON.parse(l) as AuditEvent);
  const sequence = [...rotated, ...current].map((e) => e.payload.i as number);

  assert.ok(rotated.length > 0 && current.length > 0);
  assert.ok(sequence.length <= 1000);
  assert.equal(sequence.at(-1), 1000);
  sequence.forEach((value, index) => {
    assert.equal(value, sequence[0]! + index);
  });
  assert.deepEqual(store.readTail(1000).map((e) => e.payload.i), sequence);
});

test('readTail reaches into <file>.1 when the current file holds fewer than n events', () => {
  const file = join(tempDir(), 'events.jsonl');
  writeFileSync(`${file}.1`, validLine('old-1') + validLine('old-2'));
  writeFileSync(file, validLine('new-1'));
  const store = new EventStore(file);

  assert.deepEqual(store.readTail(2).map((e) => e.id), ['old-2', 'new-1']);
  assert.deepEqual(store.readTail(10).map((e) => e.id), ['old-1', 'old-2', 'new-1']);
});

test('readTail skips corrupt, partial, wrong-shape and blank lines', () => {
  const file = join(tempDir(), 'events.jsonl');
  writeFileSync(file, [
    validLine('ok-1').trim(),
    'garbage not json',
    '{"id":"half","at":1,"type":"t","payl',
    '{"a":1}',
    '',
    validLine('ok-2').trim(),
    '{"id":"no-payload","at":1,"type":"t"}',
  ].join('\n') + '\n{"id":"torn-tail","at":');
  const store = new EventStore(file);

  assert.deepEqual(store.readTail(10).map((e) => e.id), ['ok-1', 'ok-2']);
});

test('an append after a torn (unterminated) line is not merged into it', () => {
  const file = join(tempDir(), 'events.jsonl');
  writeFileSync(file, `${validLine('ok-1')}{"id":"torn","at":`);
  const store = new EventStore(file, { now: fixedClock(9) });
  store.append({ type: 'after-crash', payload: {} });

  assert.deepEqual(store.readTail(10).map((e) => e.type), ['t', 'after-crash']);
});

test('append never throws when the parent path is a file', () => {
  const dir = tempDir();
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'x');
  const store = new EventStore(join(blocker, 'sub', 'events.jsonl'));

  assert.doesNotThrow(() => store.append({ type: 'a', payload: {} }));
  assert.ok(store.lastError);
  assert.deepEqual(store.readTail(5), []);
});

test('append never throws when the target is a directory', () => {
  const dir = tempDir();
  const target = join(dir, 'is-a-dir');
  mkdirSync(target);
  const store = new EventStore(target);

  assert.doesNotThrow(() => store.append({ type: 'a', payload: {} }));
  assert.ok(store.lastError);
});

test('append swallows circular and BigInt payloads and keeps working afterwards', () => {
  const file = join(tempDir(), 'events.jsonl');
  const store = new EventStore(file);
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  assert.doesNotThrow(() => store.append({ type: 'circular', payload: circular }));
  assert.ok(store.lastError);
  assert.doesNotThrow(() => store.append({ type: 'bigint', payload: { n: 10n } }));
  assert.ok(store.lastError);

  store.append({ type: 'fine', payload: {} });
  assert.equal(store.lastError, undefined);
  assert.deepEqual(store.readTail(10).map((e) => e.type), ['fine']);
});

test('unusual but serializable payloads round-trip as JSON does', () => {
  const store = new EventStore(join(tempDir(), 'events.jsonl'));
  store.append({ type: 'odd', payload: { gone: undefined, nan: Number.NaN, nested: { list: [1, undefined, 'x'] }, when: new Date(0) } });

  const [event] = store.readTail(1);
  assert.deepEqual(event?.payload, { nan: null, nested: { list: [1, null, 'x'] }, when: '1970-01-01T00:00:00.000Z' });
});

test('a single line larger than maxBytes is still written', () => {
  const file = join(tempDir(), 'events.jsonl');
  const store = new EventStore(file, { maxBytes: 10 });
  store.append({ type: 'big', payload: { pad: 'x'.repeat(200) } });

  assert.equal(store.lastError, undefined);
  assert.equal(store.readTail(1)[0]?.type, 'big');
});
