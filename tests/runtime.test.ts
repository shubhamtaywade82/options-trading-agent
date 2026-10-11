import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { loadConfig, type AgentConfig } from '../src/config.js';
import type { Candle, InstrumentRef, OptionContract, Tick, UnderlyingSpec } from '../src/domain/types.js';
import type { EntryOrder, ExecutionEvent, ExecutionPort, ExitOrder } from '../src/execution/ports.js';
import { PaperExecutionPort } from '../src/execution/paper.js';
import type { AdvisoryVerdict, TradeAdvisor } from '../src/llm/advisor.js';
import type { EventLog } from '../src/ops/eventLog.js';
import type { Logger } from '../src/ops/logger.js';
import { Orchestrator, type OrchestratorFeed } from '../src/runtime/orchestrator.js';
import type { ChainSnapshot } from '../src/options/selector.js';
import { bar, contract, istEpoch, SESSION_DAY } from './support/fixtures.js';

const SILENT: Logger = { info() {}, warn() {}, error() {} };
const SPOT: InstrumentRef = { exchangeSegment: 'IDX_I', securityId: '13' };
// Synthetic index levels around 100 keep the fixtures readable; the strike step is 1 point.
const CE: OptionContract = contract({ optionType: 'CE', strike: 101, securityId: '48001', expiry: '2026-10-15', lotSize: 75, tickSize: 0.05 });
const PE: OptionContract = contract({ optionType: 'PE', strike: 101, securityId: '48002', expiry: '2026-10-15', lotSize: 75, tickSize: 0.05 });
const SPEC: UnderlyingSpec = { symbol: 'NIFTY', spot: SPOT, optionSegment: 'NSE_FNO' };

function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** Previous session rising 90 → 100: establishes an UP SuperTrend before today's open. */
function previousDay(): Candle[] {
  return Array.from({ length: 60 }, (_, i) => {
    const close = 90 + (i * 10) / 59;
    return bar(istEpoch('2026-10-09', hhmm(9 * 60 + 15 + i * 5)), close, close + 0.5, close - 0.5, close);
  });
}

/** Today's history through the 09:35 bar: opening range around 100, last close 100.3. */
function todayHistory(): Candle[] {
  const closes = [100, 100, 100, 100, 100.3];
  return closes.map((close, i) => bar(istEpoch(SESSION_DAY, hhmm(9 * 60 + 15 + i * 5)), close, close + 0.5, close - 0.5, close));
}

interface Harness {
  readonly orchestrator: Orchestrator;
  readonly feed: FakeFeed;
  readonly events: { type: string; payload: Record<string, unknown> }[];
  readonly setClock: (hhmmValue: string, day?: string) => void;
  readonly paperCloses: ExitOrder[];
}

