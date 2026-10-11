import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setSymbolRules } from '../src/binance/symbolRules.js';
import type { PerformanceSummary } from '../src/binance/performance.js';
import { digestCard, finishCard, signalCard, systemCard, tradeCard } from '../src/ops/cards.js';
import type { TradeRecord } from '../src/types.js';

const RULES = { tickSize: 0, stepSize: 0, minQty: 0, minNotional: 0 };
setSymbolRules('SOLUSDT', { ...RULES, pricePrecision: 3, quantityPrecision: 1 });
setSymbolRules('BTCUSDT', { ...RULES, pricePrecision: 1, quantityPrecision: 3 });

const AT = Date.UTC(2026, 8, 21, 9, 0, 0);
// ICU's en-IN date shape varies across Node builds, so the stamp comes from the same call the cards use
const IST = `${new Date(AT).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} IST`;

const trade = (over: Partial<TradeRecord>): TradeRecord => ({
  symbol: 'SOLUSDT', strategy: 'MOMENTUM-γ', side: 'LONG', entry: 150, exit: 160, qty: 10,
  pnl: 100, reason: 'TAKE PROFIT', closedAt: AT, ...over,
});

test('take-profit exit card shows gross PnL and the R multiple', () => {
  const html = tradeCard({ kind: 'EXIT', trade: trade({}), leverage: 5, initialRisk: 5 });
  assert.equal(html, [
    '<b>[ TRADE ]</b> SOLUSDT',
    '<b>✅ TAKE PROFIT</b>',
    '🟢 <b>Side:</b> LONG · 10.0',
    '📥 <b>Entry:</b> 150.000',
    '📤 <b>Exit:</b> 160.000',
    '💰 <b>PnL:</b> +100.00 USDT (gross)',
    '🎯 <b>Result:</b> +2.00R',
    '📊 <b>Strategy:</b> MOMENTUM-γ · 5x',
    `🕒 <b>Time:</b> ${IST}`,
  ].join('\n'));
});

test('stop-loss exit card uses per-symbol precision and omits R when initial risk is unknown', () => {
  const html = tradeCard({
    kind: 'EXIT',
    trade: trade({ symbol: 'BTCUSDT', side: 'SHORT', entry: 65_000, exit: 65_500, qty: 0.5, pnl: -1_250, reason: 'STOP LOSS', strategy: 'ADAPTIVE-ST-ζ' }),
  });
  assert.equal(html, [
    '<b>[ TRADE ]</b> BTCUSDT',
    '<b>🛑 STOP LOSS</b>',
    '🔴 <b>Side:</b> SHORT · 0.500',
    '📥 <b>Entry:</b> 65,000.0',
    '📤 <b>Exit:</b> 65,500.0',
    '💰 <b>PnL:</b> -1,250.00 USDT (gross)',
    '📊 <b>Strategy:</b> ADAPTIVE-ST-ζ',
    `🕒 <b>Time:</b> ${IST}`,
  ].join('\n'));
});

test('R multiple is negative on a loss and omitted for a zero or negative initial risk', () => {
  const loser = trade({ pnl: -50, reason: 'STOP LOSS' });
  assert.match(tradeCard({ kind: 'EXIT', trade: loser, initialRisk: 5 }), /<b>Result:<\/b> -1\.00R/);
  assert.doesNotMatch(tradeCard({ kind: 'EXIT', trade: loser, initialRisk: 0 }), /Result/);
  assert.doesNotMatch(tradeCard({ kind: 'EXIT', trade: loser, initialRisk: -1 }), /Result/);
});

test('every exit reason has its own title', () => {
  const titles = (['STOP LOSS', 'TAKE PROFIT', 'LIQUIDATED', 'CLOSE', 'FLIP'] as const)
    .map((reason) => tradeCard({ kind: 'EXIT', trade: trade({ reason }) }).split('\n')[1]);
  assert.deepEqual(titles, [
    '<b>🛑 STOP LOSS</b>', '<b>✅ TAKE PROFIT</b>', '<b>💥 LIQUIDATED</b>', '<b>🔒 CLOSED</b>', '<b>🔄 FLIP EXIT</b>',
  ]);
});

