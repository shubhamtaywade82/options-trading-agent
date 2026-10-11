import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { after, describe, it } from 'node:test';
import { createElement } from 'react';
import { render, type Instance } from 'ink';
import type { Runtime } from '../src/runtime/createRuntime.js';
import App, { isConfirmation } from '../src/ui/App.js';
import { fakeRuntime } from './support/fakeRuntime.js';

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class FakeStdout extends EventEmitter {
  columns = 170;
  rows = 48;
  isTTY = false;
  readonly chunks: string[] = [];
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }
  get text(): string {
    return plain(this.chunks.join(''));
  }
}

/** Follows Ink 5's contract: keypresses are queued and announced with 'readable', then drained with read(). */
class FakeStdin extends EventEmitter {
  isTTY = true;
  private readonly queue: string[] = [];
  read(): string | null {
    return this.queue.shift() ?? null;
  }
  setRawMode(_enabled: boolean): this {
    return this;
  }
  setEncoding(_encoding: string): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  press(text: string): void {
    this.queue.push(text);
    this.emit('readable');
  }
}

/**
 * Renders the app into a fake terminal, runs the steps, and always unmounts: a failed assertion
 * must not leave the app's refresh timer running, or the test process never exits.
 */
async function withTerminal(
  runtime: Runtime,
  options: { columns?: number; rows?: number },
  steps: (terminal: { stdout: FakeStdout; press: (text: string) => void }) => Promise<void>,
): Promise<void> {
  const stdout = new FakeStdout();
  stdout.columns = options.columns ?? 170;
  stdout.rows = options.rows ?? 48;
  const stdin = new FakeStdin();
  const instance: Instance = render(createElement(App, { runtime }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  try {
    await wait(80);
    await steps({ stdout, press: (text) => stdin.press(text) });
  } finally {
    instance.unmount();
  }
}

describe('operator cockpit (Ink app, fake terminal)', () => {
  const stops: Array<() => Promise<void>> = [];
  after(async () => {
    for (const stop of stops) {
      await stop();
    }
  });

  it('draws the cockpit and needs two presses before changing the entry block', async () => {
    const { runtime, stop } = fakeRuntime();
    stops.push(stop);
    await withTerminal(runtime, {}, async ({ stdout, press }) => {
      assert.match(stdout.text, /NSE INDEX OPTIONS/);
      assert.match(stdout.text, /UNDERLYINGS \(1\)/);
      assert.match(stdout.text, /entries OPEN/);

      press('k');
      await wait(40);
      assert.match(stdout.text, /press k again within 5s to toggle the entry block/);
      assert.equal(runtime.orchestrator.snapshot().day.killSwitchReason, undefined, 'one press must not change anything');

      press('k');
      await wait(40);
      assert.match(stdout.text, /new entries blocked; press k again to clear/);
      assert.match(stdout.text, /entries BLOCKED/);
    });
  });

  it('turns ctrl+c into a confirmed stop rather than an unmount', async () => {
    const { runtime, stop } = fakeRuntime();
    stops.push(stop);
    await withTerminal(runtime, {}, async ({ stdout, press }) => {
      press('\u0003');
      await wait(40);
      assert.match(stdout.text, /press s again within 5s to stop/);
      assert.equal(runtime.orchestrator.snapshot().phase, 'RUNNING', 'a single press must not stop the agent');
    });
  });

  it('shows a resize notice instead of a broken frame on a small terminal', async () => {
    const { runtime, stop } = fakeRuntime();
    stops.push(stop);
    await withTerminal(runtime, { columns: 100, rows: 30 }, async ({ stdout }) => {
      assert.match(stdout.text, /Terminal too small for the operator cockpit/);
      assert.doesNotMatch(stdout.text, /NSE INDEX OPTIONS/);
    });
  });
});

describe('isConfirmation', () => {
  const open = { action: 'stop' as const, symbol: undefined, expiresAt: 10_000 };

  it('confirms the same action on the same target inside the window', () => {
    assert.equal(isConfirmation(open, 'stop', undefined, 9_999), true);
  });

  it('does not confirm once the window has closed, even if the render still shows it armed', () => {
    assert.equal(isConfirmation(open, 'stop', undefined, 10_000), false);
    assert.equal(isConfirmation(open, 'stop', undefined, 10_400), false);
  });

  it('does not confirm a different action or a different underlying', () => {
    const close = { action: 'close' as const, symbol: 'NIFTY', expiresAt: 10_000 };
    assert.equal(isConfirmation(close, 'close', 'SENSEX', 9_000), false);
    assert.equal(isConfirmation(close, 'block', undefined, 9_000), false);
    assert.equal(isConfirmation(undefined, 'stop', undefined, 9_000), false);
  });
});