class FakeFeed implements OrchestratorFeed {
  readonly subscribed = new Set<string>();
  age: number | undefined = 100;
  private readonly listeners = new Set<(tick: Tick) => void>();
  async start(): Promise<void> {
    return;
  }
  stop(): void {
    this.listeners.clear();
  }
  onTick(listener: (tick: Tick) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  subscribe(refs: readonly InstrumentRef[]): void {
    for (const ref of refs) {
      this.subscribed.add(`${ref.exchangeSegment}:${ref.securityId}`);
    }
  }
  unsubscribe(refs: readonly InstrumentRef[]): void {
    for (const ref of refs) {
      this.subscribed.delete(`${ref.exchangeSegment}:${ref.securityId}`);
    }
  }
  ageMs(): number | undefined {
    return this.age;
  }
  emit(tick: Tick): void {
    for (const listener of this.listeners) {
      listener(tick);
    }
  }
}

function chain(now: () => number): ChainSnapshot {
  const leg = (securityId: string, bid: number, ask: number) => ({
    ltp: (bid + ask) / 2,
    bid,
    ask,
    oi: 500_000,
    volume: 10_000,
    securityId,
  });
  return {
    expiry: '2026-10-15',
    fetchedAt: now(),
    strikes: [
      { strike: 100, call: leg('48003', 102, 102.5), put: leg('48004', 0.8, 1) },
      { strike: 101, call: leg('48001', 100.5, 101), put: leg('48002', 0.9, 1.1) },
      { strike: 102, call: leg('48005', 0.8, 1), put: leg('48006', 102, 102.5) },
    ],
  };
}

function build(
  env: Record<string, string> = {},
  options: { advisor?: TradeAdvisor; execution?: ExecutionPort; brokerOpen?: number } = {},
): Harness {
  // Start after the warmup's last bar has closed; the clock guard refuses bars stamped in the future.
  let clock = istEpoch(SESSION_DAY, '09:50');
  const now = () => clock;
  const config: AgentConfig = loadConfig({
    DHAN_CLIENT_ID: '1',
    DHAN_ACCESS_TOKEN: 't',
    CAPITAL_INR: '300000',
    MAX_RISK_PER_TRADE_PCT: '1',
    MAX_DAILY_LOSS_PCT: '1',
    ...env,
  });
  const feed = new FakeFeed();
  const events: Harness['events'] = [];
  const paperCloses: ExitOrder[] = [];
  const paper = new PaperExecutionPort({ slippageBps: 0, now });
  const execution = options.execution ?? paper;
  if (execution === paper) {
    paper.onEvent(() => undefined);
  }
  const market = {
    intradayCandles: async () => [...previousDay(), ...todayHistory()],
    listExpiries: async () => ['2026-10-15'],
    optionChain: async () => chain(now),
    optionContracts: async () => [CE, PE],
    availableFunds: async () => 300_000,
    brokerOpenOptionCount: async () => options.brokerOpen ?? 0,
  };
  const eventLog = {
    record: (type: string, payload: Record<string, unknown>) => {
      events.push({ type, payload });
    },
    flush: async () => undefined,
  } as unknown as EventLog;
  const orchestrator = new Orchestrator(config, [SPEC], {
    market,
    feed,
    execution,
    advisor: options.advisor,
    events: eventLog,
    logger: SILENT,
    now,
    clockIntervalMs: 1e9,
    shutdownTimeoutMs: 2_000,
  });
  return {
    orchestrator,
    feed,
    events,
    paperCloses,
    setClock: (value, day = SESSION_DAY) => {
      clock = istEpoch(day, value);
    },
  };
}

async function settle(orchestrator: Orchestrator): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await orchestrator.agent('NIFTY')?.drain();
  }
}

function clockTick(orchestrator: Orchestrator): void {
  (orchestrator as unknown as { onClock(): void }).onClock();
}

function spotTick(harness: Harness, ltp: number, at: string): void {
  harness.feed.emit({ exchangeSegment: 'IDX_I', securityId: '13', ltp, ltt: istEpoch(SESSION_DAY, at) });
}

function optionTick(harness: Harness, securityId: string, ltp: number): void {
  harness.feed.emit({ exchangeSegment: 'NSE_FNO', securityId, ltp, ltt: istEpoch(SESSION_DAY, '10:00') });
}

/** Drives the breakout: 09:40 bar closes at 101.5 after the 09:35 bar closed at 100.3. */
async function triggerBreakout(harness: Harness): Promise<void> {
  harness.setClock('09:40:10');
  spotTick(harness, 101.5, '09:40:10');
  harness.setClock('09:45:05');
  spotTick(harness, 101.6, '09:45:05');
  await settle(harness.orchestrator);
}

function types(harness: Harness): string[] {
  return harness.events.map((event) => event.type);
}

