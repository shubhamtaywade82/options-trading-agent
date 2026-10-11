import type { PersonaId } from './types.js';

export interface PersonaDefinition {
  id: Exclude<PersonaId, 'PORTFOLIO-CHAIR'>;
  modelKey: keyof PersonaModels;
  instruction: string;
}

export interface PersonaModels {
  technical: string;
  liquidity: string;
  derivatives: string;
  regime: string;
  skeptic: string;
  chair: string;
}

export const PERSONAS: readonly PersonaDefinition[] = [
  {
    id: 'TECHNICAL-ANALYST',
    modelKey: 'technical',
    instruction:
      'Evaluate multi-timeframe trend, momentum, structure breaks, EMA/RSI/ADX/VWAP context. Use only supplied deterministic facts.',
  },
  {
    id: 'LIQUIDITY-ANALYST',
    modelKey: 'liquidity',
    instruction:
      'Evaluate liquidity pools, sweeps, fresh supply/demand zones, displacement and likely reaction paths. Do not invent hidden order flow.',
  },
  {
    id: 'DERIVATIVES-ANALYST',
    modelKey: 'derivatives',
    instruction:
      'Evaluate funding, open-interest expansion, taker aggression and crowding. Treat positioning as observable context, not certainty about intent.',
  },
  {
    id: 'REGIME-ANALYST',
    modelKey: 'regime',
    instruction:
      'Evaluate market regime, volatility, premium/discount location and whether the current environment supports continuation, reversal or abstention.',
  },
  {
    id: 'SKEPTIC-ANALYST',
    modelKey: 'skeptic',
    instruction:
      'Act as an adversarial reviewer. Search for invalidation, conflicting evidence, late entries, poor reward/risk and reasons to choose NO_TRADE.',
  },
];

export const CHAIR_INSTRUCTION =
  'Synthesize the independent analyst reports. Prefer agreement backed by independent evidence, preserve dissent, and choose only from supplied setup scenario IDs. The chair may recommend WATCH or NO_TRADE even when analysts disagree.';
