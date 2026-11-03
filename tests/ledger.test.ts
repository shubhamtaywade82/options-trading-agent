import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LedgerError, parseLedgerSeeds, priorVariantCount } from '../src/research/ledger.js';

const run = (sha: string | undefined): string => JSON.stringify(sha === undefined ? { ts: 'x' } : { ts: 'x', dataSha256: sha });
const SEED = [{ description: 'sweep', variantsEvaluated: 3, note: 'floor' }];

describe('priorVariantCount (OTA-313)', () => {
  it('is zero for an empty log with no seeds', () => {
    assert.equal(priorVariantCount('', []), 0);
    assert.equal(priorVariantCount('\n\n', []), 0);
  });

  it('counts every logged run, whatever dataset hash it used, so a changed dataset does not reset the divisor', () => {
    const log = [run('aaa'), run('bbb'), run('aaa')].join('\n');
    assert.equal(priorVariantCount(log, []), 3);
  });

  it('counts runs logged before the hash was written', () => {
    assert.equal(priorVariantCount([run(undefined), run('aaa')].join('\n'), []), 2);
  });

  it('adds the seeded variants that were never logged', () => {
    assert.equal(priorVariantCount(run('aaa'), SEED), 4);
  });

  it('fails closed on a malformed line, naming it, rather than undercounting', () => {
    assert.throws(() => priorVariantCount([run('aaa'), '{"dataSha256":"bb'].join('\n'), []), (error: unknown) => {
      assert.ok(error instanceof LedgerError);
      assert.match(error.message, /line 2 is malformed/);
      return true;
    });
  });
});

describe('parseLedgerSeeds (OTA-313)', () => {
  it('accepts positive integer counts', () => {
    assert.deepEqual(parseLedgerSeeds(SEED), SEED);
  });

  it('refuses a count that is zero, fractional or missing, since it would silently change the divisor', () => {
    for (const bad of [0, 1.5, -2, '3', undefined]) {
      assert.throws(() => parseLedgerSeeds([{ description: 'd', note: 'n', variantsEvaluated: bad }]), LedgerError);
    }
  });

  it('refuses a file that is not an array', () => {
    assert.throws(() => parseLedgerSeeds({}), LedgerError);
  });

  it('the committed seed file parses, so the divisor it feeds is always valid', () => {
    const path = join(fileURLToPath(new URL('..', import.meta.url)), 'docs/research/variants-seed.json');
    const seeds = parseLedgerSeeds(JSON.parse(readFileSync(path, 'utf8')));
    assert.ok(seeds.length > 0, 'the known unlogged sweeps are recorded');
  });
});
