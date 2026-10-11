export const ALERT_CLASSES = ['SYSTEM', 'MACRO', 'MARKET', 'LEVEL', 'SETUP', 'SIGNAL', 'TRADE', 'RESEARCH'] as const;
export type AlertClass = (typeof ALERT_CLASSES)[number];

export const ALERT_SEVERITIES = ['INFO', 'WATCH', 'IMPORTANT', 'SIGNAL', 'CRITICAL'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = {
  INFO: 0, WATCH: 1, IMPORTANT: 2, SIGNAL: 3, CRITICAL: 4,
};

export interface AlertEvent {
  readonly id: string;
  readonly at: number;
  readonly class: AlertClass;
  readonly severity: AlertSeverity;
  readonly symbol?: string;
  readonly title: string;
  readonly body: string;
  readonly fingerprint: string;
  readonly stateFrom?: string;
  readonly stateTo?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type AlertSuppressReason =
  | 'CLASS' | 'SYMBOL' | 'SEVERITY' | 'LEVEL_APPROACHING' | 'CONFIDENCE' | 'RR' | 'DEDUPE';

export interface AlertDecision {
  readonly action: 'emitted' | 'suppressed';
  readonly reason?: AlertSuppressReason;
  readonly event: AlertEvent;
}

type AlertSpec = Omit<AlertEvent, 'id' | 'at' | 'payload'> & {
  readonly id?: string;
  readonly at?: number;
  readonly payload?: Readonly<Record<string, unknown>>;
};

let alertCounter = 0;

/** Completes a partial alert with an id, a timestamp and an empty payload. */
export const makeAlert = (spec: AlertSpec): AlertEvent => {
  const at = spec.at ?? Date.now();
  return { ...spec, id: spec.id ?? `alert_${at.toString(36)}_${++alertCounter}`, at, payload: spec.payload ?? {} };
};

export interface AlertSubscriptions {
  readonly classes: Readonly<Record<AlertClass, boolean>>;
  readonly symbols: Readonly<Record<string, boolean>>;
  readonly minSeverity: AlertSeverity;
  readonly levelApproaching: boolean;
  readonly liquiditySweeps: boolean;
  readonly setupDeveloping: boolean;
  readonly minimumSignalConfidence: number;
  readonly minimumRr: number;
}

/** Signal gates default to 0 (off): our strategies' R:R is often below crypto-agent's 2.5 prop-firm floor. */
export const defaultSubscriptions = (): AlertSubscriptions => ({
  classes: { SYSTEM: true, MACRO: true, MARKET: true, LEVEL: true, SETUP: true, SIGNAL: true, TRADE: true, RESEARCH: true },
  symbols: {},
  minSeverity: 'WATCH',
  levelApproaching: false,
  liquiditySweeps: true,
  setupDeveloping: true,
  minimumSignalConfidence: 0,
  minimumRr: 0,
});

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const boolOr = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const severityOr = (value: unknown, fallback: AlertSeverity): AlertSeverity =>
  ALERT_SEVERITIES.find((s) => s === value) ?? fallback;

const parseClasses = (raw: Record<string, unknown>, base: AlertSubscriptions['classes']): AlertSubscriptions['classes'] => {
  const next = { ...base };
  for (const cls of ALERT_CLASSES) {
    next[cls] = boolOr(typeof raw[cls] === 'boolean' ? raw[cls] : raw[cls.toLowerCase()], base[cls]);
  }
  return next;
};

const parseSymbols = (raw: unknown): Record<string, boolean> => {
  const symbols: Record<string, boolean> = {};
  for (const [name, value] of Object.entries(asRecord(raw))) {
    const enabled = typeof value === 'boolean' ? value : asRecord(value).enabled;
    if (typeof enabled === 'boolean') symbols[name.toUpperCase()] = enabled;
  }
  return symbols;
};

const parseJsonOrUndefined = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/** Merges operator JSON (object or JSON text, crypto-agent key names) onto defaults; garbage yields defaults. */
export const parseSubscriptions = (raw: unknown): AlertSubscriptions => {
  const defaults = defaultSubscriptions();
  const root = asRecord(parseJsonOrUndefined(raw));
  const notes = asRecord(root.notifications ?? root);
  return {
    classes: parseClasses(notes, defaults.classes),
    symbols: parseSymbols(notes.symbols),
    minSeverity: severityOr(notes.minSeverity, defaults.minSeverity),
    levelApproaching: boolOr(notes.level_approaching, defaults.levelApproaching),
    liquiditySweeps: boolOr(notes.liquidity_sweeps, defaults.liquiditySweeps),
    setupDeveloping: boolOr(notes.setup_developing, defaults.setupDeveloping),
    minimumSignalConfidence: numberOr(notes.minimum_signal_confidence, defaults.minimumSignalConfidence),
    minimumRr: numberOr(notes.minimum_rr, defaults.minimumRr),
  };
};

const SYMBOL_SCOPED: ReadonlySet<AlertClass> = new Set(['MARKET', 'LEVEL', 'SETUP', 'SIGNAL']);

const numericPayload = (event: AlertEvent, key: string): number | undefined => {
  const value = event.payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const symbolDisabled = (event: AlertEvent, subs: AlertSubscriptions): boolean =>
  event.symbol !== undefined && SYMBOL_SCOPED.has(event.class) && subs.symbols[event.symbol.toUpperCase()] === false;

const belowSeverityFloor = (event: AlertEvent, subs: AlertSubscriptions): boolean => {
  if (event.class === 'SYSTEM' && event.severity === 'CRITICAL') return false;
  return SEVERITY_RANK[event.severity] < SEVERITY_RANK[subs.minSeverity];
};

const signalGate = (event: AlertEvent, subs: AlertSubscriptions): AlertSuppressReason | undefined => {
  if (event.class !== 'SIGNAL' || event.stateTo !== 'CONFIRMED') return undefined;
  const confidence = numericPayload(event, 'confidence');
  const rr = numericPayload(event, 'rr');
  if (confidence !== undefined && confidence < subs.minimumSignalConfidence) return 'CONFIDENCE';
  if (rr !== undefined && rr < subs.minimumRr) return 'RR';
  return undefined;
};

const subscriptionReject = (event: AlertEvent, subs: AlertSubscriptions): AlertSuppressReason | undefined => {
  if (subs.classes[event.class] === false) return 'CLASS';
  if (symbolDisabled(event, subs)) return 'SYMBOL';
  if (belowSeverityFloor(event, subs)) return 'SEVERITY';
  if (event.class === 'LEVEL' && event.stateTo === 'APPROACHING' && !subs.levelApproaching) return 'LEVEL_APPROACHING';
  if (event.class === 'SETUP' && (event.stateTo === 'FORMING' || event.stateTo === 'ARMED') && !subs.setupDeveloping) return 'CLASS';
  if (event.stateTo === 'REACTION' && !subs.liquiditySweeps) return 'CLASS';
  return signalGate(event, subs);
};

const RESEARCH_COOLDOWN_MS = 20 * 60 * 60 * 1000;

const DEFAULT_COOLDOWN_MS: Readonly<Record<AlertClass, number>> = {
  SYSTEM: 15_000, MACRO: 60_000, MARKET: 300_000, LEVEL: 600_000, SETUP: 300_000,
  SIGNAL: 0, TRADE: 0, RESEARCH: RESEARCH_COOLDOWN_MS,
};

const MEMORY_CAP = 2000;
const MEMORY_EVICT_COUNT = 1000;

interface EngineOptions {
  readonly cooldownMs?: Partial<Record<AlertClass, number>>;
  readonly now?: () => number;
}

interface EmissionMemory {
  readonly stateTo?: string;
  readonly at: number;
}

/** Gates alerts by subscription, then drops repeats of the same fingerprint+state inside the class cooldown. */
export class NotificationEngine {
  private readonly subs: AlertSubscriptions;
  private readonly cooldown: Readonly<Record<AlertClass, number>>;
  private readonly now: () => number;
  private readonly lastEmitted = new Map<string, EmissionMemory>();

  constructor(subs?: AlertSubscriptions, opts: EngineOptions = {}) {
    this.subs = subs ?? defaultSubscriptions();
    this.cooldown = { ...DEFAULT_COOLDOWN_MS, ...opts.cooldownMs };
    this.now = opts.now ?? Date.now;
  }

  submit(event: AlertEvent): AlertDecision {
    const blocked = subscriptionReject(event, this.subs) ?? this.duplicateReject(event);
    if (blocked) return { action: 'suppressed', reason: blocked, event };
    this.remember(event);
    return { action: 'emitted', event };
  }

  private timeOf(event: AlertEvent): number {
    return event.at > 0 ? event.at : this.now();
  }

  private duplicateReject(event: AlertEvent): AlertSuppressReason | undefined {
    const previous = this.lastEmitted.get(event.fingerprint);
    if (!previous) return undefined;
    // Price wicks across trigger thresholds flip states rapidly; demotions are not actionable
    if (event.class === 'SETUP' && previous.stateTo === 'TRIGGERED' && event.stateTo !== 'TRIGGERED') {
      return 'DEDUPE';
    }
    if (previous.stateTo !== event.stateTo) return undefined;
    const cooldown = this.cooldown[event.class];
    return cooldown > 0 && this.timeOf(event) - previous.at < cooldown ? 'DEDUPE' : undefined;
  }

  private remember(event: AlertEvent): void {
    this.lastEmitted.delete(event.fingerprint);
    this.lastEmitted.set(event.fingerprint, { stateTo: event.stateTo, at: this.timeOf(event) });
    if (this.lastEmitted.size <= MEMORY_CAP) return;
    const oldest = [...this.lastEmitted.keys()].slice(0, MEMORY_EVICT_COUNT);
    for (const key of oldest) this.lastEmitted.delete(key);
  }
}
