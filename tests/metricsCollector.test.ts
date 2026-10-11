import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MetricsCollector,
  attachCollector,
  replayEvents,
  formatMetrics,
  type ResearchMetrics,
} from '../src/research/MetricsCollector.js';
import { ResearchEventBus, type ResearchEvent } from '../src/research/Events.js';

/** Build a minimal event with the required seq + at fields. */
function event(type: ResearchEvent['type'], payload: Record<string, unknown>, seq: number, at: number): ResearchEvent {
  return { type, payload, seq, at } as ResearchEvent;
}

test('MetricsCollector starts with all-zero counters', () => {
  const c = new MetricsCollector();
  const m = c.snapshot();
  assert.equal(m.iterationsStarted, 0);
  assert.equal(m.experimentsCompleted, 0);
  assert.equal(m.hypothesesProposed, 0);
  assert.equal(m.promotionRate, 0);
  assert.equal(m.repairSuccessRate, 0);
  assert.equal(m.llmHypothesisRate, 0);
});

test('MetricsCollector tracks loop_iteration_started and loop_iteration_completed', () => {
  const c = new MetricsCollector();
  c.record(event('loop_iteration_started', { championId: 'X', championVersion: 1, ledgerSize: 100 }, 1, 1000));
  c.record(event('loop_iteration_started', { championId: 'X', championVersion: 1, ledgerSize: 100 }, 2, 2000));
  c.record(event('loop_iteration_completed', { championId: 'X', championVersion: 1, hypothesesProposed: 1, experimentsRun: 1, newShadowStaged: false }, 3, 3000));
  const m = c.snapshot();
  assert.equal(m.iterationsStarted, 2);
  assert.equal(m.iterationsCompleted, 1);
});

test('MetricsCollector tracks hypothesis_proposed with source split', () => {
  const c = new MetricsCollector();
  c.record(event('hypothesis_proposed', { hypothesisId: 'h1', source: 'llm', observation: 'a', proposal: 'b', changes: {} }, 1, 1000));
  c.record(event('hypothesis_proposed', { hypothesisId: 'h2', source: 'llm', observation: 'a', proposal: 'b', changes: {} }, 2, 2000));
  c.record(event('hypothesis_proposed', { hypothesisId: 'h3', source: 'fallback', observation: 'a', proposal: 'b', changes: {} }, 3, 3000));
  const m = c.snapshot();
  assert.equal(m.hypothesesProposed, 3);
  assert.equal(m.hypothesesFromLlm, 2);
  assert.equal(m.hypothesesFromFallback, 1);
  assert.equal(m.llmHypothesisRate, 2 / 3);
});

test('MetricsCollector tracks hypothesis_repaired with success/failure split', () => {
  const c = new MetricsCollector();
  c.record(event('hypothesis_repaired', { ok: true, attempts: 1, errorCount: 0 }, 1, 1000));
  c.record(event('hypothesis_repaired', { ok: true, attempts: 2, errorCount: 0 }, 2, 2000));
  c.record(event('hypothesis_repaired', { ok: false, attempts: 2, errorCount: 3, firstError: 'bad json' }, 3, 3000));
  const m = c.snapshot();
  assert.equal(m.repairLoopInvocations, 3);
  assert.equal(m.repairLoopSucceeded, 2);
  assert.equal(m.repairLoopFailed, 1);
  assert.equal(m.repairSuccessRate, 2 / 3);
});

test('MetricsCollector tracks experiment_started and experiment_completed with verdict split', () => {
  const c = new MetricsCollector();
  c.record(event('experiment_started', { experimentId: 'e1', candidateId: 'X', candidateVersion: 2, parentId: 'X', parentVersion: 1 }, 1, 1000));
  c.record(event('experiment_started', { experimentId: 'e2', candidateId: 'X', candidateVersion: 3, parentId: 'X', parentVersion: 2 }, 2, 2000));
  c.record(event('experiment_completed', { experimentId: 'e1', candidateId: 'X', candidateVersion: 2, decision: 'PROMOTE', testN: 50, testMeanR: 0.3, parentTestMeanR: 0.15, policy: {} as never, experimentNotes: [] }, 3, 3000));
  c.record(event('experiment_completed', { experimentId: 'e2', candidateId: 'X', candidateVersion: 3, decision: 'REJECT', testN: 40, testMeanR: -0.1, parentTestMeanR: 0.2, policy: {} as never, experimentNotes: [] }, 4, 4000));
  const m = c.snapshot();
  assert.equal(m.experimentsStarted, 2);
  assert.equal(m.experimentsCompleted, 2);
  assert.equal(m.experimentsPromoted, 1);
  assert.equal(m.experimentsRejected, 1);
  assert.equal(m.experimentsInsufficientData, 0);
  assert.equal(m.promotionRate, 0.5);
});

