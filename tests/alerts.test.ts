import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALERT_CLASSES,
  ALERT_SEVERITIES,
  NotificationEngine,
  SEVERITY_RANK,
  defaultSubscriptions,
  makeAlert,
  parseSubscriptions,
  type AlertClass,
  type AlertEvent,
} from '../src/ops/alerts.js';

const T0 = 1_000_000;

const alert = (over: Partial<AlertEvent> = {}): AlertEvent =>
  makeAlert({
    at: T0, class: 'MARKET', severity: 'IMPORTANT', symbol: 'SOLUSDT', title: 'REGIME CHANGE',
    body: 'RANGE -> TREND_UP', fingerprint: 'MARKET:SOLUSDT:regime', stateFrom: 'RANGE', stateTo: 'TREND_UP',
    payload: {}, ...over,
  });

const DEFAULT_COOLDOWN_MS: Readonly<Record<AlertClass, number>> = {
  SYSTEM: 15_000, MACRO: 60_000, MARKET: 300_000, LEVEL: 600_000, SETUP: 300_000,
  SIGNAL: 0, TRADE: 0, RESEARCH: 72_000_000,
};

test('taxonomy has 8 classes x 5 severities with ascending rank', () => {
  assert.equal(ALERT_CLASSES.length, 8);
  assert.equal(ALERT_SEVERITIES.length, 5);
  assert.deepEqual(ALERT_SEVERITIES.map((s) => SEVERITY_RANK[s]), [0, 1, 2, 3, 4]);
});

test('makeAlert fills id, at and payload defaults and keeps a given id', () => {
  const made = makeAlert({ class: 'SYSTEM', severity: 'INFO', title: 't', body: 'b', fingerprint: 'f' });
  const other = makeAlert({ class: 'SYSTEM', severity: 'INFO', title: 't', body: 'b', fingerprint: 'f' });

  assert.ok(made.id.length > 0);
  assert.notEqual(made.id, other.id);
  assert.ok(Number.isFinite(made.at) && made.at > 0);
  assert.deepEqual(made.payload, {});
  assert.equal(alert({ id: 'fixed' }).id, 'fixed');
});

test('emits the first observation of a fingerprint', () => {
  assert.equal(new NotificationEngine().submit(alert()).action, 'emitted');
});

test('suppresses the same fingerprint and stateTo inside the cooldown', () => {
  const engine = new NotificationEngine();
  engine.submit(alert());
  const decision = engine.submit(alert({ id: 'a2', at: T0 + 1_000 }));

  assert.equal(decision.action, 'suppressed');
  assert.equal(decision.reason, 'DEDUPE');
});

test('dedupe boundary: suppressed 1 ms before the cooldown, re-emitted exactly at it', () => {
  const cooldown = DEFAULT_COOLDOWN_MS.MARKET;
  const engine = new NotificationEngine();
  engine.submit(alert());

  assert.equal(engine.submit(alert({ at: T0 + cooldown - 1 })).action, 'suppressed');
  assert.equal(engine.submit(alert({ at: T0 + cooldown })).action, 'emitted');
});

test('cooldown is measured from the last emission, not the last suppressed repeat', () => {
  const engine = new NotificationEngine();
  engine.submit(alert());
  engine.submit(alert({ at: T0 + 200_000 }));

  assert.equal(engine.submit(alert({ at: T0 + 300_000 })).action, 'emitted');
});

test('a changed stateTo inside the cooldown re-emits', () => {
  const engine = new NotificationEngine();
  engine.submit(alert());
  const decision = engine.submit(alert({ at: T0 + 1, stateFrom: 'TREND_UP', stateTo: 'RANGE' }));

  assert.equal(decision.action, 'emitted');
});

test('per-class default cooldowns hold at the boundary', () => {
  for (const cls of ALERT_CLASSES) {
    const cooldown = DEFAULT_COOLDOWN_MS[cls];
    const engine = new NotificationEngine();
    const fingerprint = `${cls}:fp`;
    engine.submit(alert({ class: cls, fingerprint, stateTo: 'S', symbol: undefined }));
    const inside = engine.submit(alert({ class: cls, fingerprint, stateTo: 'S', symbol: undefined, at: T0 + Math.max(cooldown - 1, 0) }));
    const atEdge = engine.submit(alert({ class: cls, fingerprint, stateTo: 'S', symbol: undefined, at: T0 + cooldown }));

    assert.equal(inside.action, cooldown === 0 ? 'emitted' : 'suppressed', `${cls} inside`);
    assert.equal(atEdge.action, 'emitted', `${cls} at edge`);
  }
});

