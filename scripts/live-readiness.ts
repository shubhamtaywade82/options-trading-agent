/**
 * Live readiness: which strategies (if any) have earned the right to trade real money, and is the setup safe to run?
 *
 *   npx tsx scripts/live-readiness.ts [--evidence data/bt-all.jsonl,data/bt2-all.jsonl] [--paper data/decisions.jsonl]
 *                                     [--remote-state data/remote-state.json] [--write-approvals]
 *
 * A strategy is approvable only if BOTH hold:
 *   EVIDENCE  pooled out-of-sample-style trades (backtest windows and/or paper): enough trades over enough days, a positive
 *             90% lower bound on net expectancy after costs, positive in both time halves.
 *   FORWARD   real-time paper trading of the same strategy: enough trades, enough days, positive net expectancy.
 * Live mode (MODE=live) trades only approved strategies; with no approvals file nothing trades. Exit code 1 when not ready.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { loadDecisionFiles } from '../src/decision/loadDecisionFiles.js';
import { KillSwitch } from '../src/ops/killSwitch.js';
import { approvable, DEFAULT_POLICY, evaluateConfig, evaluateEvidence, evaluateForward, isReady, type Check } from '../src/ops/liveReadiness.js';
import { writeApprovals } from '../src/risk/strategyApprovals.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const costs = { feeRate: config.risk.takerFeeRate, slippageRate: config.risk.slippageBufferRate };
const evidenceSpec = arg('evidence', 'data/bt-all.jsonl,data/bt2-all.jsonl');
const paperSpec = arg('paper', config.decisionsPath);
const evidenceRecords = loadDecisionFiles(evidenceSpec);
const paperRecords = loadDecisionFiles(paperSpec);

const statusMark = { PASS: '✓ PASS', WARN: '! WARN', FAIL: '✗ FAIL' } as const;
const fmt = (v: number, d = 3): string => (Number.isFinite(v) ? `${v.toFixed(d)}R` : 'n/a');

console.log('LIVE READINESS\n');
console.log(`evidence: ${evidenceRecords.length} decisions from ${evidenceSpec}`);
console.log(`paper:    ${paperRecords.length} decisions from ${paperSpec}`);
console.log(`policy:   evidence >= ${DEFAULT_POLICY.evidence.minTrades} trades over >= ${DEFAULT_POLICY.evidence.minSpanDays} days, lower bound > 0, both halves > 0; forward >= ${DEFAULT_POLICY.forward.minTrades} trades over >= ${DEFAULT_POLICY.forward.minSpanDays} days, mean > 0\n`);

const evidence = evaluateEvidence(evidenceRecords, costs);
console.log('EVIDENCE (net of costs)');
if (evidence.length === 0) console.log('  no executed trades with outcomes');
for (const e of evidence) {
  console.log(`  ${e.pass ? statusMark.PASS : statusMark.FAIL}  ${e.strategy.padEnd(20)} n=${String(e.trades).padStart(4)}  span ${e.spanDays.toFixed(0).padStart(3)}d  mean ${fmt(e.meanNetR)}  lcb ${fmt(e.lcbNetR)}  halves ${fmt(e.firstHalfNetR)} / ${fmt(e.secondHalfNetR)}`);
  for (const f of e.failures) console.log(`           - ${f}`);
}

const forward = evaluateForward(paperRecords, costs);
console.log('\nFORWARD PAPER (net of costs)');
if (forward.length === 0) console.log('  no closed paper trades');
for (const f of forward) {
  console.log(`  ${f.pass ? statusMark.PASS : statusMark.FAIL}  ${f.strategy.padEnd(20)} n=${String(f.trades).padStart(4)}  span ${f.spanDays.toFixed(0).padStart(3)}d  mean ${fmt(f.meanNetR)}`);
  for (const x of f.failures) console.log(`           - ${x}`);
}

const remoteStatePath = path.resolve(arg('remote-state', 'data/remote-state.json'));
const unprotected: { symbol: string; owner: string }[] = [];
if (existsSync(remoteStatePath)) {
  try {
    const state = JSON.parse(readFileSync(remoteStatePath, 'utf8')) as { positions?: Record<string, { owner?: string; stopLoss?: number | null }> };
    for (const [symbol, meta] of Object.entries(state.positions ?? {})) {
      if (meta.stopLoss === null || meta.stopLoss === undefined) unprotected.push({ symbol, owner: meta.owner ?? 'unknown' });
    }
  } catch { console.log(`\n(could not read ${remoteStatePath}; protective-stop check assumes none)`); }
}

const checks: Check[] = evaluateConfig({
  mode: config.mode, riskEngine: config.riskEngine, alerts: config.alerts,
  riskPerTradePct: config.risk.riskPerTradePct, maxLeverage: config.risk.maxLeverage,
  maxDailyLossPct: config.risk.maxDailyLossPct, maxDrawdownPct: config.risk.maxDrawdownPct,
  killSwitchHalted: new KillSwitch().state().halted, unprotected,
});
console.log('\nSETUP');
for (const c of checks) console.log(`  ${statusMark[c.status]}  ${`${c.area}/${c.id}`.padEnd(22)} ${c.detail}`);

const approved = approvable(evidence, forward);
console.log('\nAPPROVABLE FOR LIVE');
if (approved.length === 0) console.log('  none: live mode would trade nothing');
for (const a of approved) console.log(`  ${a.strategy}  (evidence lcb ${fmt(a.snapshot.lcbNetR)}, forward mean ${fmt(a.snapshot.forwardMeanNetR)})`);

if (process.argv.includes('--write-approvals')) {
  writeApprovals(path.resolve(config.approvalsPath), approved.map((a) => ({ strategy: a.strategy, approvedAt: Date.now(), evidence: a.snapshot })));
  console.log(`\nwrote ${config.approvalsPath} (${approved.length} approved)`);
}

const setupReady = isReady(checks);
const ready = setupReady && approved.length > 0;
console.log(`\nVERDICT: ${ready ? 'READY for a small live trial of the approved strategies' : 'NOT READY'}${setupReady ? '' : ' (setup has failures)'}${approved.length === 0 ? ' (no strategy has passed evidence and forward checks)' : ''}`);
process.exit(ready ? 0 : 1);
