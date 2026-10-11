import type { MarketState } from '../market/types.js';
import type { SetupMap, SetupScenario } from '../decision/SetupTypes.js';
import type { AgentLedger } from '../learning/AgentLedger.js';
import { config } from '../config.js';
import { PERSONAS, CHAIR_INSTRUCTION, type PersonaModels } from './personas.js';
import type {
  ChairDecision,
  CouncilResult,
  PersonaMemory,
  PersonaOpinion,
  PersonaId,
  Stance,
} from './types.js';

export interface StructuredGenerator {
  generateJson<T>(prompt: string, model: string): Promise<T | null>;
}

interface RawOpinion {
  stance?: unknown;
  probability?: unknown;
  horizonMinutes?: unknown;
  scenarioId?: unknown;
  thesis?: unknown;
  invalidation?: unknown;
  riskFlags?: unknown;
}

interface RawChair {
  action?: unknown;
  stance?: unknown;
  probability?: unknown;
  scenarioId?: unknown;
  rationale?: unknown;
  dissent?: unknown;
  requiredConfirmation?: unknown;
  horizonMinutes?: unknown;
}

const STANCES = new Set<Stance>(['LONG', 'SHORT', 'NEUTRAL']);
const ACTIONS = new Set<ChairDecision['action']>(['TRADE', 'WATCH', 'NO_TRADE']);

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const cleanText = (value: unknown, fallback: string, max = 240): string => {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/[ \t\r\n]+/g, ' ').trim();
  return text ? text.slice(0, max) : fallback;
};

function parseStance(value: unknown): Stance | null {
  return typeof value === 'string' && STANCES.has(value as Stance) ? value as Stance : null;
}

function parseOpinion(
  persona: PersonaId,
  raw: RawOpinion,
  scenarioIds: Set<string>,
): PersonaOpinion | null {
  const stance = parseStance(raw.stance);
  if (!stance) return null;
  const probability = finiteNumber(raw.probability) ? clamp(raw.probability, 0.05, 0.95) : null;
  if (probability === null) return null;
  const horizon = finiteNumber(raw.horizonMinutes) ? clamp(Math.round(raw.horizonMinutes), 15, 240) : 60;
  const scenarioId = typeof raw.scenarioId === 'string' && scenarioIds.has(raw.scenarioId) ? raw.scenarioId : null;
  const riskFlags = Array.isArray(raw.riskFlags)
    ? raw.riskFlags.filter((v): v is string => typeof v === 'string').slice(0, 4).map((v) => cleanText(v, ''))
    : [];
  return {
    persona,
    stance,
    probability,
    horizonMinutes: horizon,
    scenarioId,
    thesis: cleanText(raw.thesis, 'No thesis supplied.'),
    invalidation: cleanText(raw.invalidation, 'No invalidation supplied.'),
    riskFlags,
  };
}

function parseChair(
  raw: RawChair,
  scenarioIds: Set<string>,
): ChairDecision | null {
  if (typeof raw.action !== 'string' || !ACTIONS.has(raw.action as ChairDecision['action'])) return null;
  const stance = parseStance(raw.stance);
  if (!stance) return null;
  const probability = finiteNumber(raw.probability) ? clamp(raw.probability, 0.05, 0.95) : null;
  if (probability === null) return null;
  const horizon = finiteNumber(raw.horizonMinutes) ? clamp(Math.round(raw.horizonMinutes), 15, 240) : 60;
  const scenarioId = typeof raw.scenarioId === 'string' && scenarioIds.has(raw.scenarioId) ? raw.scenarioId : null;
  return {
    persona: 'PORTFOLIO-CHAIR',
    action: raw.action as ChairDecision['action'],
    stance,
    probability,
    scenarioId,
    rationale: cleanText(raw.rationale, 'No synthesis supplied.'),
    dissent: cleanText(raw.dissent, 'No material dissent reported.'),
    requiredConfirmation: cleanText(raw.requiredConfirmation, 'Use deterministic setup trigger requirements.'),
    horizonMinutes: horizon,
  };
}

function scenarioBrief(scenarios: readonly SetupScenario[]): string[] {
  return scenarios.map((s) =>
    [
      'id=' + s.id,
      'kind=' + s.kind,
      'direction=' + s.direction,
      'state=' + s.state,
      'entry=' + s.entryLow + '-' + s.entryHigh,
      'sl=' + s.stopLoss,
      'tp1=' + s.target1,
      'rr=' + s.rewardRisk.toFixed(2),
      'trigger=' + s.trigger,
      'invalidation=' + s.invalidation,
    ].join(' | ')
  );
}

function evidencePacket(state: MarketState, setup: SetupMap): Record<string, unknown> {
  return {
    symbol: state.symbol,
    generatedAt: state.generatedAt,
    mark: state.mark,
    regime: state.regime,
    htf: {
      trend: state.htfStructure.trend,
      break: state.htfStructure.lastBreak,
    },
    ltf: {
      trend: state.ltfStructure.trend,
      break: state.ltfStructure.lastBreak,
    },
    pricing: state.pricing,
    liquidity: {
      htfPools: state.liquidity.htf.pools.slice(-8),
      ltfPools: state.liquidity.ltf.pools.slice(-8),
      recentSweeps: state.liquidity.ltf.recentSweeps.slice(-5),
    },
    zones: state.zones.slice(-8),
    crowding: state.crowding ?? null,
    setupState: setup.state,
    scenarios: scenarioBrief(setup.scenarios),
  };
}

