import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { EventLog, journalFileName } from '../src/ops/eventLog.js';
import { istEpoch } from './support/fixtures.js';

let directory = '';

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'journal-test-'));
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('EventLog daily journal', () => {
  it('routes each record to the file for its own IST trading day', async () => {
    let clock = istEpoch('2026-10-12', '15:20');
    const errors: unknown[] = [];
    const log = new EventLog(join(directory, 'rotate'), (error) => errors.push(error), () => clock);
    log.record('trade_closed', { underlying: 'NIFTY', pnlInr: 100 });
    clock = istEpoch('2026-10-13', '09:30');
    log.record('entry_submitted', { underlying: 'NIFTY' });
    await log.flush();

    assert.deepEqual(errors, []);
    const files = (await readdir(join(directory, 'rotate'))).sort();
    assert.deepEqual(files, [journalFileName('2026-10-12'), journalFileName('2026-10-13')]);
    const first = (await readFile(join(directory, 'rotate', journalFileName('2026-10-12')), 'utf8')).trim().split('\n');
    assert.equal(first.length, 1);
    assert.equal(JSON.parse(first[0] ?? '{}').type, 'trade_closed');
  });

  it('creates the directory on first write and keeps lines whole under concurrent records', async () => {
    const clock = istEpoch('2026-10-14', '10:00');
    const log = new EventLog(join(directory, 'nested', 'deeper'), () => undefined, () => clock);
    for (let i = 0; i < 50; i += 1) {
      log.record('tick', { i });
    }
    await log.flush();
    const lines = (await readFile(join(directory, 'nested', 'deeper', journalFileName('2026-10-14')), 'utf8'))
      .trim()
      .split('\n');
    assert.equal(lines.length, 50);
    assert.ok(lines.every((line) => JSON.parse(line).type === 'tick'));
  });

  it('reports a failed write to onError and keeps accepting records', async () => {
    const clock = istEpoch('2026-10-15', '10:00');
    const errors: unknown[] = [];
    // A regular file where the directory should be makes mkdir fail.
    const blocker = join(directory, 'blocker');
    await (await import('node:fs/promises')).writeFile(blocker, 'x');
    const log = new EventLog(join(blocker, 'journal'), (error) => errors.push(error), () => clock);
    log.record('first', {});
    log.record('second', {});
    await log.flush();
    assert.equal(errors.length, 2, 'each failed record is reported, none is silently dropped');
  });
});
