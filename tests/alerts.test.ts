import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { alertText, createAlertSink } from '../src/ops/alerts.js';

const SILENT = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('operator alerts', () => {
  it('posts alert-worthy events as one plain-text line and ignores routine ones', async () => {
    const posted: Array<[string, string]> = [];
    const sink = createAlertSink('https://ntfy.sh/topic', SILENT, async (url, body) => {
      posted.push([url, body]);
      return { ok: true, status: 200 };
    });
    sink('signal_detected', { underlying: 'NIFTY' });
    sink('daily_loss_breach', { dayPnlInr: -40391.4, limitInr: 37692.13, nested: { skip: true } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(posted, [['https://ntfy.sh/topic', 'daily_loss_breach dayPnlInr=-40391.4 limitInr=37692.13']]);
  });

  it('logs a failed delivery instead of throwing into the trading path', async () => {
    const warnings: string[] = [];
    const logger = { ...SILENT, warn: (message: string) => warnings.push(message) };
    const sink = createAlertSink('https://ntfy.sh/topic', logger, async () => {
      throw new Error('network down');
    });
    assert.doesNotThrow(() => sink('halted', { underlying: 'SENSEX' }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings, ['alert delivery failed']);
  });

  it('formats only scalar payload fields', () => {
    assert.equal(alertText('exit_rejected', { underlying: 'NIFTY', code: 'DH-906', detail: { a: 1 } }), 'exit_rejected underlying=NIFTY code=DH-906');
  });
});
