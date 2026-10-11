import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { makeAlert, type AlertEvent } from '../src/ops/alerts.js';
import { escapeHtml, sendAlert, sendTelegram, telegramConfigured } from '../src/ops/telegram.js';

const TOKEN = '123:secret-token';
const CONFIGURED = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '-100777' };

interface Call { url: string; init: RequestInit }

function recorder(respond: () => Promise<Response> = async () => new Response('{}', { status: 200 })) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const bodyOf = (call: Call): Record<string, unknown> => JSON.parse(String(call.init.body)) as Record<string, unknown>;

const alertOf = (over: Partial<AlertEvent>): AlertEvent =>
  makeAlert({ at: 1, class: 'SYSTEM', severity: 'IMPORTANT', title: 't', body: 'b', fingerprint: 'f', ...over });

test('escapeHtml escapes ampersand first so entities are not double-escaped', () => {
  assert.equal(escapeHtml('a<b>&c'), 'a&lt;b&gt;&amp;c');
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

test('telegramConfigured needs a chat id and at least one bot token', () => {
  assert.equal(telegramConfigured({}), false);
  assert.equal(telegramConfigured({ TELEGRAM_BOT_TOKEN: TOKEN }), false);
  assert.equal(telegramConfigured({ TELEGRAM_CHAT_ID: '1' }), false);
  assert.equal(telegramConfigured({ TELEGRAM_BOT_TOKEN: '  ', TELEGRAM_CHAT_ID: '1' }), false);
  assert.equal(telegramConfigured(CONFIGURED), true);
  assert.equal(telegramConfigured({ TELEGRAM_ALERTBOT_BOT_TOKEN: 'a', TELEGRAM_CHAT_ID: '1' }), true);
  assert.equal(telegramConfigured({ TELEGRAM_TRADING_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' }), true);
});

test('sendTelegram returns false without calling fetch when unconfigured', async () => {
  const { calls, fetchImpl } = recorder();
  assert.equal(await sendTelegram('hi', {}, { fetchImpl, env: {} }), false);
  assert.equal(await sendTelegram('hi', {}, { fetchImpl, env: { TELEGRAM_BOT_TOKEN: TOKEN } }), false);
  assert.equal(calls.length, 0);
});

test('sendTelegram posts the exact sendMessage request', async () => {
  const { calls, fetchImpl } = recorder();
  const sent = await sendTelegram('<b>hi</b>', {}, { fetchImpl, env: CONFIGURED });

  assert.equal(sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(bodyOf(calls[0]), {
    chat_id: '-100777', text: '<b>hi</b>', parse_mode: 'HTML',
    disable_web_page_preview: true, disable_notification: false,
  });
});

test('silent maps to disable_notification', async () => {
  const { calls, fetchImpl } = recorder();
  await sendTelegram('x', { silent: true }, { fetchImpl, env: CONFIGURED });
  assert.equal(bodyOf(calls[0]).disable_notification, true);
});

test('trading channel prefers TELEGRAM_TRADING_BOT_TOKEN then TELEGRAM_BOT_TOKEN', async () => {
  const both = { ...CONFIGURED, TELEGRAM_TRADING_BOT_TOKEN: 'tr', TELEGRAM_ALERTBOT_BOT_TOKEN: 'al' };
  const { calls, fetchImpl } = recorder();
  await sendTelegram('x', { channel: 'trading' }, { fetchImpl, env: both });
  await sendTelegram('x', { channel: 'trading' }, { fetchImpl, env: CONFIGURED });
  assert.match(calls[0].url, /\/bottr\/sendMessage$/);
  assert.match(calls[1].url, new RegExp(`/bot${TOKEN}/sendMessage$`));
});

test('alert channel (default) prefers TELEGRAM_ALERTBOT_BOT_TOKEN then TELEGRAM_BOT_TOKEN', async () => {
  const both = { ...CONFIGURED, TELEGRAM_TRADING_BOT_TOKEN: 'tr', TELEGRAM_ALERTBOT_BOT_TOKEN: 'al' };
  const { calls, fetchImpl } = recorder();
  await sendTelegram('x', {}, { fetchImpl, env: both });
  await sendTelegram('x', { channel: 'alert' }, { fetchImpl, env: CONFIGURED });
  assert.match(calls[0].url, /\/botal\/sendMessage$/);
  assert.match(calls[1].url, new RegExp(`/bot${TOKEN}/sendMessage$`));
});

test('a blank channel token falls through to the shared bot instead of failing', async () => {
  const env = { ...CONFIGURED, TELEGRAM_TRADING_BOT_TOKEN: '', TELEGRAM_ALERTBOT_BOT_TOKEN: '  ' };
  const { calls, fetchImpl } = recorder();
  await sendTelegram('x', { channel: 'trading' }, { fetchImpl, env });
  await sendTelegram('x', { channel: 'alert' }, { fetchImpl, env });
  assert.ok(calls.every((call) => call.url.includes(TOKEN)));
});

test('a channel with no token of its own uses the other bot only through TELEGRAM_BOT_TOKEN', async () => {
  const env = { TELEGRAM_CHAT_ID: '1', TELEGRAM_TRADING_BOT_TOKEN: 'tr' };
  const { calls, fetchImpl } = recorder();
  assert.equal(await sendTelegram('x', { channel: 'alert' }, { fetchImpl, env }), false);
  assert.equal(calls.length, 0);
});

test('the request carries a 10 second abort signal', async () => {
  const timeout = mock.method(AbortSignal, 'timeout');
  try {
    const { calls, fetchImpl } = recorder();
    await sendTelegram('x', {}, { fetchImpl, env: CONFIGURED });
    assert.deepEqual(timeout.mock.calls.map((call) => call.arguments), [[10_000]]);
    assert.ok(calls[0].init.signal instanceof AbortSignal);
  } finally {
    timeout.mock.restore();
  }
});

test('timeout, rejection, throw and non-2xx all return false and never throw', async () => {
  const failures: Array<() => Promise<Response>> = [
    async () => { throw new DOMException('The operation timed out', 'TimeoutError'); },
    async () => { throw new Error('ECONNRESET'); },
    async () => new Response('{"ok":false}', { status: 500 }),
    async () => new Response('{"ok":false}', { status: 401 }),
  ];
  for (const respond of failures) {
    const { fetchImpl } = recorder(respond);
    assert.equal(await sendTelegram('x', {}, { fetchImpl, env: CONFIGURED }), false);
  }
  const throwsSync = (() => { throw new Error('sync'); }) as unknown as typeof fetch;
  assert.equal(await sendTelegram('x', {}, { fetchImpl: throwsSync, env: CONFIGURED }), false);
});

test('a throwing logger cannot make sendTelegram throw', async () => {
  const log = (): void => { throw new Error('logger down'); };
  assert.equal(await sendTelegram('x', {}, { env: { ...CONFIGURED, TELEGRAM_DRY_RUN: '1' }, log }), true);
});

test('dry-run logs the card with a prefix, returns true, and never fetches', async () => {
  for (const flag of ['1', 'true', 'TRUE']) {
    const { calls, fetchImpl } = recorder();
    const logged: string[] = [];
    const env = { ...CONFIGURED, TELEGRAM_DRY_RUN: flag };
    const sent = await sendTelegram('<b>card</b>', { channel: 'trading' }, { fetchImpl, env, log: (line) => logged.push(line) });
    assert.equal(sent, true);
    assert.equal(calls.length, 0);
    assert.deepEqual(logged, ['[telegram dry-run] <b>card</b>']);
  }
});

test('dry-run flag may come from deps and falsy env values do not enable it', async () => {
  const logged: string[] = [];
  assert.equal(await sendTelegram('c', {}, { env: {}, dryRun: true, log: (line) => logged.push(line) }), true);
  assert.equal(logged.length, 1);
  const { calls, fetchImpl } = recorder();
  await sendTelegram('c', {}, { fetchImpl, env: { ...CONFIGURED, TELEGRAM_DRY_RUN: '0' } });
  assert.equal(calls.length, 1);
});

test('the token never appears in any logged string', async () => {
  const logged: string[] = [];
  const log = (line: string): void => { logged.push(line); };
  const { fetchImpl } = recorder(async () => { throw new Error(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`); });
  await sendTelegram('card', {}, { fetchImpl, env: CONFIGURED, log });
  await sendTelegram('card', {}, { env: { ...CONFIGURED, TELEGRAM_DRY_RUN: '1' }, log });
  assert.ok(logged.length > 0);
  assert.ok(logged.every((line) => !line.includes(TOKEN)));
});

test('sendAlert routes TRADE, SIGNAL and SETUP to the trading bot and everything else to the alert bot', async () => {
  const env = { ...CONFIGURED, TELEGRAM_TRADING_BOT_TOKEN: 'tr', TELEGRAM_ALERTBOT_BOT_TOKEN: 'al' };
  const { calls, fetchImpl } = recorder();
  for (const cls of ['TRADE', 'SIGNAL', 'SETUP', 'SYSTEM', 'MARKET', 'RESEARCH'] as const) {
    await sendAlert(alertOf({ class: cls }), 'html', { fetchImpl, env });
  }
  assert.deepEqual(calls.map((call) => call.url.match(/bot([^/]+)\//)?.[1]), ['tr', 'tr', 'tr', 'al', 'al', 'al']);
});

test('sendAlert is silent only below IMPORTANT severity', async () => {
  const { calls, fetchImpl } = recorder();
  for (const severity of ['INFO', 'WATCH', 'IMPORTANT', 'SIGNAL', 'CRITICAL'] as const) {
    await sendAlert(alertOf({ severity }), 'html', { fetchImpl, env: CONFIGURED });
  }
  assert.deepEqual(calls.map((call) => bodyOf(call).disable_notification), [true, true, false, false, false]);
});
