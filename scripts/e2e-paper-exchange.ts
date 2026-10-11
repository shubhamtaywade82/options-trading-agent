import 'dotenv/config';
import { PaperExchangeClient } from '../src/binance/paperExchangeClient.js';
import { FakeExchange } from '../tests/support/fakeExchange.js';
import { SCENARIOS_1_TO_12 } from './e2e-scenarios.js';
import { SCENARIOS_13_TO_24 } from './e2e-scenarios-2.js';
import { assertThrowaway, INITIAL_MARGIN, SkipError, violations, World, type Conn, type Env, type Scenario } from './e2e-world.js';

const SCENARIOS: Scenario[] = [...SCENARIOS_1_TO_12, ...SCENARIOS_13_TO_24];

type Outcome = { status: 'PASS' | 'FAIL' | 'SKIPPED'; detail: string };

const errorText = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

function fakeEnv(): Env {
  const connect = async (): Promise<Conn> => {
    const fake = new FakeExchange();
    await fake.createAccount(INITIAL_MARGIN);
    return { base: fake, outsider: fake, fake, zeroRows: async (symbol) => fake.allRows().filter((p) => p.symbol === symbol && p.netQuantity === 0).length };
  };
  return { backend: 'fake', accountId: 'e2e-fake', connect, blank: () => new FakeExchange() };
}

/** One throwaway account for the whole run; the exchange cannot delete accounts, so `e2e-*` rows stay behind. */
async function realEnv(): Promise<Env> {
  const url = process.env.PAPER_EXCHANGE_URL?.replace(/\/+$/, '');
  if (!url) throw new Error('E2E_BACKEND=real needs PAPER_EXCHANGE_URL');
  const accountId = `e2e-${Date.now()}`;
  assertThrowaway(accountId);
  const conn: Conn = {
    base: new PaperExchangeClient(url, accountId),
    outsider: new PaperExchangeClient(url, accountId),
    fake: null,
    zeroRows: async (symbol) => {
      const response = await fetch(`${url}/api/positions`, { headers: { 'X-Account-Id': accountId } });
      const rows = (await response.json()) as { symbol: string; net_quantity: string | number }[];
      return rows.filter((row) => row.symbol === symbol && Number(row.net_quantity) === 0).length;
    },
  };
  await conn.base.createAccount(INITIAL_MARGIN);
  return { backend: 'real', accountId, connect: async () => conn, blank: () => new PaperExchangeClient(url, `${accountId}-blank`) };
}

async function runScenario(env: Env, index: number, scenario: Scenario): Promise<Outcome> {
  const world = new World(env, await env.connect(), index);
  try {
    await world.start();
    await scenario.run(world);
    await world.flatten();
    return { status: 'PASS', detail: world.notes.join('; ') };
  } catch (err) {
    if (err instanceof SkipError) return { status: 'SKIPPED', detail: `(${err.message})` };
    // A leftover position on the shared throwaway account would poison the next scenario; the failure being reported matters more than a cleanup error.
    await world.flatten().catch(() => undefined);
    return { status: 'FAIL', detail: `${errorText(err)} | compared so far: ${world.notes.join('; ')}` };
  }
}

async function main(): Promise<void> {
  const backend = process.env.E2E_BACKEND ?? 'fake';
  if (backend !== 'fake' && backend !== 'real') throw new Error(`E2E_BACKEND must be fake or real, got ${backend}`);
  const env = backend === 'real' ? await realEnv() : fakeEnv();
  console.log(`E2E backend=${env.backend} account=${env.accountId}`);
  const counts = { PASS: 0, FAIL: 0, SKIPPED: 0 };
  for (const [index, scenario] of SCENARIOS.entries()) {
    const outcome = await runScenario(env, index, scenario);
    counts[outcome.status]++;
    console.log(`${outcome.status} ${scenario.id} ${scenario.title} | ${outcome.detail}`);
  }
  console.log(`\n${counts.PASS} passed, ${counts.FAIL} failed, ${counts.SKIPPED} skipped (${SCENARIOS.length} scenarios)`);
  if (violations.length > 0) console.log(`FAIL symbol guard tripped: ${violations.join(',')}`);
  process.exitCode = counts.FAIL > 0 || violations.length > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(errorText(err));
  process.exit(1);
});
