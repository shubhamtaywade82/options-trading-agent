import type { BinanceClient } from '@nemesis-oss/binance-sdk';
import { SmcMlRuntime } from './SmcMlRuntime.js';
import type { SmcMlCycle } from './SmcMlRuntime.js';
import type { SMCFrame } from './types.js';
import { parseMarkPriceEvent } from './SmcMarkPrice.js';

export interface SmcMlRunnerOptions {
  symbols: string[];
  timeframes?: SMCFrame[];
  autoExecute: boolean;
  candleLimit?: number;
}

export interface SmcMlRunResult {
  symbol: string;
  cycle: SmcMlCycle;
  execution?: unknown;
  triggeredBy: SMCFrame;
}

const DEFAULT_TIMEFRAMES: SMCFrame[] = ['5m', '15m', '1h', '4h'];

export function smcRunnerLockKey(symbol: string, _timeframe: SMCFrame): string {
  return symbol.toUpperCase();
}

export class SmcMlRunner {
  private readonly runtime: SmcMlRuntime;
  private readonly options: Required<SmcMlRunnerOptions>;
  private readonly active = new Map<string, Promise<void>>();
  private userStreamRestarting = false;

  constructor(
    private readonly client: BinanceClient,
    runtime: SmcMlRuntime,
    options: SmcMlRunnerOptions,
  ) {
    this.runtime = runtime;
    this.options = {
      symbols: options.symbols.map((s) => s.toUpperCase()),
      timeframes: options.timeframes ?? DEFAULT_TIMEFRAMES,
      autoExecute: options.autoExecute,
      candleLimit: options.candleLimit ?? 300,
    };
  }

  async start(onResult?: (result: SmcMlRunResult) => void): Promise<void> {
    await this.client.syncTime();

    if (this.options.autoExecute) {
      const userEvents = this.client.futures.wsUser as unknown as {
        on(event: string, listener: (event: unknown) => void): unknown;
      };
      const executionUserStream = this.client.futures.wsUser as unknown as Parameters<
        typeof this.client.futures.execution.setUserStream
      >[0];
      this.client.futures.execution.setUserStream(executionUserStream);
      userEvents.on('ORDER_TRADE_UPDATE', (event: unknown) => {
        this.runtime.handleOrderTradeUpdate(event);
      });
      userEvents.on('ACCOUNT_UPDATE', (event: unknown) => {
        this.runtime.handleAccountUpdate(event);
      });
      userEvents.on('listenKeyExpired', () => {
        if (this.userStreamRestarting) return;
        this.userStreamRestarting = true;
        void this.client.startUserStream()
          .catch((error) => {
            console.error(JSON.stringify({
              event: 'smc.user_stream_restart_failed',
              error: error instanceof Error ? error.message : String(error),
            }));
          })
          .finally(() => {
            this.userStreamRestarting = false;
          });
      });
      await this.client.startUserStream();
    }

    const marketStreams = this.options.symbols.flatMap((symbol) =>
      this.options.timeframes.map((tf) => this.client.futures.ws.kline(symbol, tf)),
    );
    const lifecycleStreams = this.options.autoExecute
      ? this.options.symbols.map((symbol) => this.client.futures.ws.markPrice(symbol, '1s'))
      : [];

    const streams = [...marketStreams, ...lifecycleStreams];

    const marketEvents = this.client.futures.ws as unknown as {
      on(event: 'message', listener: (stream: string, payload: unknown) => void): unknown;
    };
    marketEvents.on('message', (stream: string, payload: unknown) => {
      if (stream.includes('@markPrice@')) {
        const market = parseMarkPriceEvent(payload);
        if (!market || !this.options.symbols.includes(market.symbol)) return;
        const symbol = market.symbol;
        const key = smcRunnerLockKey(symbol, '5m');
        if (this.active.has(key)) return;
        const promise = this.runtime.onMarkPrice(symbol, market.markPrice)
          .catch((error) => {
            console.error(JSON.stringify({ event: 'smc.lifecycle_error', symbol, error: error instanceof Error ? error.message : String(error) }));
          })
          .finally(() => this.active.delete(key))
          .then(() => undefined);
        this.active.set(key, promise);
        return;
      }

      if (!stream.includes('@kline_')) return;
      const event = payload as {
        e?: string;
        s?: string;
        k?: { x?: boolean; i?: string };
      };
      if (event.e !== 'kline' || event.k?.x !== true || !event.s || !event.k.i) return;

      const timeframe = event.k.i as SMCFrame;
      if (!this.options.timeframes.includes(timeframe)) return;
      const symbol = event.s.toUpperCase();
      if (!this.options.symbols.includes(symbol)) return;

      const key = smcRunnerLockKey(symbol, timeframe);
      if (this.active.has(key)) return;

      const promise = this.run(symbol, timeframe, onResult)
        .catch((error) => {
          console.error('[smc-ml]', symbol, timeframe, error);
        })
        .finally(() => this.active.delete(key));

      this.active.set(key, promise);
    });

    await this.client.futures.ws.subscribe(streams);
  }

  stop(): void {
    this.client.futures.ws.close();
    if (this.options.autoExecute) this.client.closeUserStream();
  }

  private async run(
    symbol: string,
    triggeredBy: SMCFrame,
    onResult?: (result: SmcMlRunResult) => void,
  ): Promise<void> {
    const cycle = await this.runtime.analyze(symbol, Date.now());
    const execution = this.options.autoExecute
      ? await this.runtime.execute(cycle)
      : undefined;

    onResult?.({ symbol, cycle, execution, triggeredBy });
  }
}

