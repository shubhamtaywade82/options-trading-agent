/**
 * Research dashboard — a TUI view for the research plane.
 *
 * Adapted from agent-tui's UI component patterns (Sparkline, DataTable, etc.) but written natively for
 * the crypto-trading-agent's Ink 5 + React 18 stack. No dependency upgrade required.
 *
 * The dashboard reads the persistent state files (champion-registry.json, experiments.jsonl,
 * research-events.jsonl, experiment-memory.json) and renders a single-screen summary:
 *
 *   ┌── Champion ──────────────────┐  ┌── Metrics ─────────────────┐
 *   │ STRUCT-LIQ-η v1 (seed)       │  │ iterations: 3/3             │
 *   │ RR=1.5, sweepAge=6, ...      │  │ experiments: 5 (P=1, R=3, I=1)│
 *   │ hypothesis: Seed mirrors...  │  │ promotion rate: 20.0%       │
 *   └───────────────────────────────┘  └─────────────────────────────┘
 *   ┌── Active challengers ────────┐  ┌── Model routing ───────────┐
 *   │ v2 SHADOW — gate PROMOTED    │  │ local/escalate: 3/2         │
 *   └───────────────────────────────┘  │ avg complexity: 0.340      │
 *                                     └─────────────────────────────┘
 *   ┌── Recent experiments ─────────────────────────────────────────┐
 *   │ exp-1  v2  REJECT     test n=240, meanR=-0.060 vs parent -0.060│
 *   │ exp-2  v3  PROMOTE    test n=120, meanR=+0.606 vs parent +0.151│
 *   └────────────────────────────────────────────────────────────────┘
 *
 * The dashboard is read-only — it renders state, it doesn't drive the loop. Run the loop with
 * `npm run self-improve`; view the results with `npm run research:dashboard`.
 */

import { Box, Text } from 'ink';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ChampionRegistryState } from '../research/ChampionRegistry.js';
import type { ExperimentRecord } from '../research/ExperimentStore.js';
import type { ResearchEvent } from '../research/Events.js';
import type { ResearchMetrics } from '../research/MetricsCollector.js';
import { replayEvents } from '../research/MetricsCollector.js';
import { formatMetrics } from '../research/MetricsCollector.js';

// ─── Sparkline ─────────────────────────────────────────────────────────────

const SPARKLINE_BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Render a one-line sparkline from an array of numbers. Adapted from agent-tui's Sparkline component. */
export function sparkline(data: readonly number[], width = 20): string {
  if (data.length === 0) return chalk.gray('(no data)');
  const minVal = Math.min(...data);
  const maxVal = Math.max(...data);
  const range = maxVal - minVal || 1;

  let points: number[];
  if (data.length > width) {
    // Downsample by averaging.
    const step = data.length / width;
    points = Array.from({ length: width }, (_, i) => {
      const start = Math.floor(i * step);
      const end = Math.floor((i + 1) * step);
      const slice = data.slice(start, end);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    });
  } else {
    // Pad with the last value.
    points = [...data, ...Array(width - data.length).fill(data[data.length - 1])];
  }

  const chars = points.map((v) => {
    const normalized = (v - minVal) / range;
    const idx = Math.min(7, Math.round(normalized * 7));
    return SPARKLINE_BLOCKS[idx];
  });

  const color = minVal < 0 && maxVal > 0 ? chalk.yellow : maxVal <= 0 ? chalk.red : chalk.green;
  return color(chars.join('')) + chalk.gray(` min:${minVal.toFixed(2)} max:${maxVal.toFixed(2)}`);
}

// ─── Panel rendering ───────────────────────────────────────────────────────

