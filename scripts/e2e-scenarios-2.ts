import { OrderRejectedError, PaperExchangeClient, VenueUnavailableError } from '../src/binance/paperExchangeClient.js';
import { OwnershipError } from '../src/binance/remoteBroker.js';
import { ADAPTIVE, EXTERNAL, MOMENTUM, type Scenario, type World } from './e2e-world.js';

const DEAD_URL = 'http://127.0.0.1:1';
const RETRY_INTERVAL_MS = 1_000;
const ENTRY_FEE = 0.4; // 0.04 % taker fee on the 1 000 notional of the default entry

async function s13(w: World): Promise<void> {
  const fake = w.fake;
  if (fake) fake.down = true;
  const api = fake ? w.base : new PaperExchangeClient(DEAD_URL, w.env.accountId, { retries: 0, timeoutMs: 500 });
  const unreachable = await w.newRig(api, undefined, false);
  for (let attempt = 0; attempt < 3; attempt++) await w.rejects('entry while the venue is unreachable', unreachable.broker.open(w.params()), VenueUnavailableError);
  w.is('orders that left the agent', unreachable.orders.length, 0);
  w.is('venue state', unreachable.broker.status().state, 'down');
  w.ok('no sidecar entry', unreachable.store.getMeta(w.symbol()) === undefined);
}

async function s14(w: World): Promise<void> {
  const fake = w.needFake();
  await w.broker.open(w.params());
  fake.down = true;
  w.broker.markAll({ [w.symbol()]: 94 });
  await w.broker.idle();
  await w.advance(RETRY_INTERVAL_MS);
  w.broker.markAll({ [w.symbol()]: 93 });
  await w.broker.idle();
  w.is('exit orders while down', w.reduceOnlyOrders().length, 0);
  fake.down = false;
  await w.advance(RETRY_INTERVAL_MS);
  w.broker.markAll({ [w.symbol()]: 93 });
  await w.broker.idle();
  w.is('exit orders after recovery', w.reduceOnlyOrders().length, 1);
  w.is('journal', w.broker.getTrades().map((t) => `${t.reason}@${t.exit}`).join(), 'STOP LOSS@93');
  w.is('exchange positions left', (await w.base.getPositions()).length, 0);
}

async function s15(w: World): Promise<void> {
  const fake = w.needFake();
  fake.failNextPostAfterFill = true;
  await w.broker.open(w.params());
  w.is('submissions for one logical order', w.rig.orders.length, 1);
  w.is('exchange rows', fake.allRows().length, 1);
  w.near('exchange qty (no duplicate)', fake.allRows()[0].netQuantity, 10);
  w.is('sidecar owner', w.store.getMeta(w.symbol())?.owner, MOMENTUM);
}

async function s16(w: World): Promise<void> {
  const err = await w.rejects('oversized entry', w.broker.open(w.params({ qty: 10_000 })), OrderRejectedError);
  w.is('http status', err.status, 402);
  w.ok('no sidecar entry', w.store.getMeta(w.symbol()) === undefined);
  w.is('journal entries', w.broker.getTrades().length, 0);
  w.is('exchange positions', (await w.base.getPositions()).length, 0);
}

async function s17(w: World): Promise<void> {
  await w.external({ symbol: w.symbol(), side: 'buy', quantity: 5, leverage: 3, executionPrice: 100 });
  await w.broker.sync();
  const [pos] = w.broker.getPositions();
  w.is('adopted as', pos.strategy, EXTERNAL);
  w.is('stops', `${pos.serverSl}/${pos.serverTp}`, '—/—');
  for (const mark of [90, 110]) {
    w.broker.markAll({ [w.symbol()]: mark });
    await w.broker.idle();
    await w.advance(RETRY_INTERVAL_MS + 100);
  }
  w.is('exit orders on the external position', w.reduceOnlyOrders().length, 0);
  await w.rejects('strategy entry on it', w.broker.open(w.params()), OwnershipError);
  w.near('exchange qty untouched', (await w.row()).netQuantity, 5);
}

async function s18(w: World): Promise<void> {
  await w.broker.open(w.params());
  w.broker.setMarks({ [w.symbol()]: 101 });
  await w.external({ symbol: w.symbol(), side: 'sell', quantity: 10, leverage: 5, executionPrice: 102 });
  await w.broker.sync();
  const [trade] = w.broker.getTrades();
  w.is('journal', `${trade?.reason}/${trade?.strategy}`, `CLOSE/${MOMENTUM}`);
  w.near('exit at last local mark', trade.exit, 101);
  w.near('gross pnl', trade.pnl, 10);
  w.is('agent positions', w.broker.getPositions().length, 0);
  w.ok('sidecar cleaned', w.store.getMeta(w.symbol()) === undefined);
}

async function s19(w: World): Promise<void> {
  const [a, b, c] = [w.symbol(), w.symbol(1), w.symbol(2)];
  await w.broker.open(w.params({ symbol: a }));
  await w.broker.open(w.params({ symbol: b, side: 'SELL', qty: 5, entryPrice: 50, stopLoss: 52.5, takeProfit: 45, strategy: ADAPTIVE }));
  await w.broker.open(w.params({ symbol: c, qty: 20, entryPrice: 10, stopLoss: 9, takeProfit: 12, strategy: 'FUNDING-ARB-α' }));
  const rows = await w.base.getPositions();
  w.near('positions agent/exch', w.broker.getPositions().length, rows.length);
  for (const row of rows) {
    const pos = w.broker.getPositions().find((p) => p.symbol === row.symbol);
    w.near(`${row.symbol} qty agent/exch`, pos?.qty ?? NaN, row.netQuantity);
  }
  w.near('margin used agent/exch', w.broker.getAccount().marginUsed, (await w.wallet()).locked);
  w.broker.markAll({ [a]: 94, [b]: 50, [c]: 10 });
  await w.broker.idle();
  w.is('only the breached symbol exited', w.broker.getPositions().map((p) => p.symbol).sort().join(), `${b},${c}`);
}

