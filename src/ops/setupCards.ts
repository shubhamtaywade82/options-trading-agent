import { formatPrice } from '../binance/symbolRules.js';
import { escapeHtml } from './telegram.js';
import type { SetupMap, SetupScenario } from '../decision/SetupEngine.js';
import { formatDuration, formatMinutes } from '../decision/SetupTiming.js';

const MAX_CARD_CHARS = 3_500;

const clean = (value: string): string =>
  escapeHtml(value.replace(/\s+/g, ' ').trim());

const MARK: Readonly<Record<string, string>> = { PASS: '✓', WEAK: '~', FAIL: '✗' };
const signed = (value: number | null, digits = 2, suffix = ''): string =>
  value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}${suffix}`;

function qualityLines(setup: SetupScenario): string[] {
  const q = setup.quality;
  if (!q) return [];
  const checks = Object.entries(q.checks).map(([name, result]) => `${name} ${MARK[result]}`).join(' · ');
  const reasons = q.reasons.length > 0 ? ` · ${q.reasons.join(', ')}` : '';
  const lines = [`🧪 <b>Gate:</b> ${q.verdict}${reasons} · <b>Cost-adj RR:</b> ${Number.isFinite(q.effectiveRr) ? q.effectiveRr.toFixed(2) : 'n/a'}`, `☑️ ${checks}`];
  if (setup.locationAtEntry) lines.push(`📍 <b>Location @ entry:</b> ${setup.locationAtEntry.location} ${setup.locationAtEntry.pct.toFixed(0)}%`);
  const e = setup.evidence;
  if (e) {
    lines.push(`🔬 <b>Sweep:</b> level ${e.sweepLevel} · extreme ${e.sweepExtreme} · reclaim close ${e.reclaimClose} · depth ${e.depthAtr.toFixed(2)} ATR · displacement ${e.displacementAtr.toFixed(2)} ATR${e.structureShift ? ` (${e.structureShift})` : ''} · vol z ${signed(e.volumeZLatest, 1)} (latest bar)`);
  }
  return lines;
}

const percent = (value: number): string => `${value.toFixed(0)}%`;



const statusLabel = (scenario: SetupScenario): string => {
  if (scenario.state === 'TRIGGERED') return '🟢 TRIGGERED';
  if (scenario.state === 'ARMED') return '🟠 ARMED';
  return '🟡 FORMING';
};

const setupLabel = (kind: SetupScenario['kind']): string => {
  if (kind === 'LIQUIDITY_SWEEP') return 'LIQUIDITY SWEEP';
  if (kind === 'PULLBACK_RETEST') return 'PULLBACK / RETEST';
  return 'BREAKOUT / RETEST';
};

/** Pinned expiry counts down from the originating event; the model window is only the fallback. */
const expiryText = (setup: SetupScenario, asOf: number): string => {
  if (!setup.lifecycle) return formatMinutes(setup.expectedMove.thesisExpiryMinutes);
  const left = Math.max(0, Math.round((setup.lifecycle.expiresAt - asOf) / 60_000));
  return `${new Date(setup.lifecycle.expiresAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' })} IST (${formatMinutes(left)} left)`;
};

function scenarioLines(symbol: string, setup: SetupScenario, asOf: number): string[] {
  const entry = setup.entryLow === setup.entryHigh
    ? formatPrice(symbol, setup.entryLow)
    : `${formatPrice(symbol, setup.entryLow)}–${formatPrice(symbol, setup.entryHigh)}`;
  const target2 = setup.target2 !== undefined ? ` · <b>TP2:</b> ${formatPrice(symbol, setup.target2)}` : '';
  return [
    `<b>${statusLabel(setup)} · ${setup.direction} · ${setupLabel(setup.kind)}</b>`,
    `🎯 <b>Entry:</b> ${entry} │ 🛑 <b>SL:</b> ${formatPrice(symbol, setup.stopLoss)}`,
    `✅ <b>TP1:</b> ${formatPrice(symbol, setup.target1)}${target2} │ ⚖️ <b>RR:</b> ${setup.rewardRisk.toFixed(2)} (${setup.expectedMove.distanceAtr.toFixed(2)} ATR)`,
    `⚡ <b>Trigger:</b> ${clean(setup.trigger)}`,
    `⛔ <b>Invalidation:</b> ${clean(setup.invalidation)}`,
    `🧠 <b>Flow hypothesis:</b> ${clean(setup.flowHypothesis)}`,
    `⏱️ <b>Move window (model):</b> ${formatDuration(setup.expectedMove)} · <b>Thesis expiry:</b> ${expiryText(setup, asOf)}`,
    ...qualityLines(setup),
    ...(setup.lifecycle ? [`🔖 <b>Setup:</b> ${clean(setup.lifecycle.setupId)} v${setup.lifecycle.version} · <b>Entry:</b> ${setup.lifecycle.entryState.replace(/_/g, ' ')}${setup.state === 'TRIGGERED' ? ' · trigger confirmed, not an order' : ''}`] : []),
  ];
}

function finish(lines: string[]): string {
  const joined = lines.join('\n');
  if (joined.length <= MAX_CARD_CHARS) return joined;
  const kept: string[] = [];
  let used = 2;
  for (const line of lines) {
    if (used + line.length + 1 > MAX_CARD_CHARS) break;
    kept.push(line);
    used += line.length + 1;
  }
  return `${kept.join('\n')}\n…`;
}

/** Human-readable Telegram setup map; it describes trade hypotheses and timing, not guaranteed institutional intent. */
export function setupMapCard(map: SetupMap): string {
  const location = `${map.location} ${percent(map.positionPct)}`;
  const breakText = map.lastBreak
    ? `${map.lastBreak.type} ${map.lastBreak.direction} @ ${formatPrice(map.symbol, map.lastBreak.level)}`
    : 'none';
  const liquidity = `↑ ${map.nearestUpperLiquidity !== null ? formatPrice(map.symbol, map.nearestUpperLiquidity) : '—'} · ↓ ${map.nearestLowerLiquidity !== null ? formatPrice(map.symbol, map.nearestLowerLiquidity) : '—'}`;
  const crowd = map.crowding ?? 'BALANCED/UNKNOWN';
  const oi = map.openInterestExpansion === null ? '—' : map.openInterestExpansion ? 'EXPANDING' : 'NOT EXPANDING';
  const taker = map.takerAggressionRatio === null ? '—' : map.takerAggressionRatio.toFixed(2);
  const context = map.noTradeReasons.length > 0 ? [`⚠️ <b>Context:</b> ${map.noTradeReasons.map(clean).join(' · ')}`] : [];

  const lines = [
    `<b>[ SETUP ]</b> ${clean(map.symbol)}`,
    `<b>📊 DERIVATIVES FLOW CONTEXT</b> · ${map.state}`,
    `💵 <b>Price:</b> ${formatPrice(map.symbol, map.mark)} · <b>Bias:</b> ${map.bias} · <b>Regime:</b> ${clean(map.regime)}`,
    `📐 <b>Structure:</b> HTF ${map.htfTrend} · LTF ${map.ltfTrend} · <b>Last break:</b> ${clean(breakText)}`,
    `📍 <b>Location now:</b> ${location} · <b>Vol:</b> ${map.volatility}`,
    `💧 <b>Liquidity:</b> ${liquidity}`,
    ...(map.flow && map.flow.quadrant !== 'UNKNOWN' ? [`🌊 <b>Flow Δ${Math.round(map.flow.windowMs / 60_000)}m:</b> ${map.flow.quadrant.replace(/_/g, ' ')} · OI ${signed(map.flow.oiDeltaPct, 2, '%')} · price ${signed(map.flow.priceDeltaPct, 2, '%')} · taker z ${signed(map.flow.takerZ, 1)}`] : []),
    ...(map.thesisTransition ? [`🔁 <b>Thesis:</b> ${map.thesisTransition.from} superseded by ${map.thesisTransition.to} (${map.thesisTransition.reason.replace(/_/g, ' ').toLowerCase()})`] : []),
    `👥 <b>Crowding:</b> ${clean(crowd)} · <b>OI:</b> ${oi} · <b>Taker:</b> ${taker}`,
    '',
    ...map.scenarios.flatMap((scenario, index) => [
      `<b>SETUP ${index + 1}</b>`,
      ...scenarioLines(map.symbol, { ...scenario }, map.generatedAt),
      '',
    ]),
    ...context,
    `🕒 <b>Time:</b> ${new Date(map.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} IST`,
  ];

  return finish(lines);
}