/** Render a titled border box around content lines. Matches the existing src/ui/format.ts boxLines style. */
export function panel(title: string, lines: string[], width: number): string[] {
  const innerW = width - 2;
  const padLine = (s: string) => {
    const visibleLen = s.replace(/\x1b\[[0-9;]*m/g, '').length;
    if (visibleLen >= innerW) return s.slice(0, innerW);
    return s + ' '.repeat(innerW - visibleLen);
  };
  return [
    chalk.cyan('┌' + '─'.repeat(innerW) + '┐'),
    chalk.cyan('│') + padLine(' ' + chalk.cyan.bold(title)) + chalk.cyan('│'),
    chalk.cyan('├' + '─'.repeat(innerW) + '┤'),
    ...lines.map((l) => chalk.cyan('│') + padLine(l) + chalk.cyan('│')),
    chalk.cyan('└' + '─'.repeat(innerW) + '┘'),
  ];
}

// ─── State loaders ──────────────────────────────────────────────────────────

function loadJson<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined;
  try { return JSON.parse(readFileSync(filePath, 'utf8')) as T; } catch { return undefined; }
}

function loadJsonl<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  const out: T[] = [];
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* skip torn line */ }
  }
  return out;
}

// ─── Dashboard data ─────────────────────────────────────────────────────────

export interface DashboardData {
  championState: ChampionRegistryState | undefined;
  experiments: ExperimentRecord[];
  events: ResearchEvent[];
  metrics: ResearchMetrics;
}

/** Load all persistent state from the data/ directory. */
export function loadDashboardData(dataDir: string = path.resolve('data')): DashboardData {
  const championState = loadJson<ChampionRegistryState>(path.join(dataDir, 'champion-registry.json'));
  const experiments = loadJsonl<ExperimentRecord>(path.join(dataDir, 'experiments.jsonl'));
  const events = loadJsonl<ResearchEvent>(path.join(dataDir, 'research-events.jsonl'));
  const metrics = replayEvents(events);
  return { championState, experiments, events, metrics };
}

// ─── Dashboard sections ─────────────────────────────────────────────────────

function renderChampionPanel(data: DashboardData, width: number): string[] {
  const state = data.championState;
  if (!state || state.champions.length === 0) {
    return panel('Champion', [chalk.gray('(no champion appointed)')], width);
  }
  const champ = state.champions[0];
  const lines = [
    `${chalk.bold(champ.id)} v${chalk.cyan(champ.version)} ${chalk.gray(`(since ${new Date(champ.since).toISOString().slice(0, 10)})`)}`,
  ];
  if (champ.note) lines.push(chalk.gray(champ.note.slice(0, width - 4)));
  if (champ.promotedBy) lines.push(chalk.gray(`promoted by: ${champ.promotedBy}`));

  // Active challengers
  const challengers = state.challengers.filter((c) => c.stage === 'SHADOW' || c.stage === 'PAPER' || c.stage === 'CANARY');
  if (challengers.length > 0) {
    lines.push('');
    lines.push(chalk.yellow.bold('Active challengers:'));
    for (const c of challengers) {
      const stageColor = c.stage === 'SHADOW' ? chalk.gray : c.stage === 'PAPER' ? chalk.blue : chalk.green;
      lines.push(`  v${c.version} ${stageColor(c.stage)}${c.note ? chalk.gray(' — ' + c.note.slice(0, 40)) : ''}`);
    }
  }
  return panel('Champion', lines, width);
}

function renderMetricsPanel(data: DashboardData, width: number): string[] {
  const m = data.metrics;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    `iterations: ${m.iterationsStarted}/${m.iterationsCompleted}`,
    `experiments: ${m.experimentsCompleted} (P=${m.experimentsPromoted}, R=${m.experimentsRejected}, I=${m.experimentsInsufficientData})`,
    `promotion rate: ${chalk[m.promotionRate > 0 ? 'green' : 'gray'](pct(m.promotionRate))}`,
    `hypotheses: ${m.hypothesesProposed} (LLM: ${m.hypothesesFromLlm}, fallback: ${m.hypothesesFromFallback})`,
    `repair: ${m.repairLoopInvocations} invoked (${pct(m.repairSuccessRate)} success)`,
    `routing: ${m.modelRoutesLocal}/${m.modelRoutesEscalate} local/escalate (avg: ${m.modelRouteAvgScore.toFixed(3)})`,
  ];
  if (m.patchesApplied > 0) {
    lines.push(`patches: ${m.patchesApplied} (${m.patchesSucceeded} ok, ${m.patchesFailed} failed)`);
  }
  lines.push(`specs: ${m.specsRegistered}`);
  return panel('Metrics', lines, width);
}

