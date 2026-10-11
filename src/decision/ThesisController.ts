import type { SetupDirection, SetupMap, SetupScenario, ThesisTransition } from './SetupTypes.js';

interface Thesis {
  direction: SetupDirection;
  since: number;
  /** Stop of the strongest scenario backing the thesis: price beyond it kills the thesis outright. */
  invalidation: number;
  expiresAt: number;
  highestState: SetupScenario['state'];
  emptyCycles: number;
}

/** Cycles a thesis may have no live scenario before it is released (mirrors the setup ledger's grace). */
export const THESIS_EMPTY_GRACE_CYCLES = 3;

const RANK: Readonly<Record<SetupScenario['state'], number>> = { FORMING: 0, ARMED: 1, TRIGGERED: 2 };

const breached = (thesis: Thesis, mark: number): boolean =>
  thesis.direction === 'LONG' ? mark <= thesis.invalidation : mark >= thesis.invalidation;

function strongest(scenarios: readonly SetupScenario[]): SetupScenario | undefined {
  return [...scenarios].sort((a, b) => RANK[b.state] - RANK[a.state] || b.rewardRisk - a.rewardRisk)[0];
}

/**
 * One execution-authoritative directional thesis per symbol. A different direction may take over only on an
 * explicit transition: the old thesis' invalidation was breached, it expired, or the opposing side printed
 * a confirmed trigger while the old thesis never got past ARMED. Until then opposing scenarios are withheld
 * (COMPETING), so independent hypotheses cannot alternate between long and short around the same price.
 */
export class ThesisController {
  private readonly theses = new Map<string, Thesis>();

  apply(map: SetupMap): SetupMap {
    const now = map.generatedAt;
    const active = this.theses.get(map.symbol);
    const lead = strongest(map.scenarios);

    if (!lead) return this.idle(map, active);
    if (!active) return this.adopt(map, lead, now);
    if (lead.direction === active.direction) return this.refresh(map, active, lead);

    const reason = this.flipReason(active, map, lead);
    if (!reason) return this.withhold(map, active);
    const transition: ThesisTransition = { from: active.direction, to: lead.direction, reason, at: now };
    return { ...this.adopt(map, lead, now), thesisTransition: transition };
  }

  private flipReason(active: Thesis, map: SetupMap, lead: SetupScenario): ThesisTransition['reason'] | null {
    if (breached(active, map.mark)) return 'INVALIDATION_BREACHED';
    if (map.generatedAt >= active.expiresAt) return 'THESIS_EXPIRED';
    if (lead.state === 'TRIGGERED' && RANK[active.highestState] < RANK.TRIGGERED) return 'OPPOSING_TRIGGER';
    return null;
  }

  private adopt(map: SetupMap, lead: SetupScenario, now: number): SetupMap {
    const mine = map.scenarios.filter((s) => s.direction === lead.direction);
    this.theses.set(map.symbol, {
      direction: lead.direction, since: now, invalidation: lead.stopLoss,
      expiresAt: Math.max(...mine.map((s) => s.lifecycle?.expiresAt ?? now)),
      highestState: lead.state, emptyCycles: 0,
    });
    return this.stamp(map, lead.direction);
  }

  private refresh(map: SetupMap, active: Thesis, lead: SetupScenario): SetupMap {
    active.emptyCycles = 0;
    if (RANK[lead.state] > RANK[active.highestState]) active.highestState = lead.state;
    // The invalidation may tighten with a better-anchored scenario but never loosens: a thesis cannot un-break itself
    active.invalidation = lead.direction === 'LONG' ? Math.max(active.invalidation, lead.stopLoss) : Math.min(active.invalidation, lead.stopLoss);
    active.expiresAt = Math.max(active.expiresAt, ...map.scenarios.map((s) => s.lifecycle?.expiresAt ?? 0));
    return this.stamp(map, active.direction);
  }

  private idle(map: SetupMap, active: Thesis | undefined): SetupMap {
    if (!active) return map;
    active.emptyCycles += 1;
    if (breached(active, map.mark) || map.generatedAt >= active.expiresAt || active.emptyCycles > THESIS_EMPTY_GRACE_CYCLES) {
      this.theses.delete(map.symbol);
    }
    return map;
  }

  private withhold(map: SetupMap, active: Thesis): SetupMap {
    const competing = map.scenarios.filter((s) => s.direction !== active.direction);
    const withheldIds = competing.map((s) => s.id);
    const kept = map.scenarios.filter((s) => s.direction === active.direction);
    // Nothing on the authoritative side is live this cycle: report NO_TRADE rather than promote the challenger
    const reasons = ['competing ' + competing[0].direction + ' hypothesis withheld; ' + active.direction + ' thesis still authoritative'];
    return {
      ...map, scenarios: kept, withheldIds, state: kept.length === 0 ? 'NO_TRADE' : map.state,
      noTradeReasons: [...reasons, ...map.noTradeReasons].slice(0, 3),
    };
  }

  private stamp(map: SetupMap, direction: SetupDirection): SetupMap {
    return { ...map, scenarios: map.scenarios.map((s) => ({ ...s, thesisRole: s.direction === direction ? 'AUTHORITATIVE' as const : 'COMPETING' as const })) };
  }
}
