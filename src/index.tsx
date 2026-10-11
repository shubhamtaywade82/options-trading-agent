#!/usr/bin/env node
import 'dotenv/config';
import { render } from 'ink';
import { loadConfig } from './config.js';
import { buildRuntime } from './runtime/createRuntime.js';
import App from './ui/App.js';

/**
 * Entry point. Configuration is validated before any socket opens.
 *
 * On an interactive terminal the operator cockpit runs. Set UI=off, or pipe the output, for plain
 * log lines (useful under a process supervisor). SIGINT and SIGTERM stop the agent gracefully:
 * new entries cease and open positions are flattened, bounded by the shutdown timeout.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const cockpit = process.stdout.isTTY === true && process.env['UI'] !== 'off';
  const runtime = await buildRuntime(config, Date.now, { cockpit });
  const { orchestrator, logger } = runtime;

  let stopping: Promise<void> | undefined;
  const shutdown = (signal: NodeJS.Signals): void => {
    stopping ??= (async () => {
      logger.warn('shutdown requested', { signal });
      await orchestrator.stop();
      restoreScreen();
      process.exit(0);
    })();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  if (!cockpit) {
    await orchestrator.start();
    return;
  }

  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[H');
  }
  const instance = render(<App runtime={runtime} />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
  restoreScreen();
  await orchestrator.stop().catch(() => undefined);
}

function restoreScreen(): void {
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  }
}

main().catch((error: unknown) => {
  restoreScreen();
  console.error('fatal:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
