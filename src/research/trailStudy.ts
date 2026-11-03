import type { Candle, OptionSegment } from '../domain/types.js';
import { OPEN_TRAIL, onBarClosed, onTouch, type TrailPosition, type TrailSpec, type TrailState } from '../exits/trail.js';
import { bracketLevels, calculateTrailingStop, roundDownToTick, roundTripChargesInr } from '../options/pricing.js';
import { marketStructure, structureTurnedAgainst } from '../strategy/marketContext.js';
import { istParts } from '../time/ist.js';
import { legBars, type ResearchDataset, type ResearchSession } from './dataset.js';
import type { CostModel, ReplayConfig, ReplayExitReason, ReplayTrade } from './replay.js';

/**
 * Fixed-entry study (docs/TRAILING_STOPS.md §5.2). Entries come from one baseline replay and are frozen; each exit
 * policy is then replayed over the same entry, so a difference between policies is an exit effect only.
 * The bar rules are `replaySession.step`'s, and a test holds the baseline policy to the replay's own exits.
 */

export type ExitPolicy = { readonly kind: 'NONE' } | { readonly kind: 'B1' } | { readonly kind: 'TRAIL'; readonly spec: TrailSpec };

export interface StudyOptions {
  /** KEEP: the bracket target stays, as live. NONE: no target; only the trail and the forced exits close. */
  readonly target: 'KEEP' | 'NONE';
  readonly structureExit: boolean;
}

/** A frozen entry: the baseline trade plus the bars it needs. */
export interface StudyEntry {
  readonly trade: ReplayTrade;
  readonly session: ResearchSession;
  /** Spot bars before the session, as the replay's warmup. */
  readonly warmup: readonly Candle[];
  readonly optionSegment: OptionSegment;
  readonly underlying: string;
}

export type StudyExitReason = ReplayExitReason | 'TRAILING_STOP';

export interface StudyTrade {
  readonly date: string;
  readonly entryTime: number;
  readonly exitTime: number;
  readonly exitPrice: number;
  readonly exitReason: StudyExitReason;
  readonly netPnlInr: number;
  readonly riskInr: number;
  readonly r: number;
  /** Best executable exit inside the shared window, in rupees, never below zero (§5.1). Same for every policy. */
  readonly opportunityInr: number;
  readonly trailFallback: string | undefined;
}

/** Spot bars the trail sees. ATR(14) and SuperTrend(10) have converged long before this; it bounds the work. */
const TRAIL_SPOT_BARS = 300;

interface Open {
  stop: number;
  highWaterMark: number;
  lastMark: number;
  trail: TrailState;
  flagged: StudyExitReason | undefined;
  /** The flagged exit came from a touch on the underlying: it fills like a stop, not at the bid. */
  flaggedIsStop: boolean;
}

function pricing(entry: StudyEntry, costs: CostModel) {
  const tick = entry.session.tickSize;
  return {
    bid: (price: number): number => Math.max(tick, roundDownToTick(price * (1 - costs.halfSpreadPct / 100), tick)),
    stopFill: (price: number): number => Math.max(tick, roundDownToTick(price * (1 - (costs.halfSpreadPct + costs.stopSlippagePct) / 100), tick)),
  };
}

function trailPosition(entry: StudyEntry, config: ReplayConfig, costs: CostModel): TrailPosition {
  const { trade } = entry;
  const charges = roundTripChargesInr({ quantity: trade.quantity, buyPrice: trade.entryPrice, sellPrice: trade.entryPrice, exchangeSegment: entry.optionSegment });
  return {
    entryPrice: trade.entryPrice,
    initialStop: trade.initialStopPrice,
    side: trade.optionType === 'CE' ? 1 : -1,
    entryTime: trade.entryTime,
    barMs: config.barMinutes * 60_000,
    halfSpreadPct: costs.halfSpreadPct,
    chargesPerUnit: charges / trade.quantity,
  };
}