test('SIGNAL and TRADE never dedupe on time: identical fingerprint+state in the same ms is emitted twice', () => {
  // Deliberate difference from crypto-agent, which suppressed identical fingerprint+state until stateTo changed.
  for (const cls of ['SIGNAL', 'TRADE'] as const) {
    const engine = new NotificationEngine();
    const event = alert({ class: cls, fingerprint: `${cls}:x`, stateTo: 'OPEN' });

    assert.equal(engine.submit(event).action, 'emitted');
    assert.equal(engine.submit(event).action, 'emitted');
    assert.equal(engine.submit({ ...event, at: event.at - 5_000 }).action, 'emitted');
  }
});

test('cooldownMs options override the defaults', () => {
  const engine = new NotificationEngine(undefined, { cooldownMs: { MARKET: 10 } });
  engine.submit(alert());

  assert.equal(engine.submit(alert({ at: T0 + 9 })).action, 'suppressed');
  assert.equal(engine.submit(alert({ at: T0 + 10 })).action, 'emitted');
});

test('an event without a timestamp is timed by the injected clock', () => {
  let clock = T0;
  const engine = new NotificationEngine(undefined, { now: () => clock });
  engine.submit(alert({ at: 0 }));
  clock = T0 + 100;
  assert.equal(engine.submit(alert({ at: 0 })).action, 'suppressed');
  clock = T0 + DEFAULT_COOLDOWN_MS.MARKET;
  assert.equal(engine.submit(alert({ at: 0 })).action, 'emitted');
});

test('dedupe memory is bounded: the oldest fingerprints are forgotten', () => {
  const engine = new NotificationEngine();
  engine.submit(alert({ fingerprint: 'fp-0' }));
  for (let i = 1; i <= 2_000; i++) engine.submit(alert({ fingerprint: `fp-${i}` }));

  assert.equal(engine.submit(alert({ fingerprint: 'fp-0' })).action, 'emitted');
  assert.equal(engine.submit(alert({ fingerprint: 'fp-2000' })).action, 'suppressed');
});

const levelAlert = (stateTo: string, severity: 'WATCH' | 'IMPORTANT'): AlertEvent =>
  alert({ class: 'LEVEL', severity, fingerprint: 'LEVEL:SOLUSDT:res', stateTo, payload: { kind: stateTo } });

test('LEVEL APPROACHING is suppressed by default, REACHED is emitted', () => {
  const engine = new NotificationEngine();
  const approaching = engine.submit(levelAlert('APPROACHING', 'WATCH'));

  assert.equal(approaching.reason, 'LEVEL_APPROACHING');
  assert.equal(engine.submit(levelAlert('REACHED', 'IMPORTANT')).action, 'emitted');
});

test('class subscription off suppresses with reason CLASS', () => {
  const subs = { ...defaultSubscriptions(), classes: { ...defaultSubscriptions().classes, MARKET: false } };
  assert.equal(new NotificationEngine(subs).submit(alert()).reason, 'CLASS');
});

test('disabled symbol suppresses symbol-scoped classes only', () => {
  const engine = new NotificationEngine({ ...defaultSubscriptions(), symbols: { SOLUSDT: false } });

  assert.equal(engine.submit(alert()).reason, 'SYMBOL');
  assert.equal(engine.submit(alert({ class: 'TRADE', fingerprint: 'TRADE:sol' })).action, 'emitted');
});

test('SYSTEM CRITICAL is emitted despite disabled symbol and a high severity floor', () => {
  const engine = new NotificationEngine({ ...defaultSubscriptions(), symbols: { SOLUSDT: false }, minSeverity: 'CRITICAL' });
  const decision = engine.submit(alert({ class: 'SYSTEM', severity: 'CRITICAL', fingerprint: 'SYSTEM:stale', stateTo: 'STALE' }));

  assert.equal(decision.action, 'emitted');
});

test('minSeverity suppresses lower severities but not SYSTEM CRITICAL', () => {
  const engine = new NotificationEngine({ ...defaultSubscriptions(), minSeverity: 'IMPORTANT' });
  const watch = engine.submit(alert({ class: 'SETUP', severity: 'WATCH', fingerprint: 'SETUP:w', stateTo: 'FORMING' }));

  assert.equal(watch.reason, 'SEVERITY');
  assert.equal(engine.submit(alert({ class: 'SYSTEM', severity: 'CRITICAL', fingerprint: 'SYSTEM:ws', stateTo: 'DOWN' })).action, 'emitted');
  assert.equal(engine.submit(alert({ class: 'SYSTEM', severity: 'IMPORTANT', fingerprint: 'SYSTEM:x', stateTo: 'X' })).action, 'emitted');
});

