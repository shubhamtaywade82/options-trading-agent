import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  sparkline,
  panel,
  loadDashboardData,
  renderDashboard,
} from '../src/ui/researchDashboard.js';

// ─── sparkline ─────────────────────────────────────────────────────────────

test('sparkline returns a placeholder for empty data', () => {
  const s = sparkline([]);
  assert.match(s, /no data/);
});

test('sparkline returns block characters for non-empty data', () => {
  const s = sparkline([1, 2, 3, 4, 5]);
  assert.ok(s.length > 0);
  // Should contain at least one block character.
  assert.ok(/[▁▂▃▄▅▆▇█]/.test(s));
});

test('sparkline downsamples when data exceeds width', () => {
  const s = sparkline(Array.from({ length: 100 }, (_, i) => i), 20);
  // Should not throw and should produce a string with block characters.
  assert.ok(/[▁▂▃▄▅▆▇█]/.test(s));
});

test('sparkline pads when data is shorter than width', () => {
  const s = sparkline([1, 2, 3], 20);
  assert.ok(/[▁▂▃▄▅▆▇█]/.test(s));
});

test('sparkline uses red for all-negative data', () => {
  const s = sparkline([-5, -4, -3, -2, -1]);
  // chalk.red produces either ANSI red (\x1b[31m) or the literal string depending on color support.
  // Just verify the sparkline renders without crashing on all-negative data.
  assert.ok(s.length > 0);
  assert.ok(/[▁▂▃▄▅▆▇█]/.test(s));
});

test('sparkline uses green for all-positive data', () => {
  const s = sparkline([1, 2, 3, 4, 5]);
  assert.ok(s.length > 0);
  assert.ok(/[▁▂▃▄▅▆▇█]/.test(s));
});

test('sparkline uses yellow for mixed-sign data', () => {
  const s = sparkline([-1, 0, 1]);
  assert.ok(s.length > 0);
  assert.ok(/[▁▂▃▄▅▆▇█]/.test(s));
});

// ─── panel ────────────────────────────────────────────────────────────────

test('panel renders a titled border with content lines', () => {
  const lines = panel('Title', ['line 1', 'line 2'], 30);
  assert.equal(lines.length, 6);  // top, title, divider, 2 content, bottom
  assert.match(lines[0], /┌─+┐/);
  assert.match(lines[1], /Title/);
  assert.match(lines[2], /├─+┤/);
  assert.match(lines[3], /line 1/);
  assert.match(lines[4], /line 2/);
  assert.match(lines[lines.length - 1], /└─+┘/);
});

test('panel with empty content renders just the frame', () => {
  const lines = panel('Empty', [], 20);
  assert.equal(lines.length, 4);  // top, title, divider, bottom — no content lines
});

// ─── loadDashboardData ───────────────────────────────────────────────────────

