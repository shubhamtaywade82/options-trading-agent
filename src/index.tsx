#!/usr/bin/env node
import { render } from 'ink';
import App from './ui/App.js';

// Use alternate screen buffer in TTY to eliminate terminal scrollback tearing and hide cursor
if (process.stdout.isTTY) {
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[H');
  const rawWrite = process.stdout.write.bind(process.stdout);
  // DEC mode 2026 batches line-erasure and redraw into an atomic GPU frame swap
  process.stdout.write = (chunk: any, encoding?: any, callback?: any) => {
    if (typeof chunk === 'string' && chunk.includes('\x1b[2K')) {
      return rawWrite('\x1b[?2026h' + chunk + '\x1b[?2026l', encoding, callback);
    }
    return rawWrite(chunk, encoding, callback);
  };
}

const instance = render(<App />);

const cleanup = () => {
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  }
};

instance.waitUntilExit().then(cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});
process.on('exit', cleanup);
