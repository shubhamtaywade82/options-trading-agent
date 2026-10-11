import { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { Orchestrator } from '../runtime/Orchestrator.js';
import { useStore } from '../store.js';
import { clampSelection, MIN_COLS, MIN_ROWS, renderCockpit, ResizeWarning } from './panels.js';
import { formatLocalTime } from './format.js';

export default function App() {
  const { stdout } = useStdout();
  const [terminalSize, setTerminalSize] = useState(() => ({
    cols: stdout?.columns ?? process.stdout.columns ?? 128,
    rows: stdout?.rows ?? process.stdout.rows ?? 58,
  }));

  useEffect(() => {
    const handleResize = () => {
      // Clear viewport to prevent ghost borders when narrowing the terminal
      process.stdout.write('\x1b[2J\x1b[H');
      setTerminalSize({
        cols: process.stdout.columns || 128,
        rows: process.stdout.rows || 58,
      });
    };
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, []);

  const [orchestrator] = useState(() => new Orchestrator());
  const [isSyncing, setIsSyncing] = useState(false);
  const [time, setTime] = useState(() => new Date().toISOString().slice(11, 19));
  const [localTime, setLocalTime] = useState(() => formatLocalTime());
  const [selPos, setSelPos] = useState(0);

  const state = useStore();
  const { positions } = state;
  const set = useStore((s) => s.set);
  const pushLog = useStore((s) => s.pushLog);
  // One clamped value drives the key handler, the highlight and the action list, so 'c' always closes the row shown as selected
  const selectedIndex = clampSelection(selPos, positions.length);
  const selectedPosition = positions[selectedIndex];

  useEffect(() => {
    setSelPos((s) => clampSelection(s, positions.length));
  }, [positions.length]);

  useEffect(() => {
    orchestrator.on('state', (state) => set(state));
    orchestrator.on('log', (entry) => pushLog(entry));
    orchestrator.on('sync', (syncing: boolean) => setIsSyncing(syncing));
    orchestrator.start();

    const clockTimer = setInterval(() => {
      const now = new Date();
      setTime(now.toISOString().slice(11, 19));
      setLocalTime(formatLocalTime(now));
    }, 1000);

    // Issue #5: synchronously flush the local PaperEngine's debounced state
    // on SIGINT/SIGTERM before the process exits, so the 250ms debounce
    // timer can't drop the last state.
    const flush = () => orchestrator.flushOnShutdown();
    process.on('SIGINT', flush);
    process.on('SIGTERM', flush);

    return () => {
      orchestrator.stop();
      clearInterval(clockTimer);
      process.off('SIGINT', flush);
      process.off('SIGTERM', flush);
    };
  }, [orchestrator, set, pushLog]);

  useInput((input, key) => {
    if (key.upArrow) setSelPos(clampSelection(selectedIndex - 1, positions.length));
    if (key.downArrow) setSelPos(clampSelection(selectedIndex + 1, positions.length));
    if (input === 'c' && selectedPosition) orchestrator.closePosition(selectedPosition);
    if (input === 'x') orchestrator.cancelAll();
    if (input === 'k') orchestrator.toggleKillSwitch();
    if (input === 'a' || input === 'i') orchestrator.askAdvisor();
    if (input === '?') {
      pushLog({
        ts: Date.now(),
        agent: 'SYSTEM',
        msg: 'COMMANDS: ↑↓ select pos │ c close pos │ x cancel all │ k kill-switch │ a advisor audit │ s stop',
        level: 'info',
      });
    }
    if (input === 's') process.exit(0);
  });

  const { cols, rows } = terminalSize;
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    return <ResizeWarning cols={cols} rows={rows} />;
  }

  const cockpitLines = renderCockpit({ ...state, time, localTime, selPos: selectedIndex, isSyncing, totalWidth: cols, totalHeight: rows });

  return (
    <Box flexDirection="column" width={cols}>
      {cockpitLines.map((line, idx) => (
        <Text key={idx}>{line + '\x1b[K'}</Text>
      ))}
    </Box>
  );
}