test('MetricsCollector tracks INSUFFICIENT_DATA verdict separately from REJECT', () => {
  const c = new MetricsCollector();
  c.record(event('experiment_started', { experimentId: 'e1', candidateId: 'X', candidateVersion: 2, parentId: 'X', parentVersion: 1 }, 1, 1000));
  c.record(event('experiment_completed', { experimentId: 'e1', candidateId: 'X', candidateVersion: 2, decision: 'INSUFFICIENT_DATA', testN: 5, testMeanR: 0, parentTestMeanR: 0, policy: {} as never, experimentNotes: [] }, 2, 2000));
  const m = c.snapshot();
  assert.equal(m.experimentsInsufficientData, 1);
  assert.equal(m.experimentsRejected, 0);
  assert.equal(m.experimentsPromoted, 0);
  assert.equal(m.promotionRate, 0);
});

test('MetricsCollector computes avg experiment duration from started→completed pairs', () => {
  const c = new MetricsCollector();
  // experiment 1: started at 1000, completed at 1500 (500ms)
  c.record(event('experiment_started', { experimentId: 'e1', candidateId: 'X', candidateVersion: 2, parentId: 'X', parentVersion: 1 }, 1, 1000));
  c.record(event('experiment_completed', { experimentId: 'e1', candidateId: 'X', candidateVersion: 2, decision: 'REJECT', testN: 40, testMeanR: 0, parentTestMeanR: 0, policy: {} as never, experimentNotes: [] }, 2, 1500));
  // experiment 2: started at 2000, completed at 2900 (900ms)
  c.record(event('experiment_started', { experimentId: 'e2', candidateId: 'X', candidateVersion: 3, parentId: 'X', parentVersion: 2 }, 3, 2000));
  c.record(event('experiment_completed', { experimentId: 'e2', candidateId: 'X', candidateVersion: 3, decision: 'REJECT', testN: 40, testMeanR: 0, parentTestMeanR: 0, policy: {} as never, experimentNotes: [] }, 4, 2900));
  const m = c.snapshot();
  assert.equal(m.avgExperimentDurationMs, 700); // (500 + 900) / 2
});

test('MetricsCollector handles orphan experiment_completed (no matching started) without crashing', () => {
  const c = new MetricsCollector();
  c.record(event('experiment_completed', { experimentId: 'orphan', candidateId: 'X', candidateVersion: 2, decision: 'REJECT', testN: 40, testMeanR: 0, parentTestMeanR: 0, policy: {} as never, experimentNotes: [] }, 1, 1000));
  const m = c.snapshot();
  assert.equal(m.experimentsCompleted, 1);
  assert.equal(m.avgExperimentDurationMs, 0); // no duration recorded
});

test('MetricsCollector tracks champion_appointed, challenger_staged, champion_rolled_back', () => {
  const c = new MetricsCollector();
  c.record(event('champion_appointed', { id: 'X', version: 1 }, 1, 1000));
  c.record(event('champion_appointed', { id: 'X', version: 2, replacedVersion: 1 }, 2, 2000));
  c.record(event('challenger_staged', { id: 'X', version: 3 }, 3, 3000));
  c.record(event('champion_rolled_back', { id: 'X', fromVersion: 2, toVersion: 1, reason: 'canary failure' }, 4, 4000));
  const m = c.snapshot();
  assert.equal(m.championAppointments, 2);
  assert.equal(m.challengersStaged, 1);
  assert.equal(m.championRollbacks, 1);
});

test('MetricsCollector tracks challenger_transitioned by destination stage', () => {
  const c = new MetricsCollector();
  c.record(event('challenger_transitioned', { id: 'X', version: 2, from: 'SHADOW', to: 'PAPER' }, 1, 1000));
  c.record(event('challenger_transitioned', { id: 'X', version: 2, from: 'PAPER', to: 'CANARY' }, 2, 2000));
  c.record(event('challenger_transitioned', { id: 'X', version: 2, from: 'CANARY', to: 'PROMOTED' }, 3, 3000));
  c.record(event('challenger_transitioned', { id: 'X', version: 3, from: 'SHADOW', to: 'REJECTED' }, 4, 4000));
  c.record(event('challenger_transitioned', { id: 'X', version: 4, from: 'SHADOW', to: 'PAPER' }, 5, 5000));
  const m = c.snapshot();
  assert.equal(m.challengersTransitionedToPaper, 2);
  assert.equal(m.challengersTransitionedToCanary, 1);
  assert.equal(m.challengersTransitionedToPromoted, 1);
  assert.equal(m.challengersTransitionedToRejected, 1);
});

