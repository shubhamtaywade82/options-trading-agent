/**
 * Current microstructure state per symbol from recorded flow data, plus how often each label occurred over the recording.
 *
 *   npx tsx scripts/microstructure-state.ts [--dir data/market] [--symbols BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT]
 *                                           [--window 15] [--baseline 240]
 *
 * Descriptive only: label frequencies show whether the classifier is degenerate (one label 95% of the time), not whether any
 * label predicts returns. Testing that is a pre-registered event-study question (src/marketdata/EventStudy.ts).
 */
import path from 'node:path';
import { cleanRecords } from '../src/marketdata/EventStudy.js';
import { loadMinutes } from '../src/marketdata/loadMinutes.js';
import { microstructureState } from '../src/marketdata/MicrostructureState.js';
import type { MinuteRecord } from '../src/marketdata/MinuteAggregator.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const dir = path.resolve(arg('dir', 'data/market'));
const symbols = arg('symbols', 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const options = { windowMinutes: Number(arg('window', '15')), baselineMinutes: Number(arg('baseline', '240')) };
const need = options.windowMinutes + options.baselineMinutes;
const f = (x: number | null, d = 2): string => (x === null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d));

/** Splits cleaned records into contiguous runs so a state is never computed across a recording gap. */
function runs(records: readonly MinuteRecord[]): MinuteRecord[][] {
  const out: MinuteRecord[][] = [];
  let run: MinuteRecord[] = [];
  for (const r of records) {
    if (run.length > 0 && r.t - run[run.length - 1].t !== 60_000) { out.push(run); run = []; }
    run.push(r);
  }
  if (run.length > 0) out.push(run);
  return out;
}

console.log(`MICROSTRUCTURE STATE · ${dir} · window ${options.windowMinutes}m, baseline ${options.baselineMinutes}m\n`);
for (const symbol of symbols) {
  const clean = cleanRecords(loadMinutes(dir, symbol));
  if (clean.length === 0) { console.log(`${symbol}: no recorded minutes`); continue; }
  const now = microstructureState(clean, options);
  if (now.status === 'OK') {
    const s = now.state;
    console.log(`${symbol} @ ${new Date(s.t).toISOString()}  ${s.priceOiRegime} / ${s.flowRegime}`);
    console.log(`  price ${f(s.priceChangeBps, 1)}bps (z ${f(s.priceZ)})  OI ${f(s.oiChangePct, 3)}% (z ${f(s.oiZ)})  taker delta ${f(s.takerDelta, 3)} (z ${f(s.takerDeltaZ)})`);
    console.log(`  liq long $${f(s.liqLongNotional, 0)} short $${f(s.liqShortNotional, 0)} (z ${f(s.liquidationZ)})  book ${f(s.bookImbalance, 3)}  spread ${f(s.spreadBps, 2)}bps`);
  } else {
    console.log(`${symbol}: ${now.reason}`);
  }

  // Label frequency, sampled every window (non-overlapping) inside each contiguous run
  const counts = new Map<string, number>();
  let total = 0;
  for (const run of runs(clean)) {
    for (let end = need; end <= run.length; end += options.windowMinutes) {
      const r = microstructureState(run.slice(end - need, end), options);
      if (r.status !== 'OK') continue;
      const key = `${r.state.priceOiRegime} / ${r.state.flowRegime}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total += 1;
    }
  }
  console.log(`  label frequency over ${total} windows (${(clean.length / 1440).toFixed(1)} days recorded):`);
  for (const [k, c] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(36)} ${String(c).padStart(5)}  ${((c / total) * 100).toFixed(1)}%`);
  console.log('');
}