function renderExperimentsPanel(data: DashboardData, width: number): string[] {
  const experiments = data.experiments.slice(-10).reverse();
  if (experiments.length === 0) {
    return panel('Recent experiments', [chalk.gray('(no experiments yet — run npm run self-improve)')], width);
  }
  const lines = experiments.map((e) => {
    const verdictColor = e.verdict.decision === 'PROMOTE' ? chalk.green : e.verdict.decision === 'REJECT' ? chalk.red : chalk.yellow;
    const delta = (e.result.test.meanNetR - e.result.parentTest.meanNetR).toFixed(3);
    const deltaStr = Number(delta) > 0 ? chalk.green(`+${delta}`) : Number(delta) < 0 ? chalk.red(delta) : chalk.gray(delta);
    const expId = e.experimentId.length > 20 ? e.experimentId.slice(0, 20) + '…' : e.experimentId;
    return `${expId.padEnd(22)} v${e.candidate.version.toString().padEnd(3)} ${verdictColor(e.verdict.decision.padEnd(16))} n=${e.result.test.n.toString().padEnd(4)} Δ=${deltaStr}`;
  });
  return panel('Recent experiments (last 10)', lines, width);
}

function renderEventsSparkline(data: DashboardData, width: number): string[] {
  // Group events by day and count them — a sparkline of research activity over time.
  if (data.events.length === 0) {
    return panel('Event activity', [chalk.gray('(no events)')], width);
  }
  const byDay = new Map<string, number>();
  for (const e of data.events) {
    const day = new Date(e.at).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const counts = [...byDay.values()];
  return panel('Event activity (events/day)', [sparkline(counts, width - 4)], width);
}

// ─── Full dashboard render ───────────────────────────────────────────────────

export interface DashboardOptions {
  width?: number;
  dataDir?: string;
}

/** Render the full dashboard as an array of lines (one per terminal row). */
export function renderDashboard(opts: DashboardOptions = {}): string[] {
  const width = opts.width ?? process.stdout.columns ?? 120;
  const data = loadDashboardData(opts.dataDir);

  const colWidth = Math.floor((width - 3) / 2);  // two columns with a 1-char gap + borders
  const fullWidth = width;

  const leftLines = renderChampionPanel(data, colWidth);
  const rightLines = renderMetricsPanel(data, colWidth);
  const experimentsLines = renderExperimentsPanel(data, fullWidth);
  const sparklineLines = renderEventsSparkline(data, fullWidth);

  // Pad the shorter column to match the taller one.
  const maxColHeight = Math.max(leftLines.length, rightLines.length);
  while (leftLines.length < maxColHeight) leftLines.push('');
  while (rightLines.length < maxColHeight) rightLines.push('');

  const lines: string[] = [];
  lines.push(chalk.bold.cyan('═'.repeat(width)));
  lines.push(chalk.bold.cyan('  Research Plane Dashboard') + chalk.gray(` — ${data.events.length} events, ${data.experiments.length} experiments`));
  lines.push(chalk.bold.cyan('═'.repeat(width)));
  lines.push('');

  // Two-column row: champion | metrics
  for (let i = 0; i < maxColHeight; i += 1) {
    lines.push(leftLines[i] + ' ' + rightLines[i]);
  }
  lines.push('');

  // Full-width: recent experiments
  for (const l of experimentsLines) lines.push(l);
  lines.push('');

  // Full-width: event activity sparkline
  for (const l of sparklineLines) lines.push(l);
  lines.push('');

  lines.push(chalk.gray('Run npm run self-improve to iterate; npm run self-improve:events for the audit trail.'));

  return lines;
}
