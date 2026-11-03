/**
 * Variants evaluated by the research program outside the run log, such as sweeps that were run before logging existed
 * or were never written down. Each `variantsEvaluated` is a floor, not an estimate: the real count was at least this.
 */
export interface LedgerSeed {
  readonly description: string;
  readonly variantsEvaluated: number;
  readonly note: string;
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

/**
 * How many variants the research program has evaluated before this run. Every logged run counts, whatever dataset it
 * used and whether or not it recorded a hash, and so does every seeded variant. The count is program-wide because
 * each run is another draw from the same search, and a changed dataset must not reset the multiple-testing divisor.
 *
 * Fail-closed: a malformed log line throws. Skipping it would make the divisor smaller, and a smaller divisor is the
 * false-positive direction.
 */
export function priorVariantCount(logText: string, seeds: readonly LedgerSeed[]): number {
  let logged = 0;
  logText.split('\n').forEach((line, index) => {
    if (line.trim() === '') {
      return;
    }
    try {
      JSON.parse(line);
    } catch {
      throw new LedgerError(`runs.jsonl line ${index + 1} is malformed; the multiple-testing count cannot be trusted until it is fixed`);
    }
    logged += 1;
  });
  return logged + seeds.reduce((total, seed) => total + seed.variantsEvaluated, 0);
}

/** Validates the seed file's shape. A seed that is not a positive integer would silently change the divisor. */
export function parseLedgerSeeds(raw: unknown): LedgerSeed[] {
  if (!Array.isArray(raw)) {
    throw new LedgerError('variant seed file must be a JSON array');
  }
  return raw.map((entry, index) => {
    const seed = entry as Partial<LedgerSeed> | null;
    if (seed === null || typeof seed !== 'object' || typeof seed.description !== 'string' || typeof seed.note !== 'string') {
      throw new LedgerError(`variant seed ${index + 1} needs a description and a note`);
    }
    if (typeof seed.variantsEvaluated !== 'number' || !Number.isInteger(seed.variantsEvaluated) || seed.variantsEvaluated < 1) {
      throw new LedgerError(`variant seed ${index + 1} needs a positive integer variantsEvaluated`);
    }
    return { description: seed.description, variantsEvaluated: seed.variantsEvaluated, note: seed.note };
  });
}
