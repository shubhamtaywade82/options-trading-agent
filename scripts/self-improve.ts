/**
 * Self-improvement loop CLI.
 *
 *   npx tsx scripts/self-improve.ts [--iters N] [--llm] [--status] [--ledger PATH]
 *
 * Loads the existing SetupOutcomeLedger from disk (data/setup-outcomes.jsonl by default), constructs the
 * SelfImprovementLoop with persistent registries, and runs N iterations of OBSERVE → DIAGNOSE → HYPOTHESIZE →
 * BACKTEST → CHALLENGE → PROMOTE/REJECT.
 *
 * Each iteration prints:
 *   - The current champion (id, version, hypothesis summary)
 *   - The diagnostics digest (worst/best cells of the champion's conditional-edge matrix)
 *   - Each hypothesis proposed (LLM or fallback) and the experiment result + verdict
 *   - Any candidate staged as a new SHADOW challenger
 *
 * Flags:
 *   --iters N    Number of iterations to run. Default 1.
 *   --llm        Use the OllamaAdvisor to propose hypotheses (default: deterministic fallback).
 *   --status     Print the current state (champion, challengers, experiment count) and exit.
 *   --events     Print the last N research events from data/research-events.jsonl (audit trail) and exit.
 *   --events-tail N  Number of events to print with --events (default 50).
 *   --metrics    Print aggregate research-plane metrics (replayed from data/research-events.jsonl) and exit.
 *   --ledger PATH  Path to the setup-outcomes.jsonl file. Default data/setup-outcomes.jsonl.
 *
 * The script never promotes a candidate past SHADOW — operator decides SHADOW → PAPER → CANARY → PROMOTED
 * via `--advance` (a future CLI sub-command). The loop produces evidence; the operator consumes it.
 *
 * Event sourcing: every transition (champion appointed, challenger staged, experiment run, gate verdict
 * issued) is emitted to a `ResearchEventBus` and persisted to `data/research-events.jsonl`. Read with
 * `--events`.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { OllamaAdvisor } from '../src/ollama/advisor.js';
import { SetupOutcomeLedger, type SetupOutcomeRecord } from '../src/learning/SetupOutcomeLedger.js';
import { ChampionRegistry } from '../src/research/ChampionRegistry.js';
import { ExperimentStore, type ExperimentRecord } from '../src/research/ExperimentStore.js';
import { ResearchAgent, type ResearchDiagnostics } from '../src/research/ResearchAgent.js';
import { SelfImprovementLoop, DEFAULT_LOOP_CONFIG } from '../src/research/SelfImprovementLoop.js';
import { StrategyRegistry } from '../src/research/StrategyRegistry.js';
import { JsonlEventSubscriber, ResearchEventBus, type ResearchEvent } from '../src/research/Events.js';
import { MetricsCollector, formatMetrics, replayEvents, attachCollector, type ResearchMetrics } from '../src/research/MetricsCollector.js';
import { ExperimentMemory } from '../src/research/ExperimentMemory.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Loads the SetupOutcomeLedger from disk and returns its `all()` array of resolved records. */
function loadLedger(filePath: string): SetupOutcomeRecord[] {
  const ledger = new SetupOutcomeLedger(filePath, { feeRate: 0.0004, slippageRate: 0.0002 });
  return ledger.all();
}

