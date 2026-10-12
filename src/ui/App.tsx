import { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { Runtime } from '../runtime/createRuntime.js';
import { operatorInterrupt } from '../runtime/operatorInterrupt.js';
import { COCKPIT_MIN_COLS, COCKPIT_MIN_ROWS, renderOptionsCockpit, resizeNotice } from './cockpit.js';

/** Destructive or outward actions need a second press within this window. */
export const CONFIRM_WINDOW_MS = 5000;
const DEFAULT_COLS = 160;
const DEFAULT_ROWS = 50;

type Action = 'close' | 'block' | 'stop';
interface Pending {
  readonly action: Action;
  readonly symbol: string | undefined;
  readonly expiresAt: number;
}

/**
 * True when `pending` is the same action on the same target and its window is still open at `now`.
 * Callers pass the press time, because a render can be up to a timer tick old.
 */
export function isConfirmation(pending: Pending | undefined, action: Action, symbol: string | undefined, now: number): boolean {
  return pending !== undefined && pending.expiresAt > now && pending.action === action && pending.symbol === symbol;
}

function confirmPrompt(pending: Pending): string {
  switch (pending.action) {
    case 'close':
      return `press c again within 5s to close the ${pending.symbol ?? ''} position through the normal exit path`;
    case 'block':
      return 'press k again within 5s to toggle the entry block';
    case 'stop':
      return 'press s again within 5s to stop: open positions are flattened first';
  }
}

/**
 * Operator cockpit. It shows the state the orchestrator reports and offers three actions. Each
 * action needs a second press, so one stray key cannot trade. Ctrl+C is a graceful stop, not an
 * unmount, because `c` is also the close key.
 */
export default function App({ runtime }: { runtime: Runtime }) {
  const { orchestrator, records } = runtime;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ cols: stdout.columns || DEFAULT_COLS, rows: stdout.rows || DEFAULT_ROWS });
  const [, setRefresh] = useState(0);
  const [selected, setSelected] = useState(0);
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns || DEFAULT_COLS, rows: stdout.rows || DEFAULT_ROWS });
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  useEffect(() => {
    // A failed start is recorded in the snapshot (phase FAILED) and the log; the screen stays up.
    // Redraw when the start settles so the phase shows at once rather than on the next timer tick.
    orchestrator
      .start()
      .catch(() => undefined)
      .finally(() => setRefresh((n) => n + 1));
  }, [orchestrator]);

  useEffect(() => orchestrator.onViewUpdate(() => setRefresh((n) => n + 1)), [orchestrator]);

  // Age text and the header clock still advance when the feed is quiet (no ticks).
  useEffect(() => {
    const timer = setInterval(() => setRefresh((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const snapshot = orchestrator.snapshot(Date.now());
  const count = snapshot.underlyings.length;
  const index = Math.max(0, Math.min(selected, count - 1));
  const selectedSymbol = snapshot.underlyings[index]?.symbol;

  useEffect(() => {
    orchestrator.setCockpitFocus(selectedSymbol);
  }, [orchestrator, selectedSymbol]);
  const armed = pending !== undefined && pending.expiresAt > Date.now() ? pending : undefined;

  const stopAndExit = async (): Promise<void> => {
    setNotice('stopping: flattening open positions before exit');
    await orchestrator.stop('graceful');
    exit();
  };

  const quitImmediately = async (): Promise<void> => {
    setNotice('quitting immediately…');
    await orchestrator.stop('immediate');
    exit();
  };

  const execute = (action: Action, symbol: string | undefined): void => {
    if (action === 'close' && symbol !== undefined) {
      setNotice(orchestrator.requestManualExit(symbol));
    } else if (action === 'block') {
      setNotice(orchestrator.toggleEntryBlock());
    } else if (action === 'stop') {
      void stopAndExit();
    }
  };

  const request = (action: Action, symbol: string | undefined): void => {
    const now = Date.now();
    if (isConfirmation(pending, action, symbol, now)) {
      setPending(undefined);
      execute(action, symbol);
      return;
    }
    const next: Pending = { action, symbol, expiresAt: now + CONFIRM_WINDOW_MS };
    setPending(next);
    setNotice(confirmPrompt(next));
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (operatorInterrupt() === 'armed') {
        setNotice('Ctrl+C again within 2s to quit immediately (paper: lease released)');
        return;
      }
      void quitImmediately();
      return;
    }
    if (key.upArrow) {
      setSelected(Math.max(0, index - 1));
      return;
    }
    if (key.downArrow) {
      setSelected(Math.min(Math.max(0, count - 1), index + 1));
      return;
    }
    if (key.leftArrow) {
      if (!orchestrator.nudgeCockpitChainScroll(-1)) {
        setNotice('chain window at lowest strikes');
      }
      return;
    }
    if (key.rightArrow) {
      if (!orchestrator.nudgeCockpitChainScroll(1)) {
        setNotice('chain window at highest strikes');
      }
      return;
    }
    if (input === 'p') {
      setNotice(orchestrator.cyclePosture());
      return;
    }
    if (input === '1') {
      setNotice(orchestrator.toggleStrategy('range'));
      return;
    }
    if (input === '2') {
      setNotice(orchestrator.toggleStrategy('trend'));
      return;
    }
    if (input === 'c') {
      if (selectedSymbol === undefined) {
        setNotice('no underlying selected');
        return;
      }
      request('close', selectedSymbol);
      return;
    }
    if (input === 'k') {
      request('block', undefined);
      return;
    }
    if (input === 's') {
      request('stop', undefined);
      return;
    }
    if (input === '?') {
      setNotice('↑↓ select · ←→ chain · p posture · 1/2 strat · c close · k block · s stop (×2) · Ctrl+C×2 quit');
    }
  });

  if (size.cols < COCKPIT_MIN_COLS || size.rows < COCKPIT_MIN_ROWS) {
    return (
      <Box flexDirection="column">
        {resizeNotice(size.cols, size.rows).map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
    );
  }

  const lines = renderOptionsCockpit(snapshot, {
    width: size.cols,
    // One row short of the terminal: a frame as tall as the screen makes Ink redraw everything
    height: size.rows - 1,
    selected: index,
    notice: armed === undefined ? notice : confirmPrompt(armed),
    logs: records?.newest(200) ?? [],
  });

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}