describe('runtime: winning trade end to end (paper venue)', () => {
  it('detects the breakout, buys one ATM call, and closes it at the bracket target', async () => {
    const harness = build();
    await harness.orchestrator.start();
    await triggerBreakout(harness);

    const agent = harness.orchestrator.agent('NIFTY');
    assert.equal(agent?.state, 'RISK_MANAGEMENT_ACTIVE');
    const position = agent?.openPosition;
    assert.equal(position?.contract.securityId, '48001');
    assert.equal(position?.quantity, 75);
    assert.equal(position?.averagePrice, 101);
    assert.equal(position?.stopLossPrice, 70.7);
    assert.equal(position?.targetPrice, 161.6);

    harness.setClock('10:00:00');
    optionTick(harness, '48001', 161.7);
    await settle(harness.orchestrator);

    assert.equal(agent?.state, 'IDLE');
    const closed = harness.events.find((event) => event.type === 'trade_closed');
    assert.equal(closed?.payload['reason'], 'TARGET');
    assert.equal(closed?.payload['pnlInr'], 4545);
    const snapshot = harness.orchestrator.dayBook.snapshot();
    assert.equal(snapshot.tradesToday, 1);
    assert.equal(snapshot.dayPnlInr, 4545);
    assert.deepEqual(snapshot.openUnderlyings, []);
    assert.ok(types(harness).includes('entry_submitted'));
    assert.ok(types(harness).includes('entry_filled'));
  });

  it('flattens an open position at the end-of-day cutoff', async () => {
    const harness = build();
    await harness.orchestrator.start();
    await triggerBreakout(harness);
    harness.setClock('15:05:00');
    clockTick(harness.orchestrator);
    await settle(harness.orchestrator);
    const closed = harness.events.find((event) => event.type === 'trade_closed');
    assert.equal(closed?.payload['reason'], 'EOD_FLATTEN');
    assert.equal(harness.orchestrator.agent('NIFTY')?.state, 'IDLE');
  });

  it('closes at the stop, fills at the gapped price, and trips the daily-loss kill switch', async () => {
    const harness = build();
    await harness.orchestrator.start();
    await triggerBreakout(harness);
    harness.setClock('10:05:00');
    optionTick(harness, '48001', 15);
    await settle(harness.orchestrator);
    clockTick(harness.orchestrator);
    await settle(harness.orchestrator);

    const closed = harness.events.find((event) => event.type === 'trade_closed');
    assert.equal(closed?.payload['reason'], 'STOP_LOSS');
    assert.equal(closed?.payload['exitPrice'], 15, 'a gap through the stop fills at the market, not at the stop');
    assert.equal(closed?.payload['pnlInr'], -6450);
    assert.ok(harness.orchestrator.dayBook.snapshot().killSwitchReason?.startsWith('daily loss'));

    // A fresh, valid breakout after the breach must be detected and then refused by the kill switch.
    harness.setClock('11:00:10');
    spotTick(harness, 100.2, '11:00:10');
    harness.setClock('11:05:05');
    spotTick(harness, 101.6, '11:05:05');
    harness.setClock('11:10:05');
    spotTick(harness, 101.7, '11:10:05');
    await settle(harness.orchestrator);
    const refused = harness.events.filter((event) => event.type === 'signal_dropped');
    assert.equal(refused.at(-1)?.payload['code'], 'KILL_SWITCH_ACTIVE');
    assert.equal(harness.events.filter((event) => event.type === 'entry_submitted').length, 1, 'no second entry after the breach');
  });
});

describe('runtime: vetoes', () => {
  it('lets an advisor SKIP stop the entry without any order being sent', async () => {
    const advisor: TradeAdvisor = {
      review: async () => ({ decision: 'SKIP', confidence: 0.9, reason: 'spot stretched', source: 'llm' }) as AdvisoryVerdict,
    };
    const harness = build({}, { advisor });
    await harness.orchestrator.start();
    await triggerBreakout(harness);
    assert.equal(harness.orchestrator.agent('NIFTY')?.state, 'IDLE');
    assert.equal(harness.events.find((event) => event.type === 'signal_dropped')?.payload['code'], 'ADVISOR_SKIP');
    assert.equal(harness.events.some((event) => event.type === 'entry_submitted'), false);
  });

  it('refuses entries on stale spot data', async () => {
    const harness = build();
    harness.feed.age = 60_000;
    await harness.orchestrator.start();
    await triggerBreakout(harness);
    assert.equal(harness.events.find((event) => event.type === 'signal_dropped')?.payload['code'], 'SPOT_DATA_STALE');
    assert.equal(harness.events.some((event) => event.type === 'entry_submitted'), false);
  });

  it('refuses to start while the broker already holds option positions', async () => {
    const harness = build({}, { brokerOpen: 1 });
    await assert.rejects(harness.orchestrator.start(), /open option position/);
  });
});

