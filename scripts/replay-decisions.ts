/**
 * Turns your rejected decisions into evidence. A rejected signal still carries entry/stop/target, so its bracket can be
 * walked over the real 5m price path that followed. This answers "were the strategies' ideas any good?" without waiting
 * for trades that the gates (rightly or wrongly) never allowed.
 *
 *   npx tsx scripts/replay-decisions.ts [--file data/decisions.jsonl[,more.jsonl]] [--hold-hours 24] [--min-samples 15]
 *                                       [--fee 0.0004] [--slippage 0.0002] [--all-proposals] [--write]
 *                                       [--write-hypothetical data/hypothetical-decisions.jsonl]
 *
 * Needs outbound access to public Binance USD-M klines (no keys). Repeated proposals of one idea are collapsed
 * unless --all-proposals. Stop and target in the same 5m bar resolve against us. Treat output as a screen on a small sample.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import type { DecisionRecord } from '../src/decision/DecisionJournal.js';
import { loadDecisionFiles } from '../src/decision/loadDecisionFiles.js';
import { edgeVsCoinFlip } from '../src/learning/EdgeTest.js';
import { minStopPctToFitCap } from '../src/learning/RefusalContext.js';
import { asHypotheticalExecuted, dedupeProposals, simulateBracket } from '../src/learning/HypotheticalOutcome.js';
import { breakevenWinRate, calibrateRrFloors, costInR } from '../src/risk/rrProfile.js';
import type { Candle } from '../src/types.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const num = (name: string, fallback: number): number => {
  const v = Number(arg(name, String(fallback)));
  if (!Number.isFinite(v) || v < 0) throw new Error(`--${name} must be a non-negative number`);
  return v;
};

const BASE = 'https://fapi.binance.com';
const INTERVAL_MS = 5 * 60_000;

async function fetchKlines(symbol: string, from: number, to: number): Promise<Candle[]> {
  const out: Candle[] = [];
  for (let cursor = from; cursor < to;) {
    const url = `${BASE}/fapi/v1/klines?symbol=${symbol}&interval=5m&startTime=${cursor}&endTime=${to}&limit=1500`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`klines ${symbol} failed: HTTP ${response.status}`);
    const rows = (await response.json()) as unknown[][];
    if (rows.length === 0) break;
    for (const r of rows) out.push({ openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) });
    cursor = Number(rows[rows.length - 1][0]) + INTERVAL_MS;
  }
  return out;
}

const file = arg('file', config.decisionsPath);
const holdMs = num('hold-hours', 24) * 3_600_000;
const feeRate = num('fee', config.risk.takerFeeRate);
const slippageRate = num('slippage', config.risk.slippageBufferRate);
const all = loadDecisionFiles(file).filter((r) => r.side && r.entry !== null && r.stopLoss !== null && r.takeProfit !== null);
const ideas = process.argv.includes('--all-proposals') ? all : dedupeProposals(all);
console.log(`decisions with levels: ${all.length} · distinct ideas after collapsing repeats: ${ideas.length} · hold ≤ ${holdMs / 3_600_000}h`);

const bySymbol = new Map<string, DecisionRecord[]>();
for (const r of ideas) bySymbol.set(r.symbol, [...(bySymbol.get(r.symbol) ?? []), r]);

const synthetic: DecisionRecord[] = [];
const tally = { TP: 0, SL: 0, TIMEOUT: 0, NO_DATA: 0 };
for (const [symbol, records] of bySymbol) {
  const from = Math.min(...records.map((r) => r.timestamp));
  const to = Math.min(Date.now(), Math.max(...records.map((r) => r.timestamp)) + holdMs + INTERVAL_MS);
  const candles = await fetchKlines(symbol, from, to);
  console.log(`  ${symbol}: ${candles.length} 5m candles for ${records.length} ideas`);
  for (const r of records) {
    const result = simulateBracket({ side: r.side!, entry: r.entry!, stopLoss: r.stopLoss!, takeProfit: r.takeProfit!, from: r.timestamp, maxHoldMs: holdMs }, candles);
    tally[result.outcome] += 1;
    const hypo = asHypotheticalExecuted(r, result);
    if (hypo) synthetic.push(hypo);
  }
}
console.log(`outcomes: TP ${tally.TP} · SL ${tally.SL} · timeout ${tally.TIMEOUT} · no data/invalid ${tally.NO_DATA}`);

const report = calibrateRrFloors(synthetic, { feeRate, slippageRate, minSamples: num('min-samples', 15) });
console.log('\nhypothetical, cost-adjusted, by strategy');
for (const v of report.verdicts) {
  if (v.status === 'CALIBRATED') console.log(`  ${v.strategy.padEnd(20)} CALIBRATED  minRr ${v.floor.minRr}  n=${v.floor.n}  netR ${v.floor.meanNetR.toFixed(3)}  lcb ${v.floor.lcbNetR.toFixed(3)}`);
  else console.log(`  ${v.strategy.padEnd(20)} ${v.status}  sample=${v.sample}${v.best ? `  best floor ${v.best.minRr}: n=${v.best.n} netR ${v.best.meanNetR.toFixed(3)} lcb ${v.best.lcbNetR.toFixed(3)}` : ''}`);
}
const perStrategy = new Map<string, number[]>();
for (const r of synthetic) {
  const risk = Math.abs(r.entry! - r.stopLoss!);
  const net = r.outcome!.rMultiple - (r.entry! * 2 * (feeRate + slippageRate)) / risk;
  perStrategy.set(r.strategy, [...(perStrategy.get(r.strategy) ?? []), net]);
}
console.log('\nunconditional net R per idea (no RR floor)');
for (const [strategy, rs] of [...perStrategy].sort()) {
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  console.log(`  ${strategy.padEnd(20)} n=${String(rs.length).padStart(3)}  mean ${mean.toFixed(3)}R  win ${((rs.filter((x) => x > 0).length / rs.length) * 100).toFixed(0)}%`);
}
// What decides viability is how much of the stop the round trip costs, not the strategy label
interface Row { strategy: string; net: number; costR: number; pStar: number; stopPct: number; win: boolean }
const rows: Row[] = synthetic.map((r) => {
  const risk = Math.abs(r.entry! - r.stopLoss!);
  const costR = costInR(r.entry!, r.stopLoss!, { feeRate, slippageRate });
  return { strategy: r.strategy, net: r.outcome!.rMultiple - costR, costR, pStar: breakevenWinRate(r.entry!, r.stopLoss!, r.takeProfit!, { feeRate, slippageRate }), stopPct: (risk / r.entry!) * 100, win: r.outcome!.rMultiple > 0 };
});
const median = (xs: number[]): number => { const s2 = [...xs].sort((a, b) => a - b); return s2.length % 2 ? s2[(s2.length - 1) / 2] : (s2[s2.length / 2 - 1] + s2[s2.length / 2]) / 2; };
const cut = (title: string, key: (r: Row) => string): void => {
  console.log(`\n${title}`);
  const groups = new Map<string, Row[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  for (const [k, g] of [...groups].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
    console.log(`  ${k.padEnd(22)} n=${String(g.length).padStart(3)}  win ${((g.filter((x) => x.win).length / g.length) * 100).toFixed(0).padStart(3)}%  mean ${(g.reduce((a, x) => a + x.net, 0) / g.length).toFixed(2).padStart(6)}R  median ${median(g.map((x) => x.net)).toFixed(2).padStart(6)}R`);
  }
};
cut('by round-trip cost as a share of the stop (costR)', (r) => (r.costR < 0.15 ? '1) <0.15R' : r.costR < 0.35 ? '2) 0.15-0.35R' : r.costR < 0.7 ? '3) 0.35-0.70R' : '4) >=0.70R'));
cut('by break-even win rate needed after costs', (r) => (r.pStar < 0.4 ? '1) <40%' : r.pStar < 0.5 ? '2) 40-50%' : r.pStar < 0.6 ? '3) 50-60%' : r.pStar < 0.7 ? '4) 60-70%' : '5) >=70%'));
const minStop = minStopPctToFitCap({ riskPerTradePct: config.risk.riskPerTradePct, maxSymbolExposurePct: config.risk.maxSymbolExposurePct, legRate: feeRate + slippageRate });
cut(`by strategy × stop width (cap-feasible = stop >= ${minStop.toFixed(2)}%)`, (r) => `${r.strategy} ${r.stopPct >= minStop ? 'wide' : 'tight'}`);
console.log('\nentry timing vs a coin flip on hypothetical outcomes (target vs stop only, before costs)');
for (const strategy of [...new Set(synthetic.map((r) => r.strategy))].sort()) {
  for (const [label, keep] of [['wide', (r: DecisionRecord) => (Math.abs(r.entry! - r.stopLoss!) / r.entry!) * 100 >= minStop], ['tight', (r: DecisionRecord) => (Math.abs(r.entry! - r.stopLoss!) / r.entry!) * 100 < minStop]] as const) {
    const t = edgeVsCoinFlip(synthetic.filter((r) => r.strategy === strategy && keep(r)));
    if (t.n === 0) continue;
    console.log(`  ${`${strategy} ${label}`.padEnd(26)} n=${String(t.n).padStart(4)}  target hits ${String(t.wins).padStart(4)}  expected ${t.expectedWins.toFixed(1).padStart(7)}  z ${t.z === null ? '  n/a' : t.z.toFixed(2).padStart(5)}  p(better by luck) ${t.pBetter === null ? 'n/a' : t.pBetter.toFixed(3)}`);
  }
}
cut('by stop distance', (r) => (r.stopPct < 0.25 ? '1) <0.25%' : r.stopPct < 0.5 ? '2) 0.25-0.5%' : r.stopPct < 1 ? '3) 0.5-1%' : '4) >=1%'));
const worst = [...synthetic].map((r) => ({ r, c: costInR(r.entry!, r.stopLoss!, { feeRate, slippageRate }) })).sort((a, b) => b.c - a.c).slice(0, 3);
console.log('\nmost cost-dominated ideas (a few of these can dominate any mean)');
for (const { r, c } of worst) console.log(`  ${r.symbol} ${r.strategy} ${r.side} stop ${(Math.abs(r.entry! - r.stopLoss!) / r.entry! * 100).toFixed(3)}% → costs ${c.toFixed(2)}R`);

console.log('\nSmall sample, hypothetical fills at the quoted entry, intrabar ties resolved against us: a screen, not proof.');

if (process.argv.includes('--write')) {
  const out = path.resolve(arg('out', 'data/rr-profile.json'));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report.profile, null, 2));
  console.log(`wrote ${out}`);
}

const hypotheticalOut = arg('write-hypothetical', '');
if (hypotheticalOut) {
  // Input for scripts/conditional-edge.ts: every idea, rejected ones included, with its replayed outcome
  const out = path.resolve(hypotheticalOut);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, synthetic.map((r) => JSON.stringify(r)).join('\n') + (synthetic.length ? '\n' : ''));
  console.log(`wrote ${synthetic.length} hypothetical outcomes to ${out}`);
}
