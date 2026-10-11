import type { SetupMap, SetupScenario, SetupState } from './SetupTypes.js';

type LiveState = SetupScenario['state'];
type Terminal = 'EXPIRED' | 'INVALIDATED';

const RANK: Readonly<Record<LiveState, number>> = { FORMING: 0, ARMED: 1, TRIGGERED: 2 };
const TOMBSTONE_TTL_MS = 24 * 60 * 60_000;
const ENTRY_MISSED_ATR = 1.5;
/** Cycles a setup may go un-derived (RR dip, pool shift) before it is written off; structural kills are immediate. */
export const SOFT_LOSS_GRACE_CYCLES = 3;

export type SetupTransition =
  | { kind: 'CREATED'; setupId: string; symbol: string; to: LiveState }
  | { kind: 'ADVANCED'; setupId: string; symbol: string; from: LiveState; to: LiveState }
  | { kind: 'EXPIRED' | 'INVALIDATED'; setupId: string; symbol: string; from: LiveState };

interface Entry {
  setupId: string;
  symbol: string;
  version: number;
  createdAt: number;
  expiresAt: number;
  state: LiveState;
  lastSeen: number;
  missedCycles: number;
  /** Levels are pinned at creation: entry, stop and targets never drift with the mark, so RR is stable. */
  frozen: Pick<SetupScenario, 'entryLow' | 'entryHigh' | 'stopLoss' | 'target1' | 'target2' | 'rewardRisk'>;
}

export interface LedgerResult {
  /** The map with expired/dead scenarios removed and lifecycle + monotonic state stamped on the rest. */
  map: SetupMap;
  /** Material events only: creation, state advance, expiry, invalidation. Price drift is never one. */
  transitions: SetupTransition[];
}

const mapState = (scenarios: readonly SetupScenario[]): SetupState => {
  if (scenarios.length === 0) return 'NO_TRADE';
  const top = Math.max(...scenarios.map((s) => RANK[s.state]));
  return top === 2 ? 'TRIGGERED' : top === 1 ? 'ARMED' : 'FORMING';
};

function entryStateOf(scenario: SetupScenario, mark: number, atr: number): NonNullable<SetupScenario['lifecycle']>['entryState'] {
  if (mark >= scenario.entryLow && mark <= scenario.entryHigh) return 'IN_ENTRY_ZONE';
  const beyond = scenario.direction === 'LONG' ? mark - scenario.entryHigh : scenario.entryLow - mark;
  // Price already ran away from the entry in the trade's direction: chasing is not an entry
  if (beyond > 0 && atr > 0 && beyond / atr > ENTRY_MISSED_ATR) return 'ENTRY_MISSED';
  return 'WAITING_ENTRY';
}

/**
 * Gives every scenario a persistent identity. Scenario ids are derived from the originating structural
 * event, so the same id across cycles is the same setup. Expiry is pinned at first sight; a setup that
 * expires or dies is tombstoned so the engine's stateless recomputation cannot resurrect it.
 */
export class SetupLedger {
  private readonly live = new Map<string, Entry>();
  private readonly dead = new Map<string, { reason: Terminal; at: number }>();

  /** `atr` is the 15m ATR used to judge whether an entry has been missed. */
  apply(map: SetupMap, atr = 0): LedgerResult {
    const now = map.generatedAt;
    const transitions: SetupTransition[] = [];
    this.evictTombstones(now);

    const kept: SetupScenario[] = [];
    const seen = new Set<string>();
    for (const scenario of map.scenarios) {
      const key = `${map.symbol}|${scenario.id}`;
      seen.add(key);
      if (this.dead.has(key)) continue;

      let entry = this.live.get(key);
      if (!entry) {
        // Anchored on the origin event; a setup discovered late still dies on the original clock
        const origin = Math.min(scenario.sourceTime, now);
        entry = {
          setupId: key, symbol: map.symbol, version: 1, createdAt: now,
          expiresAt: origin + scenario.expectedMove.thesisExpiryMinutes * 60_000,
          state: scenario.state, lastSeen: now, missedCycles: 0,
          frozen: {
            entryLow: scenario.entryLow, entryHigh: scenario.entryHigh, stopLoss: scenario.stopLoss,
            target1: scenario.target1, target2: scenario.target2, rewardRisk: scenario.rewardRisk,
          },
        };
        if (entry.expiresAt <= now) { this.dead.set(key, { reason: 'EXPIRED', at: now }); continue; }
        this.live.set(key, entry);
        transitions.push({ kind: 'CREATED', setupId: key, symbol: map.symbol, to: scenario.state });
      } else if (now >= entry.expiresAt) {
        this.retire(entry, 'EXPIRED', now, transitions);
        continue;
      } else if (RANK[scenario.state] > RANK[entry.state]) {
        transitions.push({ kind: 'ADVANCED', setupId: key, symbol: map.symbol, from: entry.state, to: scenario.state });
        entry.state = scenario.state;
      }
      entry.lastSeen = now;
      entry.missedCycles = 0;
      const pinned = { ...scenario, ...entry.frozen };

      kept.push({
        ...pinned,
        // Monotonic: a recomputed lower state (e.g. TRIGGERED -> FORMING as a break ages out of the window) is noise
        state: entry.state,
        lifecycle: {
          setupId: entry.setupId, version: entry.version, createdAt: entry.createdAt, expiresAt: entry.expiresAt,
          highestState: entry.state, entryState: entryStateOf(pinned, map.mark, atr), missedCycles: 0,
        },
      });
    }

    // A structural kill retires immediately; a mere absence is a soft loss and gets a grace window
    const killed = new Set((map.invalidatedIds ?? []).map((id) => `${map.symbol}|${id}`));
    for (const [key, entry] of [...this.live]) {
      if (entry.symbol !== map.symbol || seen.has(key)) continue;
      entry.missedCycles += 1;
      if (killed.has(key) || entry.missedCycles > SOFT_LOSS_GRACE_CYCLES) {
        this.retire(entry, 'INVALIDATED', now, transitions);
      } else if (now >= entry.expiresAt) {
        this.retire(entry, 'EXPIRED', now, transitions);
      }
    }

    const usable = kept.filter((s) => s.lifecycle?.entryState !== 'ENTRY_MISSED');
    const noTradeReasons = [...map.noTradeReasons];
    if (usable.length < kept.length) noTradeReasons.unshift('entry missed: price ran past the entry zone');
    return {
      map: { ...map, scenarios: usable, state: mapState(usable), noTradeReasons: noTradeReasons.slice(0, 3) },
      transitions,
    };
  }

  private retire(entry: Entry, reason: Terminal, now: number, out: SetupTransition[]): void {
    this.live.delete(entry.setupId);
    this.dead.set(entry.setupId, { reason, at: now });
    out.push({ kind: reason, setupId: entry.setupId, symbol: entry.symbol, from: entry.state });
  }

  private evictTombstones(now: number): void {
    for (const [key, tomb] of this.dead) if (now - tomb.at > TOMBSTONE_TTL_MS) this.dead.delete(key);
  }
}