test('setup developing and liquidity sweeps toggles suppress with reason CLASS', () => {
  const subs = { ...defaultSubscriptions(), setupDeveloping: false, liquiditySweeps: false };
  const engine = new NotificationEngine(subs);
  const developing = engine.submit(alert({ class: 'SETUP', severity: 'IMPORTANT', fingerprint: 'SETUP:d', stateTo: 'FORMING' }));
  const sweep = engine.submit(alert({ class: 'LEVEL', severity: 'IMPORTANT', fingerprint: 'LEVEL:s', stateTo: 'REACTION' }));

  assert.equal(developing.reason, 'CLASS');
  assert.equal(sweep.reason, 'CLASS');
});

test('confirmed SIGNAL below the confidence or RR gate is suppressed', () => {
  const engine = new NotificationEngine({ ...defaultSubscriptions(), minimumSignalConfidence: 0.75, minimumRr: 2.5 });
  const signal = (fingerprint: string, payload: Record<string, unknown>): AlertEvent =>
    alert({ class: 'SIGNAL', severity: 'SIGNAL', fingerprint, stateTo: 'CONFIRMED', payload });

  assert.equal(engine.submit(signal('s1', { confidence: 0.5, rr: 3 })).reason, 'CONFIDENCE');
  assert.equal(engine.submit(signal('s2', { confidence: 0.9, rr: 1.2 })).reason, 'RR');
  assert.equal(engine.submit(signal('s3', { confidence: 0.9, rr: 3 })).action, 'emitted');
  assert.equal(engine.submit(signal('s4', {})).action, 'emitted');
});

test('default subscriptions enable everything relevant with the reference severity floor', () => {
  const subs = defaultSubscriptions();

  assert.ok(ALERT_CLASSES.every((c) => subs.classes[c]));
  assert.equal(subs.minSeverity, 'WATCH');
  assert.equal(subs.levelApproaching, false);
  assert.equal(subs.liquiditySweeps, true);
  assert.equal(subs.setupDeveloping, true);
});

test('parseSubscriptions merges partial operator JSON onto defaults', () => {
  const subs = parseSubscriptions({
    notifications: {
      market: false, SETUP: false, level_approaching: true, liquidity_sweeps: false, setup_developing: false,
      minSeverity: 'IMPORTANT', minimum_signal_confidence: 0.6, minimum_rr: 1.5,
      symbols: { solusdt: false, ethusdt: { enabled: false }, btcusdt: true, xrpusdt: 'nope' },
    },
  });

  assert.equal(subs.classes.MARKET, false);
  assert.equal(subs.classes.SETUP, false);
  assert.equal(subs.classes.TRADE, true);
  assert.equal(subs.levelApproaching, true);
  assert.equal(subs.liquiditySweeps, false);
  assert.equal(subs.setupDeveloping, false);
  assert.equal(subs.minSeverity, 'IMPORTANT');
  assert.equal(subs.minimumSignalConfidence, 0.6);
  assert.equal(subs.minimumRr, 1.5);
  assert.deepEqual(subs.symbols, { SOLUSDT: false, ETHUSDT: false, BTCUSDT: true });
});

test('parseSubscriptions accepts the flat (unwrapped) shape and a JSON string', () => {
  assert.equal(parseSubscriptions({ trade: false }).classes.TRADE, false);
  assert.equal(parseSubscriptions('{"notifications":{"macro":false}}').classes.MACRO, false);
});

test('parseSubscriptions returns defaults for garbage and never throws', () => {
  const garbage: unknown[] = [
    undefined, null, 42, true, [], ['x'], 'not json', '{"unterminated', '', Symbol('s'),
    { notifications: 'oops' }, { notifications: [] }, { classes: 5 }, { symbols: 'x' }, { symbols: [1, 2] },
    { minSeverity: 'LOUD' }, { minSeverity: 7 }, { minimum_rr: '2' }, { minimum_rr: Number.NaN },
    { minimum_signal_confidence: Infinity }, { level_approaching: 'yes' }, { market: 'off' },
  ];

  for (const input of garbage) {
    assert.deepEqual(parseSubscriptions(input), defaultSubscriptions(), String(typeof input));
  }
});
