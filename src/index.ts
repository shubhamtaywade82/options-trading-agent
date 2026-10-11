import 'dotenv/config';
import { loadConfig } from './config.js';
import { buildRuntime } from './runtime/createRuntime.js';

/**
 * Entry point. Configuration is validated before any socket opens. SIGINT and
 * SIGTERM request an orderly stop: new entries cease and open positions are
 * flattened, bounded by the shutdown timeout.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const { orchestrator, logger } = await buildRuntime(config);

  let stopping: Promise<void> | undefined;
  const shutdown = (signal: NodeJS.Signals): void => {
    stopping ??= (async () => {
      logger.warn('shutdown requested', { signal });
      await orchestrator.stop();
      process.exit(0);
    })();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await orchestrator.start();
}

main().catch((error: unknown) => {
  console.error('fatal:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
