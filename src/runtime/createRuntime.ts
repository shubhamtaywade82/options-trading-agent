import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { createDhanClient } from '../dhan/client.js';
import { DhanFeed } from '../dhan/feed.js';
import { InstrumentMaster } from '../dhan/instrumentMaster.js';
import { DhanMarketData } from '../dhan/marketData.js';
import { LiveExecutionPort, type LiveClient } from '../dhan/liveExecution.js';
import type { AgentConfig, SandboxConfig } from '../config.js';
import type { ExecutionPort } from '../execution/ports.js';
import { PostgresPaperExecutionPort } from '../execution/postgresPaper.js';
import { PostgresPaperStore } from '../execution/paperStore.js';
import { OllamaTradeAdvisor, type TradeAdvisor } from '../llm/advisor.js';
import type { UnderlyingSpec } from '../domain/types.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventLog, journalFileName } from '../ops/eventLog.js';
import { restoreDayBook } from '../ops/dayState.js';
import { DayBook } from '../risk/dayBook.js';
import { createConsoleLogger, RingLogger, type Logger } from '../ops/logger.js';
import { backfillDay } from '../persistence/backfill.js';
import type { PostgresLedger } from '../persistence/ledger.js';
import { errorMessage } from '../persistence/redact.js';
import { scopeJournalLines } from '../persistence/scope.js';
import { openSession, type PersistenceSession } from '../persistence/session.js';
import { istParts } from '../time/ist.js';
import type { MarketPort } from './ports.js';
import { Orchestrator } from './orchestrator.js';
import { ledgerAndLeaseGate } from './tradingGate.js';

export interface Runtime {
  readonly orchestrator: Orchestrator;
  readonly logger: Logger;
  /** Set in cockpit mode: the bounded log the terminal screen renders. */
  readonly records: RingLogger | undefined;
}

/**
 * Composes the object graph from validated config. Every mode shares the same market-data path (instruments,
 * charts, option chain, feed) on the live Dhan credentials. Only the order venue differs:
 *   live    -> Dhan production account
 *   sandbox -> Dhan sandbox account (sandbox credentials and base URL)
 *   paper   -> PostgreSQL paper venue (wallet, orders, positions, P&L)
 * Index specs are resolved from the scrip master up front, so an unknown index fails at startup rather than on
 * the first signal.
 *
 * Storage: the journal file is always written, and every line carries its mode and client. When DATABASE_URL
 * is set, the ledger is the source for restoring the day, after the journal is backfilled into it. The
 * trading lease lives in PostgreSQL. Redis holds the account rate gate and the contract cache. Any failure
 * here closes what was opened and refuses to start.
 */
export async function buildRuntime(
  config: AgentConfig,
  now: () => number = Date.now,
  options: { cockpit?: boolean } = {},
): Promise<Runtime> {
  const records = options.cockpit === true ? new RingLogger(200, now) : undefined;
  const logger: Logger = records ?? createConsoleLogger(undefined, now);
  const session = await openSession(config, { logger, now });
  try {
    return await compose(config, now, logger, records, session);
  } catch (error) {
    await session.close('startup failed');
    throw error;
  }
}

