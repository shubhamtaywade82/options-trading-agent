/**
 * Pre-registered event study on recorded flow data (data/market, written by scripts/record-market-data.ts).
 *
 *   npx tsx scripts/analyze-flow.ts [--dir data/market] [--symbols BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT] [--cost-bps 16]
 *
 * Hypotheses H1 (liquidation flush reverses), H2 (aggressor flow continues), H4 (book imbalance predicts direction) are fixed in
 * src/marketdata/EventStudy.ts and must not be edited after looking at results; add a new id instead. The trigger threshold comes
 * from the first half of the recording and events are counted only in the second half. Each hypothesis is tested at 5/15/30/60 minute
 * horizons, so the significance bar is Bonferroni-corrected over all of them. A hit is a lead, not proof: confirm it on later data.
 */
import { loadMinutes } from '../src/marketdata/loadMinutes.js';
import { cleanRecords, eventStudy, HORIZONS_MINUTES, HYPOTHESES, poolRows, twoSidedP, type StudyRow } from '../src/marketdata/EventStudy.js';
import path from 'node:path';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const dir = path.resolve(arg('dir', 'data/market'));
const symbols = arg('symbols', 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const costBps = Number(arg('cost-bps', '16'));
const MIN_EVENTS = 30;
const MIN_DAYS = 14;
const tests = HYPOTHESES.length * HORIZONS_MINUTES.length;
const alpha = 0.05 / tests;

console.log(`FLOW EVENT STUDY · ${dir}\n`);
const bySymbol = new Map<string, StudyRow[]>();
for (const symbol of symbols) {
  const records = loadMinutes(dir, symbol);
  const clean = cleanRecords(records);
  const days = records.length > 1 ? (records[records.length - 1].t - records[0].t) / 86_400_000 : 0;
  const coverage = records.length > 1 ? (records.length / ((records[records.length - 1].t - records[0].t) / 60_000 + 1)) * 100 : 0;
  console.log(`${symbol}: ${records.length} minutes over ${days.toFixed(1)} days (${coverage.toFixed(0)}% of minutes present), ${clean.length} usable`);
  bySymbol.set(symbol, HYPOTHESES.flatMap((h) => eventStudy(records, h, costBps)));
}
const totalDays = Math.max(0, ...symbols.map((s) => { const r = loadMinutes(dir, s); return r.length > 1 ? (r[r.length - 1].t - r[0].t) / 86_400_000 : 0; }));
if (totalDays < MIN_DAYS) console.log(`\n!! Only ${totalDays.toFixed(1)} days recorded; at least ${MIN_DAYS} are needed for a meaningful test. Treat every number below as noise.`);

console.log(`\ncosts ${costBps} bps round trip · ${tests} tests → a result needs p < ${alpha.toFixed(4)} (Bonferroni) and n >= ${MIN_EVENTS} to count`);
console.log('hypothesis  horizon   n   mean bps  excess bps      t        p    hit%   net of costs   verdict');

const f = (v: number, w = 8, d = 1): string => v.toFixed(d).padStart(w);
for (const h of HYPOTHESES) {
  console.log(`\n${h.id}: ${h.name}`);
  for (const horizon of HORIZONS_MINUTES) {
    const perSymbol = symbols.map((s) => ({ s, row: bySymbol.get(s)?.find((r) => r.hypothesis === h.id && r.horizon === horizon) })).filter((x): x is { s: string; row: StudyRow } => Boolean(x.row));
    const lines: { label: string; row: StudyRow }[] = [...perSymbol.map((x) => ({ label: x.s, row: x.row }))];
    const pooled = poolRows(perSymbol.map((x) => x.row), costBps);
    if (pooled) lines.push({ label: 'POOLED', row: pooled });
    for (const { label, row } of lines) {
      // Below the minimum a t-statistic or a "net" figure is an artefact of tiny samples; print the count and nothing tempting
      if (row.n < MIN_EVENTS) {
        console.log(`${label.padEnd(8)}${String(horizon).padStart(6)}m ${String(row.n).padStart(5)}   too few events (need ${MIN_EVENTS})`);
        continue;
      }
      const p = row.t === null ? null : twoSidedP(row.t);
      const significant = p !== null && p < alpha;
      const verdict = !significant ? ''
        : row.excessBps > 0 ? (row.netBps > 0 ? 'SIGNIFICANT, beats costs: confirm on new data' : 'significant but smaller than costs')
        : 'significant in the OPPOSITE direction: new lead, needs its own test';
      console.log(`${label.padEnd(8)}${String(horizon).padStart(6)}m ${String(row.n).padStart(5)} ${f(row.meanSignedBps)} ${f(row.excessBps, 10)} ${row.t === null ? '     n/a' : f(row.t, 7, 2)} ${p === null ? '     n/a' : f(p, 8, 4)} ${row.hitRate === null ? '   n/a' : f(row.hitRate * 100, 6, 0)} ${f(row.netBps, 12)}   ${verdict}`);
    }
  }
}
console.log('\nSymbols move together, so POOLED n overstates independence: read the per-symbol rows first. A positive excess smaller than costs is not tradable.');