test('entry, scale-in and flip cards share one layout', () => {
  const base = { symbol: 'SOLUSDT', side: 'LONG', qty: 10, price: 150, strategy: 'MOMENTUM-γ', leverage: 5, at: AT } as const;
  assert.equal(tradeCard({ kind: 'OPEN', ...base }), [
    '<b>[ TRADE ]</b> SOLUSDT',
    '<b>🚀 POSITION OPENED</b>',
    '🟢 <b>Side:</b> LONG · 10.0',
    '📥 <b>Entry:</b> 150.000',
    '📊 <b>Strategy:</b> MOMENTUM-γ · 5x',
    `🕒 <b>Time:</b> ${IST}`,
  ].join('\n'));
  assert.match(tradeCard({ kind: 'SCALE_IN', ...base }), /\n<b>➕ SCALE-IN<\/b>\n/);
  assert.match(tradeCard({ kind: 'FLIP', ...base, side: 'SHORT' }), /\n<b>🔄 FLIPPED<\/b>\n🔴 <b>Side:<\/b> SHORT/);
  assert.doesNotMatch(tradeCard({ kind: 'OPEN', ...base, leverage: undefined }), /5x/);
});

test('trade card escapes markup in symbols and strategies', () => {
  const html = tradeCard({ kind: 'EXIT', trade: trade({ symbol: 'A<B>&C', strategy: 'X&Y' as TradeRecord['strategy'] }) });
  assert.ok(html.includes('A&lt;B&gt;&amp;C') && html.includes('X&amp;Y'));
  assert.ok(!html.includes('A<B>'));
});

test('venue-down system card names the venue and account', () => {
  const html = systemCard({ kind: 'VENUE', state: 'down', venue: 'binance-futures', account: 'live', detail: 'ECONNRESET <api>', at: AT });
  assert.equal(html, [
    '<b>[ SYSTEM ]</b>',
    '<b>🚨 VENUE DOWN</b>',
    '🏦 <b>Venue:</b> binance-futures (live)',
    '⚠️ <b>Detail:</b> ECONNRESET &lt;api&gt;',
    `🕒 <b>Time:</b> ${IST}`,
  ].join('\n'));
});

test('venue degraded and recovered get their own titles and a minimal body', () => {
  assert.equal(systemCard({ kind: 'VENUE', state: 'degraded', venue: 'paper', at: AT }).split('\n')[1], '<b>⚠️ VENUE DEGRADED</b>');
  const recovered = systemCard({ kind: 'VENUE', state: 'recovered', venue: 'paper', at: AT });
  assert.equal(recovered.split('\n')[1], '<b>✅ VENUE RECOVERED</b>');
  assert.doesNotMatch(recovered, /Detail|\(\)/);
});

test('circuit-change card shows from/to state and the limits driving it', () => {
  const html = systemCard({ kind: 'CIRCUIT', from: 'NORMAL', to: 'CAUTION', dailyLossPercent: 1.5, drawdownPercent: 2.256, lossStreak: 3, at: AT });
  assert.equal(html, [
    '<b>[ SYSTEM ]</b>',
    '<b>🛡️ RISK ALERT</b>',
    '🔀 <b>Circuit breaker:</b> NORMAL → CAUTION',
    '📉 <b>Daily loss:</b> 1.50%',
    '📉 <b>Drawdown:</b> 2.26%',
    '🔻 <b>Loss streak:</b> 3',
    `🕒 <b>Time:</b> ${IST}`,
  ].join('\n'));
  assert.equal(systemCard({ kind: 'CIRCUIT', from: 'HALTED', to: 'NORMAL', dailyLossPercent: 0, drawdownPercent: 0, lossStreak: 0, at: AT }).split('\n')[1], '<b>✅ RISK NORMALIZED</b>');
});

