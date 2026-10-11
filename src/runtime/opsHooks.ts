import { readFileSync } from 'node:fs';
import type { MarketContext } from '../agents/BaseAgent.js';
import { config } from '../config.js';
import { defaultSubscriptions, NotificationEngine, parseSubscriptions } from '../ops/alerts.js';
import { EventStore } from '../ops/eventStore.js';
import { createOps, type OpsHooks } from '../ops/hooks.js';
import type { KillSwitch } from '../ops/killSwitch.js';
import { sendAlert, type TelegramDeps } from '../ops/telegram.js';
import { PerformanceEngine, type PerformanceSnapshot } from '../risk/performanceEngine.js';
import { deriveCircuitState, riskLimitsFromConfig, type CircuitState, type RiskLimits } from '../risk/riskConfig.js';
import type { PeakEquitySource } from '../risk/equityHwm.js';
import type { Mode, Position, TradeRecord } from '../types.js';

// The paper account's starting balance, used until the first account read reports the venue's real one
const DEFAULT_INITIAL_EQUITY = 100_000;

interface AccountReading { equity: number; initialEquity: number }

export interface RiskOpsOptions {
  isEnabled?: boolean;
  limits?: RiskLimits;
  /** While halted the fleet row shows KILL-SWITCH instead of the circuit state. */
  killSwitch?: Pick<KillSwitch, 'isHalted'>;
  /** Called once per circuit change with the numbers that caused it. */
  onCircuit?: (from: CircuitState, to: CircuitState, snapshot: PerformanceSnapshot) => void;
  /** Persistent high-water mark; seeds the engine so drawdown survives restarts. */
  hwm?: PeakEquitySource;
}

/**
 * Owns the performance engine and the circuit state the risk agent reads each loop.
 * Everything here is rebuilt from the closed-trade journal, so a restart lands on the same state.
 */
export class RiskOps {
  private engine = new PerformanceEngine(DEFAULT_INITIAL_EQUITY);
  private initialEquity = DEFAULT_INITIAL_EQUITY;
  private circuit: CircuitState = 'NORMAL';
  private readonly isEnabled: boolean;
  private readonly limits: RiskLimits;

  constructor(private readonly warn: (message: string) => void, private readonly options: RiskOpsOptions = {}) {
    this.isEnabled = options.isEnabled ?? config.riskEngine === 'on';
    this.limits = options.limits ?? riskLimitsFromConfig();
  }

  /** The cockpit's fleet-row suffix: empty while everything is normal or the engine is off. */
  get note(): string | undefined {
    if (this.options.killSwitch?.isHalted()) return 'KILL-SWITCH';
    return this.circuit === 'NORMAL' ? undefined : this.circuit;
  }

  /** The per-loop performance context, or undefined when the engine is off. */
  build(trades: TradeRecord[], account: AccountReading): MarketContext['performance'] {
    if (!this.isEnabled) return undefined;
    this.adoptInitialEquity(account.initialEquity);
    // The persisted peak outlives the journal (which is capped and only realized):
    // seed it first so the drawdown governor starts where the last session ended.
    if (this.options.hwm) this.engine.seedObservedPeak(this.options.hwm.peak());
    // An operator drawdown reset also retires the journal's older realized peaks
    this.engine.setDrawdownEpoch(this.options.hwm?.resetAt?.() ?? 0);
    this.engine.hydrate(trades);
    this.engine.onEquity(account.equity);
    this.options.hwm?.observe(account.equity);
    const snapshot = this.engine.snapshot(account.equity);
    const circuit = deriveCircuitState(snapshot.dailyLossPercent, snapshot.drawdownPercent, snapshot.lossStreak, this.limits);
    this.recordCircuit(circuit, snapshot);
    return { circuit, snapshot };
  }

  // The engine's baseline is fixed at construction, and the daily-loss denominator depends on it, so a venue that reports a different start gets a fresh engine (no peak is lost: this happens on the first read)
  private adoptInitialEquity(initialEquity: number): void {
    if (initialEquity <= 0 || initialEquity === this.initialEquity) return;
    this.initialEquity = initialEquity;
    this.engine = new PerformanceEngine(initialEquity);
  }

  private recordCircuit(circuit: CircuitState, snapshot: PerformanceSnapshot): void {
    if (circuit === this.circuit) return;
    const previous = this.circuit;
    this.circuit = circuit;
    this.warn(`circuit ${previous} -> ${circuit}`);
    this.options.onCircuit?.(previous, circuit, snapshot);
  }
}

/** Flips the operator kill-switch, tells the operator, and hands the new state to the ops hooks. */
export function toggleKillSwitch(killSwitch: KillSwitch, hooks: Pick<OpsHooks, 'onKillSwitch'>, warn: (message: string) => void): void {
  const state = killSwitch.toggle('manual');
  const unsaved = killSwitch.lastError ? ` (not saved, a restart will forget it: ${killSwitch.lastError})` : '';
  warn(`KILL-SWITCH ${state.halted ? 'ON: new entries refused' : 'OFF: entries allowed'}${unsaved}`);
  hooks.onKillSwitch(state);
}

export interface StartupOptions {
  killSwitch: Pick<KillSwitch, 'state'>;
  hooks: Pick<OpsHooks, 'onKillSwitch'>;
  warn: (message: string) => void;
  mode?: Mode;
  isEngineOn?: boolean;
}

