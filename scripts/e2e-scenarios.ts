import { OwnershipError } from '../src/binance/remoteBroker.js';
import type { ExitReason } from '../src/types.js';
import { ADAPTIVE, EXTERNAL, INITIAL_MARGIN, MOMENTUM, type Scenario, type World } from './e2e-world.js';

const LIQUIDATION_WAIT_MS = 6_000;
const FUNDING_WAIT_MS = 4_000;
const ENTRY_FEE = 0.4; // 0.04 % taker fee on the 1 000 notional of the default entry
const HOUR_MS = 3_600_000;

/** Long 10 @ 100, then a breach: the agent must send one reduce-only exit and journal the exit reason. */
async function breach(w: World, mark: number, reason: ExitReason, exit: number): Promise<void> {
  await w.broker.open(w.params());
  w.broker.markAll({ [w.symbol()]: mark });
  await w.broker.idle();
  const [trade] = w.broker.getTrades();
  w.is('journal', trade?.reason, reason);
  w.near('exit price', trade.exit, exit);
  w.near('gross pnl vs (exit-entry)*qty', trade.pnl, (exit - 100) * 10);
  const [order] = w.reduceOnlyOrders();
  w.is('reduce-only exit orders', w.reduceOnlyOrders().length, 1);
  w.near('exit qty vs position', order.quantity, 10);
  w.is('exchange positions left', (await w.base.getPositions()).length, 0);
  w.ok('sidecar cleaned', w.store.getMeta(w.symbol()) === undefined);
  w.ok('exit announced once', w.broker.markAll({}).some((line) => line.startsWith(reason)));
}

async function s1(w: World): Promise<void> {
  const created = await w.newRig(w.env.blank());
  const account = created.broker.getAccount();
  w.near('new account margin created', account.initialEquity, INITIAL_MARGIN);
  w.near('new account free balance', account.equity, INITIAL_MARGIN);
  await w.external({ symbol: w.symbol(), side: 'buy', quantity: 5, leverage: 3, executionPrice: 100 });
  const before = await w.wallet();
  const restarted = await w.restart();
  w.near('existing account wallet after init', (await w.wallet()).total, before.total);
  w.is('existing position kept', (await w.base.getPositions()).length, 1);
  w.is('existing position adopted', restarted.broker.getPositions()[0].strategy, EXTERNAL);
}

async function s2(w: World): Promise<void> {
  const before = await w.wallet();
  await w.broker.open(w.params());
  const row = await w.row();
  const [pos] = w.broker.getPositions();
  const after = await w.wallet();
  w.near('qty agent/exch', pos.qty, row.netQuantity);
  w.near('entry agent/exch', pos.entry, row.averagePrice);
  w.near('margin used agent/exch', w.broker.getAccount().marginUsed, after.locked);
  w.near('margin vs notional/leverage', after.locked, 200, 0.01);
  w.near('entry fee (exch wallet drop) vs 0.04% notional', before.total - after.total, ENTRY_FEE, 0.01);
  await w.equityMatches('after open');
}

async function s3(w: World): Promise<void> {
  await w.broker.open(w.params());
  await w.broker.open(w.params({ entryPrice: 110, stopLoss: 105, takeProfit: 120 }));
  const row = await w.row();
  w.near('qty agent/exch', w.broker.getPositions()[0].qty, row.netQuantity);
  w.near('average entry agent/exch', w.broker.getPositions()[0].entry, row.averagePrice);
  w.near('average entry vs (100x10+110x10)/20', row.averagePrice, 105);
  w.is('stop loss replaced', w.store.getMeta(w.symbol())?.stopLoss, 105);
  w.is('initial risk kept', w.store.getMeta(w.symbol())?.initialRisk, 5);
}

async function s4(w: World): Promise<void> {
  await w.broker.open(w.params());
  const sent = w.rig.orders.length;
  await w.rejects('other strategy on an owned symbol', w.broker.open(w.params({ strategy: ADAPTIVE })), OwnershipError);
  w.is('orders sent after the refusal', w.rig.orders.length - sent, 0);
  w.is('owner unchanged', w.broker.getPositions()[0].strategy, MOMENTUM);
  w.near('exchange qty untouched', (await w.row()).netQuantity, 10);
}

async function s5(w: World): Promise<void> {
  await w.broker.open(w.params());
  await w.broker.open(w.params({ side: 'SELL', qty: 5, entryPrice: 105, stopLoss: 110, takeProfit: 90 }));
  const [trade] = w.broker.getTrades();
  const row = await w.row();
  w.is('journal', trade?.reason, 'FLIP');
  w.near('flip pnl (105-100)*10', trade.pnl, 50);
  w.is('order sequence', w.rig.orders.map((o) => `${o.reduceOnly ? 'reduce' : 'open'}-${o.side}-${o.quantity}`).join(','), 'open-buy-10,reduce-sell-10,open-sell-5');
  w.is('exchange side', row.side, 'short');
  w.near('qty agent/exch', w.broker.getPositions()[0].qty, row.netQuantity);
  w.is('owner kept through the flip', w.broker.getPositions()[0].strategy, MOMENTUM);
}