test('MetricsCollector tracks spec_registered', () => {
  const c = new MetricsCollector();
  c.record(event('spec_registered', { id: 'X', version: 1, parentVersion: null, hypothesis: 'seed', provenance: 'seed' }, 1, 1000));
  c.record(event('spec_registered', { id: 'X', version: 2, parentVersion: 1, hypothesis: 'v2', provenance: 'researcher' }, 2, 2000));
  const m = c.snapshot();
  assert.equal(m.specsRegistered, 2);
});

test('MetricsCollector.reset clears all counters', () => {
  const c = new MetricsCollector();
  c.record(event('loop_iteration_started', { championId: 'X', championVersion: 1, ledgerSize: 100 }, 1, 1000));
  c.record(event('experiment_started', { experimentId: 'e1', candidateId: 'X', candidateVersion: 2, parentId: 'X', parentVersion: 1 }, 2, 2000));
  assert.equal(c.snapshot().iterationsStarted, 1);
  c.reset();
  const m = c.snapshot();
  assert.equal(m.iterationsStarted, 0);
  assert.equal(m.experimentsStarted, 0);
  assert.equal(m.avgExperimentDurationMs, 0);
});

test('MetricsCollector.snapshot returns a frozen copy (mutating it does not affect the collector)', () => {
  const c = new MetricsCollector();
  c.record(event('loop_iteration_started', { championId: 'X', championVersion: 1, ledgerSize: 100 }, 1, 1000));
  const snap1 = c.snapshot();
  // snapshot returns a shallow copy, not the internal state — mutating it is safe.
  (snap1 as ResearchMetrics).iterationsStarted = 999;
  const snap2 = c.snapshot();
  assert.equal(snap2.iterationsStarted, 1);
});

test('attachCollector wires the collector to the bus as a subscriber', async () => {
  const bus = new ResearchEventBus();
  const collector = new MetricsCollector();
  attachCollector(bus, collector);
  await bus.publish({ type: 'loop_iteration_started', payload: { championId: 'X', championVersion: 1, ledgerSize: 100 } });
  await bus.publish({ type: 'experiment_started', payload: { experimentId: 'e1', candidateId: 'X', candidateVersion: 2, parentId: 'X', parentVersion: 1 } });
  const m = collector.snapshot();
  assert.equal(m.iterationsStarted, 1);
  assert.equal(m.experimentsStarted, 1);
});

test('replayEvents reconstructs metrics from a persisted event stream', () => {
  const events: ResearchEvent[] = [
    event('champion_appointed', { id: 'X', version: 1 }, 1, 1000),
    event('loop_iteration_started', { championId: 'X', championVersion: 1, ledgerSize: 100 }, 2, 2000),
    event('hypothesis_proposed', { hypothesisId: 'h1', source: 'llm', observation: 'a', proposal: 'b', changes: {} }, 3, 3000),
    event('experiment_started', { experimentId: 'e1', candidateId: 'X', candidateVersion: 2, parentId: 'X', parentVersion: 1 }, 4, 4000),
    event('experiment_completed', { experimentId: 'e1', candidateId: 'X', candidateVersion: 2, decision: 'PROMOTE', testN: 50, testMeanR: 0.3, parentTestMeanR: 0.15, policy: {} as never, experimentNotes: [] }, 5, 4500),
    event('challenger_staged', { id: 'X', version: 2 }, 6, 5000),
    event('loop_iteration_completed', { championId: 'X', championVersion: 1, hypothesesProposed: 1, experimentsRun: 1, newShadowStaged: true }, 7, 6000),
  ];
  const m = replayEvents(events);
  assert.equal(m.championAppointments, 1);
  assert.equal(m.iterationsStarted, 1);
  assert.equal(m.iterationsCompleted, 1);
  assert.equal(m.hypothesesProposed, 1);
  assert.equal(m.hypothesesFromLlm, 1);
  assert.equal(m.experimentsStarted, 1);
  assert.equal(m.experimentsCompleted, 1);
  assert.equal(m.experimentsPromoted, 1);
  assert.equal(m.promotionRate, 1);
  assert.equal(m.challengersStaged, 1);
  assert.equal(m.avgExperimentDurationMs, 500);
});