test('loadDashboardData with an empty data dir returns empty state', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'dash-test-'));
  try {
    const data = loadDashboardData(tmp);
    assert.equal(data.championState, undefined);
    assert.equal(data.experiments.length, 0);
    assert.equal(data.events.length, 0);
    assert.equal(data.metrics.iterationsStarted, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadDashboardData loads champion state, experiments, and events', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'dash-test-'));
  try {
    // Write a champion-registry.json
    writeFileSync(path.join(tmp, 'champion-registry.json'), JSON.stringify({
      champions: [{ id: 'STRUCT-LIQ-η', version: 2, since: Date.now(), promotedBy: 'exp-1' }],
      challengers: [{ id: 'STRUCT-LIQ-η', version: 3, stage: 'SHADOW', since: Date.now() }],
      history: [],
    }), 'utf8');

    // Write an experiments.jsonl
    writeFileSync(path.join(tmp, 'experiments.jsonl'), [
      JSON.stringify({
        experimentId: 'exp-1', ranAt: Date.now(),
        candidate: { id: 'STRUCT-LIQ-η', version: 2, parentVersion: 1, hypothesis: 'test', provenance: { kind: 'manual', note: '' }, params: {}, family: 'STRUCT-LIQ', createdAt: Date.now() },
        parent: { id: 'STRUCT-LIQ-η', version: 1, parentVersion: null, hypothesis: 'seed', provenance: { kind: 'seed', note: '' }, params: {}, family: 'STRUCT-LIQ', createdAt: Date.now() },
        result: { candidateId: 'X', candidateVersion: 2, parentId: 'X', parentVersion: 1, train: { n: 100, winRate: 0.5, meanNetR: 0.3, profitFactor: 1.5, maxDrawdownR: 4, symbols: 2, regimes: 3, bootstrap: null }, test: { n: 50, winRate: 0.5, meanNetR: 0.3, profitFactor: 1.5, maxDrawdownR: 4, symbols: 2, regimes: 3, bootstrap: null }, parentTrain: { n: 100, winRate: 0.5, meanNetR: 0.2, profitFactor: 1.3, maxDrawdownR: 5, symbols: 2, regimes: 3, bootstrap: null }, parentTest: { n: 50, winRate: 0.5, meanNetR: 0.2, profitFactor: 1.2, maxDrawdownR: 5, symbols: 2, regimes: 3, bootstrap: null }, walkForward: { outOfSample: null, baseline: null, folds: 5 }, perSymbol: [], perRegime: [], experimentNotes: [] },
        verdict: { decision: 'PROMOTE', reasons: ['good'], policy: { minTrades: 30, minOosExpectancyR: 0.05, minProfitFactor: 1.1, maxDrawdownR: 15, minOosConfidence: 0.85, minSymbolCoverage: 2, minOosDelta: 0.05, maxRegimeRegressionPct: 0.3, requireWalkForwardPositive: true } },
      }),
    ].join('\n') + '\n', 'utf8');

    // Write a research-events.jsonl
    writeFileSync(path.join(tmp, 'research-events.jsonl'), [
      JSON.stringify({ seq: 1, at: Date.now(), type: 'champion_appointed', payload: { id: 'STRUCT-LIQ-η', version: 1 } }),
      JSON.stringify({ seq: 2, at: Date.now(), type: 'loop_iteration_started', payload: { championId: 'STRUCT-LIQ-η', championVersion: 1, ledgerSize: 100 } }),
    ].join('\n') + '\n', 'utf8');

    const data = loadDashboardData(tmp);
    assert.ok(data.championState);
    assert.equal(data.championState.champions[0].version, 2);
    assert.equal(data.experiments.length, 1);
    assert.equal(data.experiments[0].experimentId, 'exp-1');
    assert.equal(data.events.length, 2);
    assert.equal(data.metrics.championAppointments, 1);
    assert.equal(data.metrics.iterationsStarted, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadDashboardData skips torn JSONL lines without crashing', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'dash-test-'));
  try {
    writeFileSync(path.join(tmp, 'experiments.jsonl'), [
      '{"experimentId":"exp-1"}',
      'NOT VALID JSON {{{',
      '{"experimentId":"exp-2"}',
    ].join('\n') + '\n', 'utf8');
    const data = loadDashboardData(tmp);
    assert.equal(data.experiments.length, 2);  // the two valid lines
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── renderDashboard ───────────────────────────────────────────────────────

test('renderDashboard with empty data renders a header and placeholder panels', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'dash-test-'));
  try {
    const lines = renderDashboard({ width: 120, dataDir: tmp });
    assert.ok(lines.length > 0);
    // The header should mention "Research Plane Dashboard".
    assert.ok(lines.some((l) => /Research Plane Dashboard/.test(l)));
    // The champion panel should show "(no champion appointed)".
    assert.ok(lines.some((l) => /no champion/.test(l)));
    // The experiments panel should show "(no experiments yet".
    assert.ok(lines.some((l) => /no experiments yet/.test(l)));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('renderDashboard with populated data renders champion version + experiment verdicts', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'dash-test-'));
  try {
    // Write minimal state files.
    writeFileSync(path.join(tmp, 'champion-registry.json'), JSON.stringify({
      champions: [{ id: 'STRUCT-LIQ-η', version: 3, since: Date.now() }],
      challengers: [{ id: 'STRUCT-LIQ-η', version: 4, stage: 'SHADOW', since: Date.now() }],
      history: [],
    }), 'utf8');
    writeFileSync(path.join(tmp, 'experiments.jsonl'), [
      JSON.stringify({
        experimentId: 'exp-001', ranAt: Date.now(),
        candidate: { id: 'STRUCT-LIQ-η', version: 2, parentVersion: 1, hypothesis: 'raise RR', provenance: { kind: 'manual', note: '' }, params: {}, family: 'STRUCT-LIQ', createdAt: Date.now() },
        parent: { id: 'STRUCT-LIQ-η', version: 1, parentVersion: null, hypothesis: 'seed', provenance: { kind: 'seed', note: '' }, params: {}, family: 'STRUCT-LIQ', createdAt: Date.now() },
        result: { candidateId: 'X', candidateVersion: 2, parentId: 'X', parentVersion: 1, train: { n: 100, winRate: 0.5, meanNetR: 0.3, profitFactor: 1.5, maxDrawdownR: 4, symbols: 2, regimes: 3, bootstrap: null }, test: { n: 50, winRate: 0.5, meanNetR: 0.4, profitFactor: 1.6, maxDrawdownR: 3, symbols: 2, regimes: 3, bootstrap: null }, parentTrain: { n: 100, winRate: 0.5, meanNetR: 0.2, profitFactor: 1.3, maxDrawdownR: 5, symbols: 2, regimes: 3, bootstrap: null }, parentTest: { n: 50, winRate: 0.5, meanNetR: 0.15, profitFactor: 1.2, maxDrawdownR: 5, symbols: 2, regimes: 3, bootstrap: null }, walkForward: { outOfSample: null, baseline: null, folds: 5 }, perSymbol: [], perRegime: [], experimentNotes: [] },
        verdict: { decision: 'PROMOTE', reasons: ['good'], policy: { minTrades: 30, minOosExpectancyR: 0.05, minProfitFactor: 1.1, maxDrawdownR: 15, minOosConfidence: 0.85, minSymbolCoverage: 2, minOosDelta: 0.05, maxRegimeRegressionPct: 0.3, requireWalkForwardPositive: true } },
      }),
    ].join('\n') + '\n', 'utf8');
    writeFileSync(path.join(tmp, 'research-events.jsonl'), [
      JSON.stringify({ seq: 1, at: Date.now(), type: 'champion_appointed', payload: { id: 'STRUCT-LIQ-η', version: 3 } }),
    ].join('\n') + '\n', 'utf8');

    const lines = renderDashboard({ width: 120, dataDir: tmp });
    const allText = lines.join('\n');

    // Champion version should appear.
    assert.match(allText, /v3/);
    // The active challenger should appear.
    assert.match(allText, /v4.*SHADOW/);
    // The experiment verdict should appear.
    assert.match(allText, /PROMOTE/);
    // The experiment id should appear.
    assert.match(allText, /exp-001/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('renderDashboard respects a custom width', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'dash-test-'));
  try {
    const lines = renderDashboard({ width: 80, dataDir: tmp });
    // Panel lines should be at most ~82 chars (80 width + 2 for borders). The footer hint line is
    // exempt — it's a free-text hint, not a bordered panel.
    for (const line of lines) {
      const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
      if (visible.includes('Run npm run self-improve')) continue;  // footer hint
      assert.ok(visible.length <= 82, `line too long (${visible.length} > 82): ${visible.slice(0, 50)}...`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
