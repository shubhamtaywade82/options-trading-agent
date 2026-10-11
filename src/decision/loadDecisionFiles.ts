import path from 'node:path';
import { DecisionJournal, type DecisionRecord } from './DecisionJournal.js';

/** Loads one or more comma-separated journal files into one list; a repeated decisionId keeps its latest record. */
export function loadDecisionFiles(spec: string): DecisionRecord[] {
  const merged = new Map<string, DecisionRecord>();
  for (const file of spec.split(',').map((f) => f.trim()).filter(Boolean)) {
    for (const record of new DecisionJournal(path.resolve(file)).all()) merged.set(record.decisionId, record);
  }
  return [...merged.values()].sort((a, b) => a.timestamp - b.timestamp);
}