test('websocket, loop crash and kill-switch cards', () => {
  const ws = (status: 'down' | 'reconnecting' | 'connected') => systemCard({ kind: 'WS', status, at: AT }).split('\n').slice(1, 3);
  assert.deepEqual(ws('down'), ['<b>🚨 WEBSOCKET DOWN</b>', '📡 <b>Binance WebSocket:</b> down']);
  assert.equal(ws('reconnecting')[0], '<b>⚠️ WEBSOCKET RECONNECTING</b>');
  assert.equal(ws('connected')[0], '<b>✅ WEBSOCKET RECOVERED</b>');

  assert.deepEqual(systemCard({ kind: 'LOOP_CRASH', error: 'boom & bust', at: AT }).split('\n').slice(1, 3), [
    '<b>💥 LOOP CRASH</b>', '⚠️ <b>Error:</b> boom &amp; bust',
  ]);
  const halted = systemCard({ kind: 'KILL_SWITCH', halted: true, reason: 'operator key', at: AT });
  assert.deepEqual(halted.split('\n').slice(1, 3), ['<b>⛔ KILL SWITCH HALTED</b>', '📝 <b>Reason:</b> operator key']);
  assert.equal(systemCard({ kind: 'KILL_SWITCH', halted: false, reason: 'r', at: AT }).split('\n')[1], '<b>▶️ KILL SWITCH RESUMED</b>');
});

test('signal card lists levels, RR, size, regime and reason', () => {
  const html = signalCard({
    outcome: 'ACCEPTED', symbol: 'SOLUSDT', side: 'LONG', entry: 150, stopLoss: 145, takeProfit: 160,
    qty: 10, notionalUsdt: 1_500, regime: 'HIGH', strategy: 'ADAPTIVE-ST-ζ', reason: 'flip above <line>', at: AT,
  });
  assert.equal(html, [
    '<b>[ SIGNAL ]</b> SOLUSDT',
    '<b>✅ ENTRY ACCEPTED — LONG</b>',
    '🎯 <b>Entry:</b> 150.000',
    '🛑 <b>SL:</b> 145.000',
    '✅ <b>TP:</b> 160.000',
    '⚖️ <b>RR:</b> 2.00',
    '💼 <b>Size:</b> 10.0 (1,500.00 USDT)',
    '🧭 <b>Regime:</b> HIGH',
    '📊 <b>Strategy:</b> ADAPTIVE-ST-ζ',
    '📝 <b>Why:</b> flip above &lt;line&gt;',
    `🕒 <b>Time:</b> ${IST}`,
  ].join('\n'));
});

test('refused and vetoed signals carry the reason line; missing optionals are skipped', () => {
  const base = { symbol: 'SOLUSDT', side: 'SHORT', entry: 150, stopLoss: 150, takeProfit: 140, strategy: 'MOMENTUM-γ', reason: 'r', at: AT } as const;
  const refused = signalCard({ ...base, outcome: 'REFUSED', note: 'max positions reached' });
  assert.equal(refused.split('\n')[1], '<b>⛔ ENTRY REFUSED — SHORT</b>');
  assert.ok(refused.includes('⛔ <b>Refused:</b> max positions reached'));
  assert.doesNotMatch(refused, /RR|Size|Regime/);
  const vetoed = signalCard({ ...base, outcome: 'VETOED', note: 'chasing' });
  assert.ok(vetoed.includes('🧠 <b>Vetoed:</b> chasing'));
  assert.equal(signalCard({ ...base, outcome: 'PROPOSED' }).split('\n')[1], '<b>🔴 ENTRY PROPOSAL — SHORT</b>');
});