describe('runtime: halts', () => {
  it('halts the underlying on an unconfirmed entry and engages the broker kill switch at once', async () => {
    const killSwitch: string[] = [];
    const entries: EntryOrder[] = [];
    let listener: ((event: ExecutionEvent) => void) | undefined;
    const execution: ExecutionPort = {
      mode: 'live',
      submitEntry: async (order) => {
        entries.push(order);
        listener?.({ kind: 'ENTRY_UNCONFIRMED', correlationId: order.correlationId, underlying: 'NIFTY', reason: 'timeout' });
      },
      submitExit: async () => undefined,
      onOptionTick: () => undefined,
      onEvent: (fn) => {
        listener = fn;
        return () => undefined;
      },
      engageBrokerKillSwitch: async (reason) => {
        killSwitch.push(reason);
      },
      close: async () => undefined,
    };
    const harness = build({ BROKER_KILL_SWITCH_ON_BREACH: 'true' }, { execution });
    await harness.orchestrator.start();
    await triggerBreakout(harness);

    assert.equal(entries.length, 1);
    assert.equal(harness.orchestrator.agent('NIFTY')?.state, 'HALTED');
    assert.match(harness.orchestrator.agent('NIFTY')?.haltedBecause ?? '', /entry unconfirmed/);
    assert.equal(killSwitch.length, 1);
    assert.match(killSwitch[0] ?? '', /NIFTY: entry unconfirmed/);
    assert.ok(harness.orchestrator.dayBook.snapshot().killSwitchReason);
  });

  it('flattens every open position on shutdown and then reports flat', async () => {
    const harness = build();
    await harness.orchestrator.start();
    await triggerBreakout(harness);
    await harness.orchestrator.stop();
    const closed = harness.events.find((event) => event.type === 'trade_closed');
    assert.equal(closed?.payload['reason'], 'SHUTDOWN');
    assert.equal(harness.orchestrator.agent('NIFTY')?.isFlat(), true);
  });
});

describe('runtime: operator actions and cockpit snapshot', () => {
  it('reports the phase as RUNNING once started and FAILED with the reason when the start is refused', async () => {
    const running = build();
    await running.orchestrator.start();
    assert.equal(running.orchestrator.snapshot().phase, 'RUNNING');
    assert.equal(running.orchestrator.snapshot().underlyings[0]?.symbol, 'NIFTY');

    const refused = build({}, { brokerOpen: 1 });
    await assert.rejects(refused.orchestrator.start(), /open option position/);
    const failed = refused.orchestrator.snapshot();
    assert.equal(failed.phase, 'FAILED');
    assert.match(failed.phaseDetail ?? '', /open option position/);
  });

  it('closes the selected position through the normal exit path with reason MANUAL', async () => {
    const harness = build();
    await harness.orchestrator.start();
    await triggerBreakout(harness);
    assert.equal(harness.orchestrator.snapshot().underlyings[0]?.position?.quantity, 75);

    assert.match(harness.orchestrator.requestManualExit('NIFTY'), /close requested/);
    await settle(harness.orchestrator);

    assert.equal(harness.events.find((event) => event.type === 'trade_closed')?.payload['reason'], 'MANUAL');
    const view = harness.orchestrator.snapshot().underlyings[0];
    assert.equal(view?.position, undefined);
    assert.equal(view?.lastExit?.reason, 'MANUAL');
    assert.equal(view?.state, 'IDLE');
  });

  it('says why there is nothing to close instead of acting', async () => {
    const harness = build();
    await harness.orchestrator.start();
    assert.match(harness.orchestrator.requestManualExit('NIFTY'), /no open position/);
    assert.match(harness.orchestrator.requestManualExit('SENSEX'), /not traded by this agent/);
    assert.equal(harness.events.some((event) => event.type === 'exit_submitted'), false);
  });

  it('blocks new entries on request and clears the block only when nothing forbids it', async () => {
    const harness = build();
    await harness.orchestrator.start();
    assert.match(harness.orchestrator.toggleEntryBlock(), /new entries blocked/);
    assert.ok(harness.orchestrator.snapshot().day.killSwitchReason?.startsWith('operator entry block'));
    assert.match(harness.orchestrator.toggleEntryBlock(), /entry block cleared/);
    assert.equal(harness.orchestrator.snapshot().day.killSwitchReason, undefined);
  });

  it('refuses to clear the block while the day has breached its loss limit', async () => {
    const harness = build();
    await harness.orchestrator.start();
    await triggerBreakout(harness);
    harness.setClock('10:05:00');
    optionTick(harness, '48001', 15);
    await settle(harness.orchestrator);
    clockTick(harness.orchestrator);
    await settle(harness.orchestrator);

    assert.ok(harness.orchestrator.snapshot().day.killSwitchReason?.startsWith('daily loss'));
    assert.match(harness.orchestrator.toggleEntryBlock(), /daily loss limit is breached/);
    assert.ok(harness.orchestrator.snapshot().day.killSwitchReason?.startsWith('daily loss'));
  });
});