function printChampion(champions: ChampionRegistry, strategies: StrategyRegistry): void {
  for (const id of strategies.ids()) {
    const champion = champions.champion(id);
    if (!champion) {
      console.log(`  ${id}: no champion appointed`);
      continue;
    }
    const spec = strategies.get(id, champion.version);
    console.log(`  ${id}: champion v${champion.version} (since ${new Date(champion.since).toISOString()})`);
    if (spec) {
      console.log(`    hypothesis: ${spec.hypothesis}`);
      console.log(`    params: ${Object.entries(spec.params).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
    const challengers = champions.challengersFor(id);
    if (challengers.length > 0) {
      console.log(`    active challengers:`);
      for (const c of challengers) {
        console.log(`      v${c.version} @ ${c.stage} (since ${new Date(c.since).toISOString()})${c.note ? ` — ${c.note}` : ''}`);
      }
    }
  }
}

function printDiagnostics(d: ResearchDiagnostics): void {
  console.log(`  Diagnostics for ${d.championId} v${d.championVersion}`);
  if (d.worstCells.length > 0) {
    console.log(`  Worst cells:`);
    for (const c of d.worstCells.slice(0, 3)) {
      const s = c.stats;
      console.log(`    ${c.key}: n=${c.n}, mean=${s ? s.mean.toFixed(3) : 'n/a'}R, LCB=${s ? s.ciLow.toFixed(3) : 'n/a'}, significant=${c.significant}`);
    }
  }
  if (d.bestCells.length > 0) {
    console.log(`  Best cells:`);
    for (const c of d.bestCells.slice(0, 3)) {
      const s = c.stats;
      console.log(`    ${c.key}: n=${c.n}, mean=${s ? s.mean.toFixed(3) : 'n/a'}R, LCB=${s ? s.ciLow.toFixed(3) : 'n/a'}, significant=${c.significant}`);
    }
  }
}

function printExperiment(idx: number, exp: ExperimentRecord): void {
  console.log(`  Experiment ${idx + 1}: candidate v${exp.candidate.version} from parent v${exp.parent.version}`);
  console.log(`    hypothesis: ${exp.candidate.hypothesis}`);
  console.log(`    train: n=${exp.result.train.n}, meanR=${exp.result.train.meanNetR.toFixed(3)}, PF=${exp.result.train.profitFactor.toFixed(2)}`);
  console.log(`    test:  n=${exp.result.test.n}, meanR=${exp.result.test.meanNetR.toFixed(3)}, PF=${exp.result.test.profitFactor.toFixed(2)}, DD=${exp.result.test.maxDrawdownR.toFixed(2)}R`);
  console.log(`    parent test: n=${exp.result.parentTest.n}, meanR=${exp.result.parentTest.meanNetR.toFixed(3)}`);
  console.log(`    walk-forward: ${exp.result.walkForward.folds} folds, OOS mean=${exp.result.walkForward.outOfSample?.mean.toFixed(3) ?? 'n/a'}R`);
  if (exp.result.experimentNotes.length > 0) {
    console.log(`    notes:`);
    for (const n of exp.result.experimentNotes) console.log(`      - ${n}`);
  }
  console.log(`    verdict: ${exp.verdict.decision}`);
  for (const r of exp.verdict.reasons) console.log(`      ${r}`);
}

async function main(): Promise<void> {
  const ledgerPath = arg('ledger', path.resolve('data/setup-outcomes.jsonl'));
  const iters = Number(arg('iters', '1'));
  const useLlm = flag('llm');
  const statusOnly = flag('status');
  const eventsOnly = flag('events');
  const metricsOnly = flag('metrics');
  const eventsTail = Number(arg('events-tail', '50'));

  // Construct the event bus + JSONL subscriber. The bus is the canonical audit trail; subscribers persist
  // every event to data/research-events.jsonl. ChampionRegistry and SelfImprovementLoop emit through it.
  const bus = new ResearchEventBus();
  const jsonlSub = new JsonlEventSubscriber(path.resolve('data/research-events.jsonl'));
  bus.subscribe(jsonlSub.toSubscriber());

  // Attach the metrics collector as a bus subscriber. It auto-tracks every event published during this run.
  // For --metrics, we also replay persisted events from disk so the snapshot reflects the full history, not
  // just this process's events.
  const collector = new MetricsCollector();
  attachCollector(bus, collector);

  // Construct the experiment memory. Persists to data/experiment-memory.json. Uses Jaccard text similarity
  // when no LLM is configured (offline mode), or dense-vector cosine similarity when an embedder is supplied.
  // The memory gives the ResearchAgent a record of prior experiments so it doesn't propose the same hypothesis
  // twice — "we already tried raising minSweepDepthAtr to 0.5 on these cells and it was REJECTED for regime collapse".
  const memory = new ExperimentMemory(path.resolve('data/experiment-memory.json'), null);

  const strategies = new StrategyRegistry(path.resolve('data/strategy-registry.jsonl'));
  const champions = new ChampionRegistry(path.resolve('data/champion-registry.json'), bus);
  const experiments = new ExperimentStore(path.resolve('data/experiments.jsonl'));
  strategies.ensureSeeds();
  for (const id of strategies.ids()) {
    if (!champions.champion(id)) {
      const seed = strategies.latest(id);
      if (seed) champions.appoint(seed, 'seed appointment on first run');
    }
  }

  if (metricsOnly) {
    // Replay persisted events from disk so the snapshot reflects the full history, not just this process.
    const eventsPath = path.resolve('data/research-events.jsonl');
    let metrics: ResearchMetrics;
    if (existsSync(eventsPath)) {
      const events: ResearchEvent[] = [];
      for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line) as ResearchEvent); } catch { /* skip torn line */ }
      }
      metrics = replayEvents(events);
    } else {
      metrics = collector.snapshot();
    }
    console.log(formatMetrics(metrics));
    return;
  }

  if (eventsOnly) {
    // Print the last N persisted events from data/research-events.jsonl as a readable audit trail.
    const eventsPath = path.resolve('data/research-events.jsonl');
    if (!existsSync(eventsPath)) {
      console.log(`No events file at ${eventsPath}. Run the loop first to populate it.`);
      return;
    }
    const lines = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
    const tail = lines.slice(-eventsTail);
    console.log(`=== Last ${tail.length} research events (of ${lines.length} total) ===`);
    for (const line of tail) {
      try {
        const e = JSON.parse(line) as ResearchEvent;
        console.log(`[${e.seq}] ${new Date(e.at).toISOString()} ${e.type} ${summaryOf(e)}`);
      } catch {
        console.log(`(unparseable line) ${line.slice(0, 100)}`);
      }
    }
    return;
  }

  if (statusOnly) {
    console.log('=== Current state ===');
    printChampion(champions, strategies);
    console.log('');
    console.log(`Experiments on record: ${experiments.all().length}`);
    const promoted = experiments.withVerdict('PROMOTE');
    console.log(`Promoted experiments: ${promoted.length}`);
    const eventsPath = path.resolve('data/research-events.jsonl');
    if (existsSync(eventsPath)) {
      const eventCount = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).length;
      console.log(`Events on record: ${eventCount}`);
    }
    return;
  }

  if (!existsSync(ledgerPath)) {
    console.error(`error: ledger not found at ${ledgerPath}`);
    console.error('Run the trading agent first to populate data/setup-outcomes.jsonl, or supply --ledger PATH.');
    process.exit(1);
  }
  const ledger = loadLedger(ledgerPath);
  console.log(`Loaded ${ledger.length} setup outcomes from ${ledgerPath}`);
  console.log('');

  // Build the LLM client if requested. The OllamaAdvisor exposes a private client; we wrap it via a small adapter.
  let agent: ResearchAgent;
  if (useLlm) {
    const advisor = new OllamaAdvisor();
    // The advisor wraps the SDK; we re-implement a minimal AdvisorClient that delegates to it via the same path.
    const client = {
      listModels: async () => [],
      generateText: async (req: { model: string; prompt: string; format?: 'json' }) => {
        // Use the advisor's generate path via reflection; for a CLI demo this is acceptable.
        // In production, the advisor should expose a typed generateText method on its public API.
        const anyAdvisor = advisor as unknown as { generateText?: (req: { model: string; prompt: string }) => Promise<string> };
        if (typeof anyAdvisor.generateText === 'function') return anyAdvisor.generateText(req);
        throw new Error('OllamaAdvisor does not expose generateText');
      },
    };
    agent = new ResearchAgent(client, 'qwen2.5:7b', undefined, bus, memory);
    console.log('ResearchAgent: LLM mode (Ollama qwen2.5:7b). Will fall back to deterministic proposer on any LLM failure.');
  } else {
    agent = new ResearchAgent(null, undefined, undefined, bus, memory);
    console.log('ResearchAgent: deterministic fallback mode (no LLM). Use --llm to enable.');
  }
  console.log('');

  const loop = new SelfImprovementLoop(strategies, champions, experiments, agent, {
    ...DEFAULT_LOOP_CONFIG,
    trainDays: Number(arg('train-days', String(DEFAULT_LOOP_CONFIG.trainDays))),
    testDays: Number(arg('test-days', String(DEFAULT_LOOP_CONFIG.testDays))),
    maxHypothesesPerRun: Number(arg('max-hypotheses', String(DEFAULT_LOOP_CONFIG.maxHypothesesPerRun))),
  }, bus, memory);

  for (let i = 0; i < iters; i += 1) {
    console.log(`=== Iteration ${i + 1} / ${iters} ===`);
    console.log('Champion before iteration:');
    printChampion(champions, strategies);
    console.log('');

    const result = await loop.run(ledger);
    printDiagnostics(result.diagnostics);
    console.log('');
    console.log(`Proposed ${result.hypotheses.length} hypotheses; ran ${result.experiments.length} experiments.`);
    for (let j = 0; j < result.experiments.length; j += 1) {
      printExperiment(j, result.experiments[j]);
    }
    if (result.newChampion) {
      console.log(`*** New SHADOW challenger staged: ${result.newChampion.id} v${result.newChampion.version} ***`);
    }
    console.log('');
  }

  console.log('=== Final state ===');
  printChampion(champions, strategies);
  console.log('');
  console.log(`Total experiments on record: ${experiments.all().length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/** Render a one-line summary of an event for the `--events` audit trail view. */
function summaryOf(e: ResearchEvent): string {
  switch (e.type) {
    case 'spec_registered':
      return `${e.payload.id}:v${e.payload.version} (parent: ${e.payload.parentVersion ?? '∅'})`;
    case 'champion_appointed':
      return `${e.payload.id}:v${e.payload.version}${e.payload.replacedVersion ? ` (replaced v${e.payload.replacedVersion})` : ''}${e.payload.note ? ` — ${e.payload.note}` : ''}`;
    case 'challenger_staged':
      return `${e.payload.id}:v${e.payload.version} at SHADOW${e.payload.supersededVersion ? ` (superseded v${e.payload.supersededVersion})` : ''}`;
    case 'challenger_transitioned':
      return `${e.payload.id}:v${e.payload.version} ${e.payload.from} → ${e.payload.to}${e.payload.note ? ` — ${e.payload.note}` : ''}`;
    case 'champion_rolled_back':
      return `${e.payload.id}:v${e.payload.fromVersion} → v${e.payload.toVersion} (${e.payload.reason})`;
    case 'experiment_started':
      return `${e.payload.experimentId}: candidate ${e.payload.candidateId}:v${e.payload.candidateVersion} from parent ${e.payload.parentId}:v${e.payload.parentVersion}`;
    case 'experiment_completed':
      return `${e.payload.experimentId}: ${e.payload.decision} (test n=${e.payload.testN}, meanR=${e.payload.testMeanR.toFixed(3)} vs parent ${e.payload.parentTestMeanR.toFixed(3)})`;
    case 'loop_iteration_started':
      return `champion ${e.payload.championId}:v${e.payload.championVersion}, ledger=${e.payload.ledgerSize}`;
    case 'loop_iteration_completed':
      return `${e.payload.hypothesesProposed} hypotheses, ${e.payload.experimentsRun} experiments, new shadow=${e.payload.newShadowStaged}`;
    case 'hypothesis_proposed':
      return `[${e.payload.source}] ${e.payload.observation} → ${e.payload.proposal}`;
    case 'hypothesis_repaired':
      return `${e.payload.ok ? 'repaired' : 'repair failed'} after ${e.payload.attempts} attempt(s); ${e.payload.errorCount} error(s)${e.payload.firstError ? ` — ${e.payload.firstError}` : ''}`;
    case 'model_routed':
      return `${e.payload.kind} → ${e.payload.model} (score=${e.payload.score.toFixed(3)}${e.payload.reasons.length > 0 ? `; ${e.payload.reasons.join('; ')}` : ''})`;
    case 'patch_applied':
      return `${e.payload.ok ? 'succeeded' : 'failed'} — ${e.payload.filesChanged} file(s), ${e.payload.verifyPassed}/${e.payload.verifyCommandCount} validations passed${e.payload.commitSha ? `; commit ${e.payload.commitSha.slice(0, 7)}` : ''}${e.payload.error ? `; ${e.payload.error}` : ''}`;
  }
}