const SUMMARY: PerformanceSummary = {
  totalPnl: 20, totalPnlPct: 0.2, closedTrades: 3, winRate: (2 / 3) * 100, maxDrawdownPct: -1.5,
  sharpe: null, var95: null, liquidations: 0,
  byStrategy: { 'MOMENTUM-γ': { closed: 2, wins: 2, pnl: 150 }, 'FUNDING-ARB-α': { closed: 1, wins: 0, pnl: -130 } },
};
const TRADES = [
  trade({ pnl: 100 }), trade({ pnl: 50 }),
  trade({ symbol: 'BTCUSDT', strategy: 'FUNDING-ARB-α', pnl: -130, reason: 'STOP LOSS' }),
];

test('digest card summarises the period, refusals and strategies', () => {
  const html = digestCard({
    period: '2026-09-21 UTC', summary: SUMMARY, trades: TRADES, at: AT,
    refusals: { 'kill-switch': 1, 'max positions <4>': 4 },
  });
  assert.equal(html, [
    '<b>[ DIGEST ]</b> 2026-09-21 UTC',
    '<b>📊 DAILY DIGEST</b>',
    '💰 <b>PnL:</b> +20.00 USDT (+0.20%)',
    '🧾 <b>Trades:</b> 3 · win rate 66.7%',
    '⚖️ <b>Profit factor:</b> 1.15',
    '🏆 <b>Best:</b> SOLUSDT +100.00',
    '💔 <b>Worst:</b> BTCUSDT -130.00',
    '📉 <b>Max drawdown:</b> 1.50%',
    '🚫 <b>Refusals:</b> 5',
    '   • max positions &lt;4&gt;: 4',
    '   • kill-switch: 1',
    '🧩 <b>By strategy</b>',
    '   MOMENTUM-γ: 2 trades · 100% win · +150.00',
    '   FUNDING-ARB-α: 1 trade · 0% win · -130.00',
    `🕒 <b>Time:</b> ${IST}`,
  ].join('\n'));
});

test('digest prints a dash for infinite, NaN and null values and never leaks them as text', () => {
  const allWins = digestCard({ period: 'p', summary: SUMMARY, trades: [trade({ pnl: 10 })], at: AT });
  assert.ok(allWins.includes('⚖️ <b>Profit factor:</b> —'));

  const empty = digestCard({
    period: 'p', trades: [], at: AT,
    summary: { ...SUMMARY, totalPnl: NaN, totalPnlPct: Infinity, winRate: null, maxDrawdownPct: -Infinity, closedTrades: 0, byStrategy: {} },
  });
  assert.ok(empty.includes('💰 <b>PnL:</b> —'));
  assert.ok(empty.includes('🧾 <b>Trades:</b> 0 · win rate —'));
  assert.ok(empty.includes('⚖️ <b>Profit factor:</b> —'));
  assert.ok(empty.includes('📉 <b>Max drawdown:</b> —'));
  assert.doesNotMatch(empty, /Best|Worst|Refusals|By strategy/);
  for (const html of [allWins, empty]) assert.doesNotMatch(html, /NaN|undefined|Infinity/);
});

test('cards never exceed 3500 characters and cut on a line boundary with an ellipsis', () => {
  const refusals = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`reason number ${i} `.repeat(3), 400 - i]));
  const html = digestCard({ period: 'p', summary: SUMMARY, trades: TRADES, at: AT, refusals });
  assert.ok(html.length <= 3500);
  assert.ok(html.endsWith('\n…'));
  assert.ok(html.split('\n').slice(0, -1).every((line) => !line.includes('<b>') || line.includes('</b>')));
});

test('finishCard leaves short cards alone and hard-cuts one oversized line without splitting an entity', () => {
  assert.equal(finishCard(['a', 'b']), 'a\nb');
  const huge = finishCard([`${'x'.repeat(3_498)}&amp;`, 'tail']);
  assert.ok(huge.length <= 3500);
  assert.ok(huge.endsWith('…'));
  assert.doesNotMatch(huge, /&[a-z]*…$/);
});