test('formatMetrics produces a human-readable multi-line string with key counters and rates', () => {
  const c = new MetricsCollector();
  c.record(event('loop_iteration_started', { championId: 'X', championVersion: 1, ledgerSize: 100 }, 1, 1000));
  c.record(event('hypothesis_proposed', { hypothesisId: 'h1', source: 'llm', observation: 'a', proposal: 'b', changes: {} }, 2, 2000));
  c.record(event('experiment_started', { experimentId: 'e1', candidateId: 'X', candidateVersion: 2, parentId: 'X', parentVersion: 1 }, 3, 3000));
  c.record(event('experiment_completed', { experimentId: 'e1', candidateId: 'X', candidateVersion: 2, decision: 'PROMOTE', testN: 50, testMeanR: 0.3, parentTestMeanR: 0.15, policy: {} as never, experimentNotes: [] }, 4, 3500));
  const text = formatMetrics(c.snapshot());
  assert.match(text, /Research-plane metrics/);
  assert.match(text, /iterations started\/completed: 1\/0/);  // iteration not completed yet
  assert.match(text, /proposed: 1 \(LLM: 1, fallback: 0\)/);
  assert.match(text, /promotion rate: 100\.0%/);
  assert.match(text, /avg experiment duration: 500ms/);
  assert.match(text, /appointments: 0/);  // no champion_appointed event fired
});

test('derived rates are 0 when the denominator is 0 (no division by zero)', () => {
  const c = new MetricsCollector();
  const m = c.snapshot();
  assert.equal(m.promotionRate, 0);
  assert.equal(m.repairSuccessRate, 0);
  assert.equal(m.llmHypothesisRate, 0);
  assert.ok(Number.isFinite(m.promotionRate));
  assert.ok(Number.isFinite(m.repairSuccessRate));
  assert.ok(Number.isFinite(m.llmHypothesisRate));
});

test('a full loop iteration produces the expected metric counts', async () => {
  // Simulate one full loop: iteration_start, 2 hypotheses (1 llm, 1 fallback), 2 experiments (1 promote, 1 reject),
  // 1 challenger staged, iteration_complete. Verify every counter.
  const bus = new ResearchEventBus();
  const collector = new MetricsCollector();
  attachCollector(bus, collector);

  await bus.publish({ type: 'loop_iteration_started', payload: { championId: 'X', championVersion: 1, ledgerSize: 100 } });
  await bus.publish({ type: 'hypothesis_proposed', payload: { hypothesisId: 'h1', source: 'llm', observation: 'a', proposal: 'b', changes: { minimumRewardRisk: 1.7 } } });
  await bus.publish({ type: 'hypothesis_proposed', payload: { hypothesisId: 'h2', source: 'fallback', observation: 'c', proposal: 'd', changes: { minSweepDepthAtr: 0.5 } } });
  await bus.publish({ type: 'experiment_started', payload: { experimentId: 'e1', candidateId: 'X', candidateVersion: 2, parentId: 'X', parentVersion: 1 } });
  await bus.publish({ type: 'experiment_completed', payload: { experimentId: 'e1', candidateId: 'X', candidateVersion: 2, decision: 'PROMOTE', testN: 50, testMeanR: 0.3, parentTestMeanR: 0.15, policy: {} as never, experimentNotes: [] } });
  await bus.publish({ type: 'experiment_started', payload: { experimentId: 'e2', candidateId: 'X', candidateVersion: 3, parentId: 'X', parentVersion: 1 } });
  await bus.publish({ type: 'experiment_completed', payload: { experimentId: 'e2', candidateId: 'X', candidateVersion: 3, decision: 'REJECT', testN: 40, testMeanR: -0.1, parentTestMeanR: 0.2, policy: {} as never, experimentNotes: [] } });
  await bus.publish({ type: 'challenger_staged', payload: { id: 'X', version: 2 } });
  await bus.publish({ type: 'loop_iteration_completed', payload: { championId: 'X', championVersion: 1, hypothesesProposed: 2, experimentsRun: 2, newShadowStaged: true } });

  const m = collector.snapshot();
  assert.equal(m.iterationsStarted, 1);
  assert.equal(m.iterationsCompleted, 1);
  assert.equal(m.hypothesesProposed, 2);
  assert.equal(m.hypothesesFromLlm, 1);
  assert.equal(m.hypothesesFromFallback, 1);
  assert.equal(m.llmHypothesisRate, 0.5);
  assert.equal(m.experimentsStarted, 2);
  assert.equal(m.experimentsCompleted, 2);
  assert.equal(m.experimentsPromoted, 1);
  assert.equal(m.experimentsRejected, 1);
  assert.equal(m.promotionRate, 0.5);
  assert.equal(m.challengersStaged, 1);
  assert.ok(m.avgExperimentDurationMs >= 0);
});