async function compose(
  config: AgentConfig,
  now: () => number,
  logger: Logger,
  records: RingLogger | undefined,
  session: PersistenceSession,
): Promise<Runtime> {
  const mode = config.mode;
  const clientId = config.dhan.clientId;
  const scope = { mode, clientId };
  const events = new EventLog({
    directory: config.ops.eventLogDir,
    runId: session.runId,
    scope,
    ...(session.ledger === undefined ? {} : { ledger: session.ledger }),
    onError: (error) => logger.error('event log write failed', { error: errorMessage(error, session.secrets) }),
    now,
  });

  // Market data is always the live Dhan feed, on the market-data credentials.
  const dataClient = await createDhanClient(config.dhan, { logger, now });
  const master = new InstrumentMaster(dataClient.instruments, () => istParts(now()).date, { cache: session.cache, now });
  const marketData = new DhanMarketData(dataClient, {
    istShiftedTimestamps: config.feed.istShiftedTimestamps,
    now,
    rateGate: session.rateGate,
    accountKey: clientId,
  });
  const feed = new DhanFeed(dataClient, { istShiftedTimestamps: config.feed.istShiftedTimestamps, now });

  // Orders reach a Dhan account only in live and sandbox. Sandbox uses its own client, so no sandbox request
  // can carry production credentials, and no production request can carry sandbox ones.
  const orderClient =
    config.mode === 'live'
      ? dataClient
      : config.mode === 'sandbox' && config.sandbox !== undefined
        ? await createDhanClient(sandboxDhan(config.sandbox), { logger, now })
        : undefined;
  const orderFunds =
    config.mode === 'sandbox' && orderClient !== undefined
      ? new DhanMarketData(orderClient, {
          istShiftedTimestamps: config.feed.istShiftedTimestamps,
          now,
          rateGate: session.rateGate,
          accountKey: `${clientId}:sandbox`,
        })
      : undefined;

  const venue = config.mode === 'paper' ? await openPaperVenue(config, session, logger, now) : undefined;

  const market: MarketPort = {
    intradayCandles: (spot, barMinutes, fromDate, toDate) => marketData.intradayCandles(spot, barMinutes, fromDate, toDate),
    listExpiries: (spot) => marketData.listExpiries(spot),
    optionChain: (spot, expiry) => marketData.optionChain(spot, expiry),
    optionContracts: (underlying, optionSegment) => master.optionContracts(underlying, optionSegment),
    availableFunds: () => {
      if (venue !== undefined) {
        return venue.cash();
      }
      if (config.mode === 'live') {
        return marketData.availableFunds();
      }
      if (orderFunds === undefined) {
        return Promise.reject(new Error('no order account to read funds from in this mode'));
      }
      return orderFunds.availableFunds();
    },
    // In paper mode the venue's own open positions play the role of the broker book.
    brokerOpenOptionCount: async () => {
      if (orderClient !== undefined) {
        return countOpenOptionLegs(orderClient);
      }
      return venue?.openPositionCount() ?? 0;
    },
    brokerLiveOrderCount: async () => (orderClient === undefined ? 0 : countLiveOrders(orderClient)),
  };

  let execution: ExecutionPort;
  if (orderClient !== undefined) {
    execution = new LiveExecutionPort(orderClient as LiveClient, {
      mode: config.mode === 'sandbox' ? 'sandbox' : 'live',
      orderTimeoutMs: config.ops.orderTimeoutMs,
      reconcileIntervalMs: config.ops.reconcileIntervalMs,
      logger,
      now,
    });
  } else if (venue !== undefined) {
    execution = venue;
  } else {
    throw new Error(`no order venue for ${mode} mode`);
  }

  const advisor = buildAdvisor(config, logger);

  const specs: UnderlyingSpec[] = [];
  for (const underlying of config.underlyings) {
    const spot = await master.resolveSpot(underlying.symbol);
    specs.push({ symbol: underlying.symbol, spot, optionSegment: underlying.optionSegment });
  }

  const dayBook = new DayBook(now(), config.exits.cooldownSeconds * 1000);
  const dayKey = istParts(now()).date;
  const lines =
    session.ledger === undefined
      ? await readJournal(config.ops.eventLogDir, dayKey, scope)
      : await restoreFromLedger(session.ledger, config.ops.eventLogDir, dayKey, scope, logger, session.secrets);
  const restored = restoreDayBook(dayBook, lines, dayKey);
  logger.info('day state restored', {
    source: session.ledger === undefined ? 'journal' : 'ledger',
    eventsApplied: restored.eventsApplied,
    releasedUnresolved: restored.releasedUnresolved,
  });

  const gate = ledgerAndLeaseGate({
    unconfirmedEvents: () => events.unconfirmedEvents(),
    leaseHolds: () => session.lease === undefined || session.lease.holds(),
  });

  const orchestrator = new Orchestrator(config, specs, {
    dayBook,
    market,
    feed,
    execution,
    advisor,
    events,
    logger,
    now,
    gate,
    closeSession: () => session.close('stopped', events.unconfirmedEvents()),
  });
  return { orchestrator, logger, records };
}

/**
 * Backfills today's journal into the ledger, then returns the ledger's view of the day. A failed or
 * incomplete backfill throws, so the agent does not restore from a ledger that is missing events.
 */