/** The shared window: from entry until the first forced exit common to every policy (EOD flatten, time stop). */
export function opportunityInr(entry: StudyEntry, config: ReplayConfig, costs: CostModel): number {
  const { trade } = entry;
  const { bid } = pricing(entry, costs);
  let best = trade.entryPrice;
  for (const bar of legBars(entry.session, trade.optionType, trade.strike) ?? []) {
    const inWindow =
      bar.time >= trade.entryTime &&
      istParts(bar.time).minuteOfDay < config.exits.flattenByMinute &&
      bar.time - trade.entryTime < config.exits.maxHoldMinutes * 60_000;
    best = inWindow ? Math.max(best, bid(bar.high)) : best;
  }
  return Number(((best - trade.entryPrice) * trade.quantity).toFixed(2));
}

/** Replays one frozen entry under one exit policy. */
export function exitPath(entry: StudyEntry, policy: ExitPolicy, options: StudyOptions, config: ReplayConfig, costs: CostModel): StudyTrade {
  const { trade, session } = entry;
  const { bid, stopFill } = pricing(entry, costs);
  const premiumAll = legBars(session, trade.optionType, trade.strike) ?? [];
  const premiumByTime = new Map(premiumAll.map((bar) => [bar.time, bar]));
  const position = trailPosition(entry, config, costs);
  const target = options.target === 'KEEP' ? trade.targetPrice : Infinity;
  const jump = policy.kind === 'B1' ? bracketJump(trade, config, session.tickSize) : undefined;
  const history: Candle[] = [...entry.warmup];
  const open: Open = { stop: trade.initialStopPrice, highWaterMark: trade.entryPrice, lastMark: trade.entryPrice, trail: OPEN_TRAIL, flagged: undefined, flaggedIsStop: false };
  const finish = (exitTime: number, exitPrice: number, exitReason: StudyExitReason): StudyTrade =>
    studyTrade(entry, config, costs, exitTime, exitPrice, exitReason, open.trail.fallback);
  const stopReason = (): StudyExitReason => (open.stop > trade.initialStopPrice && policy.kind === 'TRAIL' ? 'TRAILING_STOP' : 'STOP_LOSS');

  for (const spotBar of session.spot) {
    const time = spotBar.time;
    if (time < trade.entryTime) {
      history.push(spotBar);
      continue;
    }
    const bar = premiumByTime.get(time);
    if (bar === undefined) {
      return finish(time, bid(open.lastMark), 'DATA_GAP');
    }
    const entryBar = time === trade.entryTime;
    if (!entryBar) {
      if (bar.open <= open.stop) {
        return finish(time, stopFill(bar.open), stopReason());
      }
      if (bid(bar.open) >= target) {
        return finish(time, target, 'TARGET');
      }
      const minute = istParts(time).minuteOfDay;
      const forced: StudyExitReason | undefined =
        open.flagged ??
        (minute >= config.exits.flattenByMinute ? 'EOD_FLATTEN' : time - trade.entryTime >= config.exits.maxHoldMinutes * 60_000 ? 'TIME_STOP' : undefined);
      if (forced !== undefined) {
        return finish(time, open.flaggedIsStop ? stopFill(bar.open) : bid(bar.open), forced);
      }
    }
    if (bar.low <= open.stop) {
      return finish(time, stopFill(open.stop), stopReason());
    }
    if (bid(bar.high) >= target) {
      return finish(time, target, 'TARGET');
    }
    open.lastMark = bar.close;
    history.push(spotBar);
    advance(open, policy, jump, { trade, position, history, premiumAll, time, spotBar, tick: session.tickSize, breakevenAtRr: config.exits.breakevenAtRr });
    if (open.flagged === undefined && options.structureExit) {
      const held = trade.optionType === 'CE' ? 'BULLISH' : 'BEARISH';
      open.flagged = structureTurnedAgainst(marketStructure(history), held) ? 'STRUCTURE_BREAK' : undefined;
    }
  }
  const last = session.spot.at(-1);
  return finish(last === undefined ? trade.entryTime : last.time + config.barMinutes * 60_000, bid(open.lastMark), 'EOD_FLATTEN');
}

interface AdvanceInput {
  readonly trade: ReplayTrade;
  readonly position: TrailPosition;
  readonly history: readonly Candle[];
  readonly premiumAll: readonly Candle[];
  readonly time: number;
  readonly spotBar: Candle;
  readonly tick: number;
  readonly breakevenAtRr: number;
}