/** Says out loud what would otherwise be silent: a halt left by a previous session, and a live circuit breaker that cannot see losses. */
export function announceStartup({ killSwitch, hooks, warn, mode = config.mode, isEngineOn = config.riskEngine === 'on' }: StartupOptions): void {
  const state = killSwitch.state();
  if (state.halted) {
    warn(`KILL-SWITCH ON (persisted): ${state.reason} — press k to resume`);
    hooks.onKillSwitch(state);
  }
  // getTrades() is empty in live mode, which starves the daily-loss and loss-streak governors
  if (mode === 'live' && isEngineOn) warn('RISK_ENGINE: live mode has no trade journal — daily-loss and loss-streak limits are inactive (drawdown still applies)');
}

interface PortfolioSource {
  getPositions(fresh?: boolean): Promise<Position[]>;
  getAccount(): Promise<{ equity: number }>;
}

/** After a fill, later signals of the same cycle must be gated against the positions and equity it left behind; a no-op with the engine off. */
export async function refreshPortfolio(ctx: MarketContext, source: PortfolioSource): Promise<MarketContext> {
  if (!ctx.performance) return ctx;
  // Cached read: the broker refreshes its own cache when an order fills, so no extra venue round trip in remote mode
  const positions = await source.getPositions(false);
  const { equity } = await source.getAccount();
  return { ...ctx, positions, equity };
}

export interface OpsConfig { audit: boolean; alerts: boolean; eventsPath: string; notificationsPath: string; hideNoTradeSetups?: boolean }

const opsConfigFromEnv = (): OpsConfig => ({
  audit: config.audit === 'on', alerts: config.alerts === 'on', eventsPath: config.eventsPath, notificationsPath: config.notificationsPath,
  hideNoTradeSetups: config.setup.alertHideNoTrade,
});

// Refused signals and active setups re-fire each loop while conditions hold; flapping venues re-alert
const ALERT_COOLDOWN_MS = { SYSTEM: 5 * 60_000, SIGNAL: 15 * 60_000, SETUP: 30 * 60_000 };
const DIGEST_DELAY_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

/** The next 00:05 UTC strictly after `now`. */
export function nextDigestAt(now: number): number {
  const today = Math.floor(now / DAY_MS) * DAY_MS + DIGEST_DELAY_MS;
  return today > now ? today : today + DAY_MS;
}

export interface DigestSource {
  getTrades(): TradeRecord[];
  getAccount(): Promise<{ initialEquity: number }>;
}

interface DigestOptions { now?: () => number; log: (line: string) => void }

/** Runs the digest at every 00:05 UTC until the returned function cancels it; the timer never keeps the process alive. */
export function scheduleDailyDigest(hooks: Pick<OpsHooks, 'digest'>, source: DigestSource, options: DigestOptions): () => void {
  const now = options.now ?? Date.now;
  let timer: NodeJS.Timeout;
  const send = async (at: number): Promise<void> => {
    try {
      const { initialEquity } = await source.getAccount();
      hooks.digest({ trades: source.getTrades(), initialEquity, at });
    } catch (err) {
      options.log(`Daily digest skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  let target = nextDigestAt(now());
  const arm = (): void => {
    timer = setTimeout(() => {
      void send(target);
      target = nextDigestAt(target);
      arm();
    }, Math.max(0, target - now()));
    timer.unref();
  };
  arm();
  return () => clearTimeout(timer);
}

export interface Ops extends OpsHooks {
  /** Starts the daily digest timer; does nothing unless alerts are on. */
  start(source: DigestSource): void;
  stop(): void;
}

export interface BuildOpsOptions {
  /** Where dry-run cards and digest failures are written: the cockpit log, never stdout. */
  log: (line: string) => void;
  seedTrades: readonly TradeRecord[];
  config?: OpsConfig;
  telegram?: TelegramDeps;
  now?: () => number;
}

// Tags are dropped and lines joined so the preview reads as one log row instead of overflowing the panel
const oneLine = (card: string): string => card.replace(/<[^>]+>/g, '').replace(/\s*\n\s*/g, ' | ');

function loadSubscriptions(file: string) {
  try {
    return parseSubscriptions(readFileSync(file, 'utf-8'));
  } catch {
    // No preferences file is the normal case: every class is on
    return defaultSubscriptions();
  }
}

/** Wires the audit trail, alert engine and Telegram sender from the flags; with both flags off nothing is created on disk. */
export function buildOps(options: BuildOpsOptions): Ops {
  const cfg = options.config ?? opsConfigFromEnv();
  const now = options.now ?? Date.now;
  const telegram: TelegramDeps = { log: (line) => options.log(oneLine(line)), ...options.telegram };
  const hooks = createOps({
    isAudit: cfg.audit, isAlerts: cfg.alerts, seedTrades: options.seedTrades, now, hideNoTradeSetups: cfg.hideNoTradeSetups ?? false,
    store: new EventStore(cfg.eventsPath),
    engine: new NotificationEngine(cfg.alerts ? loadSubscriptions(cfg.notificationsPath) : undefined, { cooldownMs: ALERT_COOLDOWN_MS, now }),
    send: (event, html) => sendAlert(event, html, telegram),
  });
  let cancelDigest: (() => void) | undefined;
  return {
    ...hooks,
    start: (source) => { if (cfg.alerts) cancelDigest = scheduleDailyDigest(hooks, source, { now, log: options.log }); },
    stop: () => cancelDigest?.(),
  };
}