async function restoreFromLedger(
  ledger: PostgresLedger,
  directory: string,
  dayKey: string,
  scope: { readonly mode: string; readonly clientId: string },
  logger: Logger,
  secrets: readonly string[],
): Promise<string[]> {
  try {
    const report = await backfillDay({ directory, tradingDay: dayKey, ledger });
    logger.info('journal backfilled into the ledger', { day: dayKey, lines: report.lines, inserted: report.inserted });
    const untagged = await ledger.untaggedDayCount(dayKey);
    if (untagged > 0) {
      throw new Error(`${untagged} ledger row(s) for ${dayKey} predate mode and client tags and cannot be attributed; move them aside before restoring`);
    }
    return await ledger.dayLines(dayKey, scope);
  } catch (error) {
    throw new Error(`cannot restore ${dayKey} from the ledger: ${errorMessage(error, secrets)}`);
  }
}

/** Sandbox orders use a static token. The sandbox base URL is set explicitly, and the config refuses the production host. */
function sandboxDhan(sandbox: SandboxConfig): AgentConfig['dhan'] {
  return {
    clientId: sandbox.clientId,
    auth: { kind: 'static', accessToken: sandbox.accessToken },
    baseUrl: sandbox.baseUrl,
  };
}

/**
 * Opens the PostgreSQL paper venue: creates the wallet on first use and loads the open positions. The venue needs
 * the database and the lease fence, both of which exist in paper mode because the config requires DATABASE_URL.
 */
async function openPaperVenue(
  config: AgentConfig,
  session: PersistenceSession,
  logger: Logger,
  now: () => number,
): Promise<PostgresPaperExecutionPort> {
  if (session.pool === undefined || session.fence === undefined) {
    throw new Error('paper mode needs the PostgreSQL paper venue, and DATABASE_URL is not open');
  }
  const venue = new PostgresPaperExecutionPort(new PostgresPaperStore(session.pool, session.fence), {
    clientId: config.dhan.clientId,
    slippageBps: config.paper.slippageBps,
    initialCapitalInr: config.capital.inr,
    logger,
    now,
  });
  await venue.open();
  return venue;
}

function buildAdvisor(config: AgentConfig, logger: Logger): TradeAdvisor | undefined {
  if (!config.llm.enabled) {
    return undefined;
  }
  if (config.llm.model === undefined) {
    throw new Error('LLM_ADVISOR=on requires OLLAMA_MODEL');
  }
  const client = new OllamaClient({
    baseUrl: config.llm.host,
    ...(config.llm.apiKey === undefined ? {} : { apiKey: config.llm.apiKey }),
  });
  logger.info('llm advisor enabled', { host: config.llm.host, model: config.llm.model });
  return new OllamaTradeAdvisor(client, config.llm.model, config.llm.timeoutMs);
}

/**
 * Lines of today's journal file written by this mode and client. A missing file means no trading has been
 * journalled today, so there is nothing to restore. Lines from another mode or client are skipped. Untagged
 * lines predate tagging and cannot be attributed, so their presence refuses the restore.
 */
async function readJournal(directory: string, dayKey: string, scope: { readonly mode: string; readonly clientId: string }): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(directory, journalFileName(dayKey)), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return scopeJournalLines(text, scope, dayKey);
}

/** Statuses the broker reports for a settled order. Anything else, including a missing status, counts as live. */
const TERMINAL_ORDER_STATUSES: ReadonlySet<string> = new Set(['TRADED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'CLOSED']);

async function countLiveOrders(client: Pick<LiveClient, 'orders' | 'superOrders'>): Promise<number> {
  const [orders, superOrders] = await Promise.all([client.orders.list(), client.superOrders.list()]);
  const live = (status: string | undefined): boolean => status === undefined || !TERMINAL_ORDER_STATUSES.has(status);
  return orders.filter((order) => live(order.orderStatus)).length + superOrders.filter((order) => live(order.orderStatus)).length;
}

async function countOpenOptionLegs(client: Pick<LiveClient, 'positions'>): Promise<number> {
  const rows = await client.positions.list();
  return rows.filter(
    (row) =>
      (String(row.exchangeSegment) === 'NSE_FNO' || String(row.exchangeSegment) === 'BSE_FNO') &&
      (row.netQty ?? 0) !== 0,
  ).length;
}