const memoryText = (memory: PersonaMemory): Record<string, unknown> => ({
  actorId: memory.actorId,
  symbol: memory.symbol,
  resolved: memory.resolved,
  accuracy: memory.accuracy,
  brierScore: memory.brierScore,
});

function personaPrompt(
  instruction: string,
  evidence: Record<string, unknown>,
  memory: PersonaMemory,
): string {
  return [
    'You are one specialist in a crypto trading research council.',
    instruction,
    'Never claim privileged institutional intent. Never invent market data.',
    'Return JSON only with this exact shape:',
    '{"stance":"LONG|SHORT|NEUTRAL","probability":0.0,"horizonMinutes":60,"scenarioId":null,"thesis":"...","invalidation":"...","riskFlags":[]}',
    'probability is your stated probability that the selected stance is directionally correct over the horizon.',
    'Historical memory for this persona and symbol: ' + JSON.stringify(memoryText(memory)),
    'Deterministic market evidence: ' + JSON.stringify(evidence),
  ].join('\n');
}

function chairPrompt(
  evidence: Record<string, unknown>,
  reports: PersonaOpinion[],
  memory: PersonaMemory,
): string {
  return [
    'You are the portfolio chair of a crypto trading research council.',
    CHAIR_INSTRUCTION,
    'You do not place orders and you cannot override deterministic risk or execution controls.',
    'Return JSON only with this exact shape:',
    '{"action":"TRADE|WATCH|NO_TRADE","stance":"LONG|SHORT|NEUTRAL","probability":0.0,"scenarioId":null,"rationale":"...","dissent":"...","requiredConfirmation":"...","horizonMinutes":60}',
    'Chair historical memory: ' + JSON.stringify(memoryText(memory)),
    'Deterministic market evidence: ' + JSON.stringify(evidence),
    'Independent reports: ' + JSON.stringify(reports),
  ].join('\n');
}

function shouldAnalyze(
  lastAnalyzed: Map<string, number>,
  symbol: string,
  generatedAt: number,
): boolean {
  if (lastAnalyzed.get(symbol) === generatedAt) return false;
  lastAnalyzed.set(symbol, generatedAt);
  return true;
}

export class TradingCouncil {
  private readonly lastAnalyzed = new Map<string, number>();

  constructor(
    private readonly generator: StructuredGenerator,
    private readonly ledger: AgentLedger,
    private readonly enabled = config.llmCouncil.enabled,
    private readonly models: PersonaModels = config.ollama.models,
  ) {}

  async analyze(state: MarketState, setup: SetupMap): Promise<CouncilResult | null> {
    if (!this.enabled || !shouldAnalyze(this.lastAnalyzed, state.symbol, state.generatedAt)) return null;

    const evidence = evidencePacket(state, setup);
    const scenarioIds = new Set(setup.scenarios.map((s) => s.id));
    const opinions = await this.collectOpinions(state.symbol, state, evidence, scenarioIds);
    if (opinions.length === 0) return null;

    const chairMemory = this.ledger.personaMemory('PORTFOLIO-CHAIR', state.symbol);
    const rawChair = await this.generator.generateJson<RawChair>(
      chairPrompt(evidence, opinions, chairMemory),
      this.models.chair,
    );
    const chair = rawChair ? parseChair(rawChair, scenarioIds) : null;
    if (!chair) return null;

    this.ledger.recordPrediction({
      id: this.predictionId('PORTFOLIO-CHAIR', state.symbol, state.generatedAt),
      actorId: 'PORTFOLIO-CHAIR',
      symbol: state.symbol,
      stance: chair.stance,
      probability: chair.probability,
      mark: state.mark,
      thresholdPct: thresholdPct(state),
      horizonMinutes: chair.horizonMinutes,
      createdAt: Date.now(),
    });

    return { symbol: state.symbol, generatedAt: state.generatedAt, opinions, chair };
  }

  private async collectOpinions(
    symbol: string,
    state: MarketState,
    evidence: Record<string, unknown>,
    scenarioIds: Set<string>,
  ): Promise<PersonaOpinion[]> {
    const reports = await Promise.all(PERSONAS.map(async (persona) => {
      const memory = this.ledger.personaMemory(persona.id, symbol);
      const raw = await this.generator.generateJson<RawOpinion>(
        personaPrompt(persona.instruction, evidence, memory),
        this.models[persona.modelKey],
      );
      const opinion = raw ? parseOpinion(persona.id, raw, scenarioIds) : null;
      if (opinion) this.recordOpinionPrediction(symbol, state, opinion);
      return opinion;
    }));
    return reports.filter((report): report is PersonaOpinion => report !== null);
  }

  private recordOpinionPrediction(symbol: string, state: MarketState, opinion: PersonaOpinion): void {
    this.ledger.recordPrediction({
      id: this.predictionId(opinion.persona, symbol, state.generatedAt),
      actorId: opinion.persona,
      symbol,
      stance: opinion.stance,
      probability: opinion.probability,
      mark: state.mark,
      thresholdPct: thresholdPct(state),
      horizonMinutes: opinion.horizonMinutes,
      createdAt: Date.now(),
    });
  }

  private predictionId(actorId: string, symbol: string, generatedAt: number): string {
    return 'forecast:' + actorId + ':' + symbol + ':' + generatedAt;
  }
}

function thresholdPct(state: MarketState): number {
  const atr = state.timeframes['15m'].atr14 ?? 0;
  if (!(atr > 0) || !(state.mark > 0)) return 0.0025;
  return clamp((0.5 * atr) / state.mark, 0.0025, 0.02);
}
