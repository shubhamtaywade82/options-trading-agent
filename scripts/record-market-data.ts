/**
 * Records Binance USD-M derivatives/flow data to one JSONL file per symbol per UTC day (data/market/SYMBOL-YYYY-MM-DD.jsonl),
 * aggregated to one record per minute: aggressor-side trade flow, liquidations by side, book spread and imbalance,
 * mark/index/funding, open interest and taker ratio. Public streams only; no keys; separate from the trading loop.
 *
 *   npx tsx scripts/record-market-data.ts [--symbols BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT] [--dir data/market]
 *                                         [--poll-seconds 300] [--self-check 30]
 *
 * --self-check N  connects for N seconds, prints how many events of each type parsed, and exits (run this first: it proves the
 *                 stream endpoints and formats still match; a zero for trades, book or mark means drift or a blocked connection).
 * Leave it running (tmux/systemd/docker). It reconnects with backoff, reconnects if the feed goes silent, and flushes on SIGINT.
 * Storage is roughly 0.5 KB per symbol per minute (~3 MB per symbol per week).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { MinuteAggregator, type MinuteRecord, type StreamEvent } from '../src/marketdata/MinuteAggregator.js';
import { parseOpenInterest, parseStreamMessage, parseTakerRatio } from '../src/marketdata/parsers.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const symbols = arg('symbols', 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const dir = path.resolve(arg('dir', 'data/market'));
const pollMs = Math.max(30, Number(arg('poll-seconds', '300'))) * 1000;
const selfCheckSeconds = Number(arg('self-check', '0'));
const selfCheck = selfCheckSeconds > 0;

// Binance split the USD-M websocket endpoints by traffic type. Probed on 2026-09-30: the legacy /stream and /ws URLs no longer
// deliver aggTrade, markPrice or forceOrder (only depth and the raw trade stream still arrive there), /market serves them, and
// /public serves the book. Liquidations come from the all-market stream and are filtered to the tracked symbols.
const MARKET_STREAMS = [...symbols.flatMap((s) => [`${s.toLowerCase()}@aggTrade`, `${s.toLowerCase()}@markPrice@1s`]), '!forceOrder@arr'].join('/');
const PUBLIC_STREAMS = symbols.map((s) => `${s.toLowerCase()}@depth5@500ms`).join('/');
const FEEDS = [
  { name: 'market', url: `wss://fstream.binance.com/market/stream?streams=${MARKET_STREAMS}` },
  { name: 'public', url: `wss://fstream.binance.com/public/stream?streams=${PUBLIC_STREAMS}` },
] as const;
const SILENCE_MS = 60_000;
const TRACKED = new Set(symbols);

const aggregator = new MinuteAggregator();
const counts: Record<string, number> = { trade: 0, liquidation: 0, book: 0, mark: 0, oi: 0, taker: 0, unknown: 0, ignored: 0, badJson: 0, written: 0 };
let stopping = false;

function write(records: readonly MinuteRecord[]): void {
  if (selfCheck || records.length === 0) return;
  mkdirSync(dir, { recursive: true });
  for (const rec of records) {
    const day = new Date(rec.t).toISOString().slice(0, 10);
    appendFileSync(path.join(dir, `${rec.symbol}-${day}.jsonl`), JSON.stringify(rec) + '\n');
    counts.written += 1;
  }
}

function ingest(ev: StreamEvent): void {
  if (ev.kind === 'liquidation' && !TRACKED.has(ev.symbol)) { counts.ignored += 1; return; }
  counts[ev.kind] += 1;
  write(aggregator.push(ev));
}

/** One websocket with its own reconnect backoff and silence watchdog, so a dead feed cannot hide behind a live one. */
class Feed {
  private socket: WebSocket | null = null;
  private backoff = 1_000;
  private lastMessageAt = Date.now();

  constructor(private readonly name: string, private readonly url: string) {}

  start(): void {
    this.connect();
    setInterval(() => {
      if (Date.now() - this.lastMessageAt > SILENCE_MS) {
        console.log(`[${this.name}] no messages for 60s; forcing reconnect`);
        this.lastMessageAt = Date.now();
        try { this.socket?.close(); } catch { /* already closed */ }
      }
    }, 15_000);
  }

  stop(): void {
    try { this.socket?.close(); } catch { /* already closed */ }
  }

  private connect(): void {
    if (stopping) return;
    const ws = new WebSocket(this.url);
    this.socket = ws;
    ws.onopen = () => { this.backoff = 1_000; this.lastMessageAt = Date.now(); console.log(`[${this.name}] connected`); };
    ws.onmessage = (m: MessageEvent) => {
      this.lastMessageAt = Date.now();
      let raw: unknown;
      try { raw = JSON.parse(String(m.data)); } catch { counts.badJson += 1; return; }
      const ev = parseStreamMessage(raw);
      if (ev) ingest(ev); else counts.unknown += 1;
    };
    ws.onerror = () => { /* onclose follows and handles the reconnect */ };
    ws.onclose = () => {
      if (stopping) return;
      console.log(`[${this.name}] disconnected; reconnecting in ${this.backoff / 1000}s`);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
  }
}

const feeds = FEEDS.map((f) => new Feed(f.name, f.url));

async function poll(): Promise<void> {
  for (const symbol of symbols) {
    try {
      const oi = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`);
      if (oi.ok) { const ev = parseOpenInterest(await oi.json()); if (ev) ingest({ ...ev, time: Date.now() }); }
      const tk = await fetch(`https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${symbol}&period=5m&limit=1`);
      if (tk.ok) { const ev = parseTakerRatio(symbol, await tk.json()); if (ev) ingest({ ...ev, time: Date.now() }); }
    } catch (err) {
      console.log(`poll ${symbol} failed: ${(err as Error).message}`);
    }
  }
}

function report(): void {
  console.log(`events: ${JSON.stringify(counts)} · late ${aggregator.late} · rejected ${aggregator.rejected}`);
}

function shutdown(code = 0): void {
  stopping = true;
  write(aggregator.flush(Date.now(), true));
  for (const f of feeds) f.stop();
  report();
  process.exit(code);
}

for (const f of feeds) f.start();
void poll();
setInterval(() => write(aggregator.flush(Date.now() - 2_000)), 10_000);
setInterval(() => void poll(), pollMs);
if (!selfCheck) setInterval(report, 5 * 60_000);

if (selfCheck) {
  setTimeout(() => {
    report();
    const ok = counts.trade > 0 && counts.book > 0 && counts.mark > 0;
    console.log(ok
      ? `SELF-CHECK OK (liquidations on tracked symbols ${counts.liquidation}: zero is normal in a short window; open interest ${counts.oi}, taker ${counts.taker})`
      : 'SELF-CHECK FAILED: no trades, book or mark events parsed. Blocked network, or the stream format/endpoints changed again.');
    shutdown(ok ? 0 : 1);
  }, selfCheckSeconds * 1000);
} else {
  console.log(`recording ${symbols.join(',')} to ${dir} (Ctrl-C to stop)`);
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
}