async function s8(w: World): Promise<void> {
  await w.broker.open(w.params());
  w.broker.updateStops(w.symbol(), MOMENTUM, 99, 115);
  const { broker } = await w.restart();
  const [pos] = broker.getPositions();
  w.is('stop loss after restart', pos.serverSl, '99');
  w.is('take profit after restart', pos.serverTp, '115');
  broker.markAll({ [w.symbol()]: 98.5 });
  await broker.idle();
  const [trade] = broker.getTrades();
  w.is('journal (old stop 95 would not have fired)', trade?.reason, 'STOP LOSS');
  w.near('exit price', trade.exit, 98.5);
}

async function s9(w: World): Promise<void> {
  await w.broker.open(w.params());
  w.broker.setMarks({ [w.symbol()]: 101 });
  await w.broker.close(w.broker.getPositions()[0], 'CLOSE');
  const [trade] = w.broker.getTrades();
  w.is('journal', trade?.reason, 'CLOSE');
  w.near('exit at last local mark', trade.exit, 101);
  w.near('gross pnl', trade.pnl, 10);
  w.is('exchange positions left', (await w.base.getPositions()).length, 0);
  w.ok('sidecar cleaned', w.store.getMeta(w.symbol()) === undefined);
  await w.equityMatches('after close');
}

async function s10(w: World): Promise<void> {
  await w.broker.open(w.params({ leverage: 10, stopLoss: undefined, takeProfit: undefined }));
  const liquidation = (await w.row()).liquidationPrice;
  if (liquidation === null) throw new Error('the exchange reported no liquidation price');
  const beyond = Number((liquidation * 0.99).toFixed(2));
  w.broker.markAll({ [w.symbol()]: beyond });
  await w.broker.idle();
  const isGone = await w.eventually(async () => (await w.base.getPositions()).length === 0, LIQUIDATION_WAIT_MS);
  w.ok(`exchange liquidated the position (liq ${liquidation.toFixed(2)}, mark pushed ${beyond})`, isGone);
  await w.broker.sync();
  const [trade] = w.broker.getTrades();
  w.is('journal', trade?.reason, 'LIQUIDATED');
  w.near('exit vs pushed mark', trade.exit, beyond);
  w.near('gross pnl', trade.pnl, (beyond - 100) * 10);
  w.ok('sidecar cleaned', w.store.getMeta(w.symbol()) === undefined);
}

async function s11(w: World): Promise<void> {
  await w.broker.open(w.params());
  w.broker.setMarks({ [w.symbol()]: 100 });
  const before = await w.wallet();
  const agentBefore = w.broker.getAccount().equity;
  const paid = -(10 * 100 * 0.0001); // positive rate: longs pay
  const fundingTime = Math.floor(w.now() / HOUR_MS) * HOUR_MS;
  w.ok('funding accepted', await w.broker.pushFunding(w.symbol(), 0.0001, 100, fundingTime));
  const isApplied = await w.eventually(async () => { await w.broker.sync(); return Math.abs(w.broker.getAccount().equity - agentBefore - paid) < 1e-6; }, FUNDING_WAIT_MS);
  w.ok('funding reached equity', isApplied);
  w.near('funding on exch wallet vs -qty*mark*rate', (await w.wallet()).total - before.total, paid);
  w.near('funding on agent equity vs exch', w.broker.getAccount().equity - agentBefore, (await w.wallet()).total - before.total);
  await w.broker.pushFunding(w.symbol(), 0.0001, 100, fundingTime);
  await w.settle(1_500);
  await w.broker.sync();
  w.near('equity after same fundingTime replayed', w.broker.getAccount().equity - agentBefore, paid);
}

async function s12(w: World): Promise<void> {
  await w.broker.open(w.params());
  const { broker, orders } = await w.restart();
  const [pos] = broker.getPositions();
  w.is('owner recovered', pos.strategy, MOMENTUM);
  w.is('SL/TP recovered', `${pos.serverSl}/${pos.serverTp}`, '95/110');
  w.is('initial risk recovered', pos.initialRisk, 5);
  w.is('orders sent by the restarted broker', orders.length, 0);
  w.near('exchange qty', (await w.row()).netQuantity, 10);
}

export const SCENARIOS_1_TO_12: Scenario[] = [
  { id: 'S1', title: 'account missing -> created with 100 000; existing account left untouched', run: s1 },
  { id: 'S2', title: 'open long: exchange position, margin and fee match the agent view', run: s2 },
  { id: 'S3', title: 'scale-in: average entry, initial risk kept', run: s3 },
  { id: 'S4', title: 'ownership conflict refused, no order sent', run: s4 },
  { id: 'S5', title: 'flip: reduce-only close then new position, journal FLIP', run: s5 },
  { id: 'S6', title: 'SL breach -> reduce-only exit, journal STOP LOSS', run: (w) => breach(w, 94, 'STOP LOSS', 94) },
  { id: 'S7', title: 'TP breach -> reduce-only exit at the level, journal TAKE PROFIT', run: (w) => breach(w, 112, 'TAKE PROFIT', 110) },
  { id: 'S8', title: 'trailing stop update persists across restart and is live', run: s8 },
  { id: 'S9', title: 'manual close -> journal CLOSE', run: s9 },
  { id: 'S10', title: 'server-side liquidation detected, journal LIQUIDATED', run: s10 },
  { id: 'S11', title: 'funding pushed once, equity reflects it, replay changes nothing', run: s11 },
  { id: 'S12', title: 'restart mid-position: owner, SL/TP recovered, no duplicate order', run: s12 },
];
