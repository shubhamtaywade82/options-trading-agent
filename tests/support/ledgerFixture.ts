/**
 * Test helpers: re-exports from src/research/LedgerFixtures.ts so existing tests don't change.
 *
 * The canonical implementation lives in src/ so the golden-task suite (also in src/) can import it without
 * a src → tests dependency. `mulberry32` is imported from Bootstrap.ts (canonical location) — see the
 * existing tests/conditionalEdge.test.ts and tests/optimizer.test.ts for usage.
 */
export {
  makeLedger,
  makeMultiRegimeLedger,
  type LedgerFixtureOptions,
} from '../../src/research/LedgerFixtures.js';