/** Moves the stop after a bar closes. Takes effect from the next bar, never inside the bar that set it. */
function advance(open: Open, policy: ExitPolicy, jump: number | undefined, input: AdvanceInput): void {
  if (policy.kind === 'B1' && jump !== undefined && jump > 0) {
    const bar = input.premiumAll.find((candle) => candle.time === input.time);
    open.highWaterMark = Math.max(open.highWaterMark, bar?.high ?? open.highWaterMark);
    open.stop = calculateTrailingStop({
      entryPrice: input.trade.entryPrice,
      initialStopPrice: input.trade.initialStopPrice,
      currentStopPrice: open.stop,
      highWaterMark: open.highWaterMark,
      trailingJump: jump,
      breakevenAtRr: input.breakevenAtRr,
      tickSize: input.tick,
    });
    return;
  }
  if (policy.kind !== 'TRAIL') {
    return;
  }
  const side = input.position.side;
  // The underlying touch is checked against the level set before this bar, so the bar cannot move its own stop.
  open.trail = onTouch(open.trail, 'UNDERLYING', side === 1 ? input.spotBar.low : input.spotBar.high, side);
  if (open.trail.phase !== 'TRIGGERED') {
    const premium = input.premiumAll.filter((candle) => candle.time <= input.time);
    open.trail = onBarClosed(policy.spec, input.position, open.trail, { spot: input.history.slice(-TRAIL_SPOT_BARS), premium });
  }
  const intent = open.trail.intent;
  if (intent !== undefined) {
    open.flagged = 'TRAILING_STOP';
    // Every trail exit is a market SELL into an adverse move, so it pays stop slippage like the stop leg does.
    // Filling a close-confirmed exit at the plain bid would hand those methods a cost edge over B1's stops.
    open.flaggedIsStop = true;
    return;
  }
  const premiumLevel = open.trail.levels.PREMIUM;
  open.stop = premiumLevel === undefined ? open.stop : Math.max(open.stop, roundDownToTick(premiumLevel, input.tick));
}

function bracketJump(trade: ReplayTrade, config: ReplayConfig, tick: number): number | undefined {
  return bracketLevels({
    entryReference: trade.entryLimit,
    stopLossPct: config.exits.stopLossPct,
    targetRr: config.exits.targetRr,
    tickSize: tick,
    trailingJumpPct: config.exits.trailingJumpPct,
  })?.trailingJump;
}

function studyTrade(
  entry: StudyEntry,
  config: ReplayConfig,
  costs: CostModel,
  exitTime: number,
  exitPrice: number,
  exitReason: StudyExitReason,
  trailFallback: string | undefined,
): StudyTrade {
  const { trade } = entry;
  const gross = Number(((exitPrice - trade.entryPrice) * trade.quantity).toFixed(2));
  const charges = roundTripChargesInr({ quantity: trade.quantity, buyPrice: trade.entryPrice, sellPrice: exitPrice, exchangeSegment: entry.optionSegment });
  const netPnlInr = Number((gross - charges).toFixed(2));
  return {
    date: trade.date,
    entryTime: trade.entryTime,
    exitTime,
    exitPrice,
    exitReason,
    netPnlInr,
    riskInr: trade.riskInr,
    r: Number((netPnlInr / trade.riskInr).toFixed(4)),
    opportunityInr: opportunityInr(entry, config, costs),
    trailFallback,
  };
}

/** Freezes the baseline replay's priced trades as study entries, each with the bars its exit path needs. */
export function freezeEntries(dataset: ResearchDataset, baseline: readonly ReplayTrade[], warmupSessions: number): StudyEntry[] {
  const indexByDate = new Map(dataset.sessions.map((session, index) => [session.date, index]));
  return baseline
    .filter((trade) => trade.exitReason !== 'DATA_GAP')
    .map((trade) => {
      const index = indexByDate.get(trade.date);
      const session = index === undefined ? undefined : dataset.sessions[index];
      if (index === undefined || session === undefined) {
        throw new Error(`trade on ${trade.date} has no session in the dataset`);
      }
      const warmup = dataset.sessions.slice(Math.max(0, index - warmupSessions), index).flatMap((day) => day.spot);
      return { trade, session, warmup, optionSegment: dataset.optionSegment, underlying: dataset.underlying };
    });
}
