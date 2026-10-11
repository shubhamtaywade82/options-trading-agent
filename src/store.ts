import { create } from 'zustand';
import type { AppState, LogEntry } from './types.js';
import { config } from './config.js';

interface Store extends AppState {
  logs: LogEntry[];
  set: (partial: Partial<AppState>) => void;
  pushLog: (entry: LogEntry) => void;
}

export const useStore = create<Store>((set) => ({
  mode: config.mode,
  equity: 0,
  initialEquity: 0,
  upnl: 0,
  marginUsed: 0,
  positions: [],
  agents: [],
  logs: [],
  funding: {},
  spotPrices: {},
  strategyMetrics: null,
  totalPnl: 0,
  totalPnlPct: 0,
  successRate: null,
  sharpe: null,
  maxDd: 0,
  var95: null,
  liqEvents: null,
  sessionDecisions: 0,
  sessionExecuted: 0,
  sessionMonitored: 0,
  apiWeight: 0,
  wsStatus: 'down',
  venue: { name: '—', state: 'down' },
  exposurePct: 0,
  minLiqDistancePct: null,
  corrBtcEth: null,
  marketIntel: undefined,
  serverTime: Date.now(),
  set: (partial) => set((state) => {
    let changed = false;
    for (const key of Object.keys(partial) as Array<keyof AppState>) {
      if (state[key] !== partial[key]) {
        changed = true;
        break;
      }
    }
    return changed ? { ...state, ...partial } : state;
  }),
  pushLog: (entry) => set((state) => ({ logs: [entry, ...state.logs].slice(0, 50) })),
}));
