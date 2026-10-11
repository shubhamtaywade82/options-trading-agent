import type { VolatilityRegime } from '../market/types.js';
import type { ExpectedMoveWindow } from './SetupTypes.js';

const TF_MINUTES: Readonly<Record<'15m' | '1h' | '4h', number>> = { '15m': 15, '1h': 60, '4h': 240 };
const VOL_PACE_ATR_PER_BAR: Readonly<Record<VolatilityRegime, number>> = { LOW: 0.35, MEDIUM: 0.55, HIGH: 0.85 };

const roundMinutes = (minutes: number): number => Math.max(5, Math.round(minutes / 5) * 5);

export function expectedMove(
  distance: number,
  atrValue: number,
  timeframe: '15m' | '1h' | '4h',
  volatility: VolatilityRegime,
): ExpectedMoveWindow | null {
  if (!(atrValue > 0) || !(distance > 0)) return null;
  const distanceAtr = distance / atrValue;
  const pace = VOL_PACE_ATR_PER_BAR[volatility];
  const bars = Math.min(24, Math.max(1.5, distanceAtr / pace));
  const tfMinutes = TF_MINUTES[timeframe];
  const minMinutes = roundMinutes(bars * tfMinutes * 0.5);
  const maxMinutes = roundMinutes(bars * tfMinutes * 2);
  return {
    minMinutes,
    maxMinutes: Math.max(maxMinutes, minMinutes),
    thesisExpiryMinutes: Math.max(roundMinutes(maxMinutes * 1.5), tfMinutes * 4),
    distanceAtr,
  };
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return minutes + 'm';
  const hours = minutes / 60;
  if (hours < 24) return (Math.round(hours * 10) / 10) + 'h';
  return (Math.round((hours / 24) * 10) / 10) + 'd';
}

export function formatDuration(window: ExpectedMoveWindow): string {
  return formatMinutes(window.minMinutes) + '–' + formatMinutes(window.maxMinutes);
}
