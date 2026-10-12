import type { ChainSnapshot } from '../options/selector.js';
import { minStrikeStep, nearestAtmStrike, targetEntryStrike } from '../options/selector.js';
import type { OptionType } from '../domain/types.js';
import type { ChainWatchView } from './views.js';

const EPSILON = 1e-6;
const STRIKE_RADIUS = 2;

export interface ChainWatchBuildInput {
  readonly symbol: string;
  readonly spot: number | undefined;
  readonly chain: ChainSnapshot | undefined;
  readonly offsetSteps: number;
  readonly maxSpreadPct: number;
  readonly minOpenInterest: number;
  readonly openPosition: { readonly strike: number; readonly optionType: OptionType } | undefined;
  readonly nowMs: number;
  readonly status: ChainWatchView['status'];
  readonly error: string | undefined;
}

function spreadPct(bid: number | undefined, ask: number | undefined): number | undefined {
  if (bid === undefined || ask === undefined || !(bid > 0) || !(ask >= bid)) {
    return undefined;
  }
  const mid = (bid + ask) / 2;
  return mid > 0 ? ((ask - bid) / mid) * 100 : undefined;
}

function legPasses(spread: number | undefined, oi: number | undefined, maxSpreadPct: number, minOi: number): boolean {
  if (spread === undefined || spread > maxSpreadPct) {
    return false;
  }
  return (oi ?? 0) >= minOi;
}

function sliceAroundAtm(strikes: readonly number[], atm: number): number[] {
  const index = strikes.findIndex((strike) => Math.abs(strike - atm) < EPSILON);
  if (index < 0) {
    return [];
  }
  const start = Math.max(0, index - STRIKE_RADIUS);
  const end = Math.min(strikes.length, index + STRIKE_RADIUS + 1);
  return strikes.slice(start, end);
}

/** Read-only chain ladder for the cockpit; mirrors entry strike selection without trading. */
export function buildChainWatchView(input: ChainWatchBuildInput): ChainWatchView {
  const base = {
    symbol: input.symbol,
    spot: input.spot,
    expiry: input.chain?.expiry,
    atmStrike: undefined as number | undefined,
    bullishEntryStrike: undefined as number | undefined,
    bearishEntryStrike: undefined as number | undefined,
    fetchedAgeMs: input.chain === undefined ? undefined : Math.max(0, input.nowMs - input.chain.fetchedAt),
    status: input.status,
    error: input.error,
    rows: [] as ChainWatchView['rows'],
    maxOpenInterest: 0,
  };
  if (input.spot === undefined) {
    return { ...base, status: input.status === 'ready' ? 'waiting_spot' : input.status };
  }
  if (input.chain === undefined || input.chain.strikes.length === 0) {
    return base;
  }

  const strikePrices = [...new Set(input.chain.strikes.map((row) => row.strike))].sort((a, b) => a - b);
  const atm = nearestAtmStrike(input.spot, strikePrices);
  const step = minStrikeStep(strikePrices);
  if (atm === undefined || step === undefined) {
    return { ...base, expiry: input.chain.expiry, status: 'error', error: 'chain too thin to show strikes' };
  }

  const bullishEntryStrike = targetEntryStrike(atm, step, 'BULLISH', input.offsetSteps);
  const bearishEntryStrike = targetEntryStrike(atm, step, 'BEARISH', input.offsetSteps);
  const visible = sliceAroundAtm(strikePrices, atm);
  let maxOi = 1;
  const rows = visible.map((strike) => {
    const row = input.chain!.strikes.find((candidate) => Math.abs(candidate.strike - strike) < EPSILON);
    const callSpread = spreadPct(row?.call?.bid, row?.call?.ask);
    const putSpread = spreadPct(row?.put?.bid, row?.put?.ask);
    const callOi = row?.call?.oi ?? 0;
    const putOi = row?.put?.oi ?? 0;
    maxOi = Math.max(maxOi, callOi, putOi);
    const markers: ('ATM' | 'CE_ENTRY' | 'PE_ENTRY' | 'OPEN')[] = [];
    if (Math.abs(strike - atm) < EPSILON) {
      markers.push('ATM');
    }
    if (Math.abs(strike - bullishEntryStrike) < EPSILON) {
      markers.push('CE_ENTRY');
    }
    if (Math.abs(strike - bearishEntryStrike) < EPSILON) {
      markers.push('PE_ENTRY');
    }
    if (input.openPosition !== undefined && Math.abs(strike - input.openPosition.strike) < EPSILON) {
      markers.push('OPEN');
    }
    return {
      strike,
      markers,
      call: {
        bid: row?.call?.bid,
        ask: row?.call?.ask,
        spreadPct: callSpread,
        openInterest: row?.call?.oi,
        passesGate: legPasses(callSpread, row?.call?.oi, input.maxSpreadPct, input.minOpenInterest),
      },
      put: {
        bid: row?.put?.bid,
        ask: row?.put?.ask,
        spreadPct: putSpread,
        openInterest: row?.put?.oi,
        passesGate: legPasses(putSpread, row?.put?.oi, input.maxSpreadPct, input.minOpenInterest),
      },
    };
  });

  return {
    ...base,
    expiry: input.chain.expiry,
    atmStrike: atm,
    bullishEntryStrike,
    bearishEntryStrike,
    status: 'ready',
    rows,
    maxOpenInterest: maxOi,
  };
}
