/**
 * Where do decisions go and what do the candidates look like? Works on rejected signals too, which calibrate-rr cannot
 * (they have no outcome), so it is the tool for "why is nothing trading" and "how bad is the RR geometry".
 *
 * Run locally:  npx tsx scripts/analyze-decisions.ts [--file data/decisions.jsonl[,more.jsonl]]
 */
import { config } from '../src/config.js';
import type { DecisionRecord } from '../src/decision/DecisionJournal.js';
import { loadDecisionFiles } from '../src/decision/loadDecisionFiles.js';
import { classifyRiskRefusal } from '../src/decision/NoTrade.js';
import { edgeVsCoinFlip } from '../src/learning/EdgeTest.js';
import { capacityContext, minStopPctToFitCap, stopFeasibility } from '../src/learning/RefusalContext.js';

const i = process.argv.indexOf('--file');
const file = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : config.decisionsPath;
const records = loadDecisionFiles(file);

const count = <T>(items: T[], key: (t: T) => string): [string, number][] => {
  const m = new Map<string, number>();
  for (const t of items) m.set(key(t), (m.get(key(t)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};
const plannedRr = (r: DecisionRecord): number | null => {
  if (r.entry === null || r.stopLoss === null || r.takeProfit === null) return null;
  const risk = Math.abs(r.entry - r.stopLoss);
  return risk > 0 ? Math.abs(r.takeProfit - r.entry) / risk : null;
};
const quantile = (sorted: number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const line = (k: string, n: number, total: number): void => console.log(`  ${k.padEnd(34)} ${String(n).padStart(4)}  ${((n / total) * 100).toFixed(0).padStart(3)}%`);

console.log(`decisions: ${records.length} · file: ${file}`);
if (records.length === 0) process.exit(0);
const span = (records.at(-1)!.timestamp - records[0].timestamp) / 3_600_000;
console.log(`span: ${span.toFixed(1)}h · first ${new Date(records[0].timestamp).toISOString()} · last ${new Date(records.at(-1)!.timestamp).toISOString()}`);

console.log('\nstatus');
for (const [k, n] of count(records, (r) => r.status)) line(k, n, records.length);

const rejected = records.filter((r) => r.status === 'RISK_REJECTED');
console.log('\nrisk refusals by cause');
for (const [k, n] of count(rejected, (r) => classifyRiskRefusal(r.rejectionReason ?? ''))) line(k, n, rejected.length);

console.log('\nrefusal causes by strategy');
for (const [strategy] of count(records, (r) => r.strategy)) {
  const own = rejected.filter((r) => r.strategy === strategy);
  const made = records.filter((r) => r.strategy === strategy).length;
  const causes = count(own, (r) => classifyRiskRefusal(r.rejectionReason ?? '')).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  const executed = records.filter((r) => r.strategy === strategy && r.status === 'EXECUTED').length;
  console.log(`  ${strategy.padEnd(20)} proposed ${String(made).padStart(4)}  executed ${String(executed).padStart(3)}  refused ${String(own.length).padStart(4)}  [${causes}]`);
}

const capacity = capacityContext(records);
if (capacity.length > 0) {
  console.log('\ncapacity refusals: was the symbol already held, and which limit was named');
  for (const c of capacity) {
    const limits = Object.entries(c.limits).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ');
    console.log(`  ${c.strategy.padEnd(20)} refused ${String(c.refused).padStart(4)}  while symbol held ${String(c.whileSymbolHeld).padStart(4)} (${((c.whileSymbolHeld / c.refused) * 100).toFixed(0)}%)  [${limits}]`);
  }
  console.log('  Refused with nothing open in that symbol means something other than "waiting for the open position".');
}

const minStop = minStopPctToFitCap({ riskPerTradePct: config.risk.riskPerTradePct, maxSymbolExposurePct: config.risk.maxSymbolExposurePct, legRate: config.risk.takerFeeRate + config.risk.slippageBufferRate });
console.log(`\nstop width vs the exposure cap (risk ${config.risk.riskPerTradePct}% / cap ${config.risk.maxSymbolExposurePct}% / costs ${(2 * (config.risk.takerFeeRate + config.risk.slippageBufferRate) * 100).toFixed(2)}% round trip => a stop must be >= ${minStop.toFixed(2)}% of price to fit)`);
for (const f of stopFeasibility(records, minStop)) {
  console.log(`  ${f.strategy.padEnd(20)} stop% p10 ${f.p10.toFixed(2)}  median ${f.median.toFixed(2)}  p90 ${f.p90.toFixed(2)}  fit the cap: ${f.feasible}/${f.proposals} (${((f.feasible / f.proposals) * 100).toFixed(0)}%)  executed: ${f.executedOfFeasible} of those, ${f.executedOfInfeasible} of the rest`);
}
console.log('  Uses your current .env; a journal written under different limits will not line up exactly.');

console.log('\nplanned RR by strategy (all decisions, rejected included)');
for (const [strategy] of count(records, (r) => r.strategy)) {
  const rrs = records.filter((r) => r.strategy === strategy).map(plannedRr).filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (rrs.length === 0) continue;
  const below = (t: number): string => `${((rrs.filter((v) => v < t).length / rrs.length) * 100).toFixed(0)}%`;
  console.log(`  ${strategy.padEnd(20)} n=${String(rrs.length).padStart(3)}  p10 ${quantile(rrs, 0.1).toFixed(2)}  median ${quantile(rrs, 0.5).toFixed(2)}  p90 ${quantile(rrs, 0.9).toFixed(2)}  <0.25: ${below(0.25)}  <1.0: ${below(1)}`);
}

// The same idea re-proposed again and again: same symbol + strategy + side within 60 minutes of the previous one
const last = new Map<string, number>();
let repeats = 0;
for (const r of records) {
  const k = `${r.symbol}:${r.strategy}:${r.side}`;
  if (r.timestamp - (last.get(k) ?? -Infinity) < 3_600_000) repeats += 1;
  last.set(k, r.timestamp);
}
console.log(`\nre-proposals within 60m of the same symbol/strategy/side: ${repeats} of ${records.length} (${((repeats / records.length) * 100).toFixed(0)}%)`);

const fmtTest = (label: string, list: DecisionRecord[]): void => {
  const t = edgeVsCoinFlip(list);
  if (t.n === 0) return;
  const z = t.z === null ? '  n/a' : t.z.toFixed(2).padStart(5);
  const p = t.pBetter === null ? 'n/a' : t.pBetter.toFixed(3);
  console.log(`  ${label.padEnd(20)} n=${String(t.n).padStart(3)}  target hits ${String(t.wins).padStart(3)}  coin-flip expectation ${t.expectedWins.toFixed(1).padStart(6)}  z ${z}  p(better by luck) ${p}`);
};
console.log('\nentry timing vs a coin flip (trades that ended at their own target or stop; before costs)');
fmtTest('ALL', records);
for (const [strategy] of count(records, (r) => r.strategy)) fmtTest(strategy, records.filter((r) => r.strategy === strategy));
console.log('  A random entry hits a 2R target first ~33% of the time. Drift (e.g. long-only in an uptrend) can beat that without skill.');

const executed = records.filter((r) => r.status === 'EXECUTED');
const closed = executed.filter((r) => r.outcome);
console.log(`\nexecuted: ${executed.length} · with outcome: ${closed.length}${closed.length > 15 ? ' · last 15 shown' : ''}`);
for (const r of closed.slice(-15)) console.log(`  ${r.symbol} ${r.strategy} ${r.side} plannedRR ${plannedRr(r)?.toFixed(2)} → ${r.outcome!.rMultiple}R (${r.outcome!.reason})`);
