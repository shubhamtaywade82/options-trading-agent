import type { SetupMap } from '../decision/SetupEngine.js';
import type { AlertClass, AlertSeverity } from './alerts.js';
import { setupMapCard } from './setupCards.js';

export interface SetupNotice {
  cls: Extract<AlertClass, 'SETUP'>;
  severity: Extract<AlertSeverity, 'WATCH' | 'SIGNAL'>;
  fingerprint: string;
  html: string;
  symbol: string;
  stateTo: string;
  scenarioKey: string;
}

export interface SetupNoticeOptions {
  /** Drop scenarios whose quality verdict is NO_TRADE. They are still recorded in the outcome ledger; they are only not announced. */
  hideNoTrade?: boolean;
}

const STATE_RANK: Record<SetupMap['scenarios'][number]['state'], number> = { TRIGGERED: 2, ARMED: 1, FORMING: 0 };

/** The map as an alert should show it: rejected scenarios removed, and the headline state recomputed from what is left. */
function visibleMap(setup: SetupMap, hideNoTrade: boolean): SetupMap {
  if (!hideNoTrade) return setup;
  const scenarios = setup.scenarios.filter((scenario) => scenario.quality?.verdict !== 'NO_TRADE');
  if (scenarios.length === setup.scenarios.length) return setup;
  if (scenarios.length === 0) return { ...setup, scenarios, state: 'NO_TRADE' };
  const top = scenarios.reduce((best, s) => (STATE_RANK[s.state] > STATE_RANK[best] ? s.state : best), scenarios[0]!.state);
  return { ...setup, scenarios, state: top };
}

export function buildSetupNotice(full: SetupMap, options: SetupNoticeOptions = {}): SetupNotice | null {
  const setup = visibleMap(full, options.hideNoTrade ?? false);
  if (setup.scenarios.length === 0) return null;
  const scenarioKey = setup.scenarios.map((scenario) => scenario.id).sort().join(',');
  // Eligibility and thesis flips are material even when the setup state is unchanged, so they must not dedupe against the earlier notice
  const eligible = setup.scenarios.some((scenario) => scenario.quality?.verdict === 'ENTRY_ELIGIBLE');
  const flip = setup.thesisTransition ? `:flip-${setup.thesisTransition.to}` : '';
  return {
    cls: 'SETUP',
    severity: setup.state === 'TRIGGERED' ? 'SIGNAL' : 'WATCH',
    symbol: setup.symbol,
    stateTo: setup.state,
    scenarioKey,
    fingerprint: `SETUP:${setup.symbol}:${setup.state === 'TRIGGERED' ? 'triggered' : scenarioKey}${eligible ? ':eligible' : ''}${flip}`,
    html: setupMapCard(setup),
  };
}
