export type PersonaId =
  | 'TECHNICAL-ANALYST'
  | 'LIQUIDITY-ANALYST'
  | 'DERIVATIVES-ANALYST'
  | 'REGIME-ANALYST'
  | 'SKEPTIC-ANALYST'
  | 'PORTFOLIO-CHAIR';

export type Stance = 'LONG' | 'SHORT' | 'NEUTRAL';
export type CouncilAction = 'TRADE' | 'WATCH' | 'NO_TRADE';

export interface PersonaOpinion {
  persona: PersonaId;
  stance: Stance;
  probability: number;
  horizonMinutes: number;
  scenarioId: string | null;
  thesis: string;
  invalidation: string;
  riskFlags: string[];
}

export interface ChairDecision {
  persona: 'PORTFOLIO-CHAIR';
  action: CouncilAction;
  stance: Stance;
  probability: number;
  scenarioId: string | null;
  rationale: string;
  dissent: string;
  requiredConfirmation: string;
  horizonMinutes: number;
}

export interface CouncilResult {
  symbol: string;
  generatedAt: number;
  opinions: PersonaOpinion[];
  chair: ChairDecision;
}

export interface PersonaMemory {
  actorId: PersonaId;
  symbol: string;
  resolved: number;
  accuracy: number | null;
  brierScore: number | null;
}