async function s20(w: World): Promise<void> {
  const symbol = w.symbol();
  await w.broker.open(w.params());
  w.broker.markAll({ [symbol]: 101, [w.symbol(1)]: 5 });
  await w.broker.idle();
  w.broker.markAll({ [symbol]: 103 });
  w.is('pushes inside the 1 s throttle window', w.rig.pushes.length, 1);
  await w.advance(RETRY_INTERVAL_MS + 100);
  w.broker.markAll({ [symbol]: 102 });
  await w.broker.idle();
  w.is('pushes after the window', w.rig.pushes.length, 2);
  w.ok('only symbols with a position pushed', w.rig.pushes.every((p) => Object.keys(p).join() === symbol));
  await w.eventually(async () => (await w.row()).currentPrice === 102, 2_000);
  w.near('exchange mark agent/exch', 102, (await w.row()).currentPrice);
}

async function s21(w: World): Promise<void> {
  const start = await w.wallet();
  await w.broker.open(w.params());
  await w.pushMark(w.symbol(), 103);
  w.broker.setMarks({ [w.symbol()]: 103 });
  await w.eventually(async () => { await w.broker.sync(); return Math.abs(w.broker.getAccount().equity - (await w.wallet()).total) < 1e-6; }, 2_000);
  const [account, exchange] = [w.broker.getAccount(), await w.wallet()];
  w.near('equity agent vs exch avail+locked+unrealized', account.equity, exchange.total);
  // The exchange rounds its equity field to 2 decimals, so it can only agree with the exact wallet to half a cent
  w.near('equity exch field vs wallet (fee-inclusive)', exchange.equityField, exchange.total, 0.005);
  w.near('margin used agent/exch', account.marginUsed, exchange.locked);
  w.near('initial equity agent vs exch margin', account.initialEquity, exchange.margin);
  w.near('unrealized agent/exch', w.broker.getPositions()[0].upnl, exchange.unrealized);
  w.near('equity change vs gross 30 minus entry fee', account.equity - start.total, 30 - ENTRY_FEE, 0.01);
}

async function s22(w: World): Promise<void> {
  await w.broker.open(w.params());
  await w.broker.close(w.broker.getPositions()[0], 'CLOSE');
  const zeroRows = await w.conn.zeroRows(w.symbol());
  await w.broker.sync();
  await w.broker.sync();
  w.notes.push(`exchange zero-quantity rows=${zeroRows}`);
  w.is('agent positions', w.broker.getPositions().length, 0);
  w.is('sidecar entries (none adopted)', Object.keys(w.store.metas()).length, 0);
  w.is('journal entries (the one close)', w.broker.getTrades().length, 1);
}

async function s23(w: World): Promise<void> {
  await w.broker.open(w.params());
  await w.external({ symbol: w.symbol(), side: 'buy', quantity: 5, leverage: 5, executionPrice: 100 });
  w.broker.markAll({ [w.symbol()]: 94 });
  await w.broker.idle();
  const [trade] = w.broker.getTrades();
  w.near('exit order qty vs changed exchange qty', w.reduceOnlyOrders()[0].quantity, 15);
  w.near('journaled qty', trade.qty, 15);
  w.near('gross pnl (94-100)*15', trade.pnl, -90);
  w.is('exchange positions left', (await w.base.getPositions()).length, 0);
}

async function s24(w: World): Promise<void> {
  await w.broker.open(w.params());
  for (let trigger = 0; trigger < 3; trigger++) w.broker.markAll({ [w.symbol()]: 94 });
  await w.broker.idle();
  w.is('reduce-only orders for three triggers', w.reduceOnlyOrders().length, 1);
  w.is('journal entries', w.broker.getTrades().length, 1);
  w.is('exchange positions left', (await w.base.getPositions()).length, 0);
}

export const SCENARIOS_13_TO_24: Scenario[] = [
  { id: 'S13', title: 'venue down at entry: refused, nothing sent', run: s13 },
  { id: 'S14', title: 'venue down during exit: retried, one exit after recovery', run: s14 },
  { id: 'S15', title: 'response lost after fill: lookup by client id, no duplicate', run: s15 },
  { id: 'S16', title: '402 insufficient margin: error, no sidecar or journal change', run: s16 },
  { id: 'S17', title: 'external position adopted as EXECUTOR-ε, never touched', run: s17 },
  { id: 'S18', title: 'agent position closed externally: detected, journal CLOSE', run: s18 },
  { id: 'S19', title: 'three symbols at once, only the breached one exits', run: s19 },
  { id: 'S20', title: 'mark prices pushed for held symbols every loop', run: s20 },
  { id: 'S21', title: 'equity, margin and pnl equal the exchange wallet (fees included)', run: s21 },
  { id: 'S22', title: 'zero-quantity rows ignored', run: s22 },
  { id: 'S23', title: 'exit after an external size change uses the fresh quantity', run: s23 },
  { id: 'S24', title: 'repeated trigger during an in-flight exit sends one order', run: s24 },
];
