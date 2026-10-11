import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { createDhanClient } from '../dhan/client.js';
import { DhanFeed } from '../dhan/feed.js';
import { InstrumentMaster } from '../dhan/instrumentMaster.js';
import { DhanMarketData } from '../dhan/marketData.js';
import { LiveExecutionPort, type LiveClient } from '../dhan/liveExecution.js';
import type { AgentConfig } from '../config.js';
import { PaperExecutionPort } from '../execution/paper.js';
import { OllamaTradeAdvisor, type TradeAdvisor } from '../llm/advisor.js';
import type { UnderlyingSpec } from '../domain/types.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventLog, journalFileName } from '../ops/eventLog.js';
import { restoreDayBook } from '../ops/dayState.js';
import { DayBook } from '../risk/dayBook.js';
import { createConsoleLogger, type Logger } from '../ops/logger.js';
import { istParts } from '../time/ist.js';
import type { MarketPort } from './ports.js';
import { Orchestrator } from './orchestrator.js';

export interface Runtime {
  readonly orchestrator: Orchestrator;
  readonly logger: Logger;
}

/**
 * Composes the production object graph from validated config. Paper and live
 * share every read path (instruments, charts, option chain, feed); only the
 * venue differs. Index specs are resolved from the scrip master up front, so an
 * unknown index fails at startup rather than on the first signal.
 */
export async function buildRuntime(config: AgentConfig, now: () => number = Date.now): Promise<Runtime> {
  const logger = createConsoleLogger(undefined, now);
  const events = new EventLog(
    config.ops.eventLogDir,
    (error) => logger.error('event log write failed', { error: String(error) }),
    now,
  );

  const client = createDhanClient(config.dhan);
  const master = new InstrumentMaster(client.instruments, () => istParts(now()).date);
  const marketData = new DhanMarketData(client, { istShiftedTimestamps: config.feed.istShiftedTimestamps, now });
  const feed = new DhanFeed(client, { istShiftedTimestamps: config.feed.istShiftedTimestamps, now });

  const live = config.mode === 'live';
  const market: MarketPort = {
    intradayCandles: (spot, barMinutes, fromDate, toDate) => marketData.intradayCandles(spot, barMinutes, fromDate, toDate),
    listExpiries: (spot) => marketData.listExpiries(spot),
    optionChain: (spot, expiry) => marketData.optionChain(spot, expiry),
    optionContracts: (underlying, optionSegment) => master.optionContracts(underlying, optionSegment),
    availableFunds: () => (live ? marketData.availableFunds() : Promise.resolve(config.capital.inr)),
    brokerOpenOptionCount: async () => (live ? countOpenOptionLegs(client) : 0),
  };

  const execution = live
    ? new LiveExecutionPort(client as LiveClient, {
        orderTimeoutMs: config.ops.orderTimeoutMs,
        reconcileIntervalMs: config.ops.reconcileIntervalMs,
        logger,
        now,
      })
    : new PaperExecutionPort({ slippageBps: config.paper.slippageBps, now });

  const advisor = buildAdvisor(config, logger);

  const specs: UnderlyingSpec[] = [];
  for (const underlying of config.underlyings) {
    const spot = await master.resolveSpot(underlying.symbol);
    specs.push({ symbol: underlying.symbol, spot, optionSegment: underlying.optionSegment });
  }

  const dayBook = new DayBook(now(), config.exits.cooldownSeconds * 1000);
  const dayKey = istParts(now()).date;
  const restored = restoreDayBook(dayBook, await readJournal(config.ops.eventLogDir, dayKey), dayKey);
  logger.info('day state restored from journal', {
    eventsApplied: restored.eventsApplied,
    releasedUnresolved: restored.releasedUnresolved,
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
  });
  return { orchestrator, logger };
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
 * Lines of today's journal file. A missing file means no trading has been
 * journalled today, so there is nothing to restore. Other errors propagate.
 */
async function readJournal(directory: string, dayKey: string): Promise<string[]> {
  try {
    return (await readFile(join(directory, journalFileName(dayKey)), 'utf8')).split('\n');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function countOpenOptionLegs(client: Pick<LiveClient, 'positions'>): Promise<number> {
  const rows = await client.positions.list();
  return rows.filter(
    (row) =>
      (String(row.exchangeSegment) === 'NSE_FNO' || String(row.exchangeSegment) === 'BSE_FNO') &&
      (row.netQty ?? 0) !== 0,
  ).length;
}

