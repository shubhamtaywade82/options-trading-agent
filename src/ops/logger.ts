import { formatMinuteOfDay, istParts } from '../time/ist.js';

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(message: string, data?: Readonly<Record<string, unknown>>): void;
  warn(message: string, data?: Readonly<Record<string, unknown>>): void;
  error(message: string, data?: Readonly<Record<string, unknown>>): void;
}

/** Console logger with IST timestamps, so terminal output lines up with NSE session times. */
export function createConsoleLogger(sink: (line: string) => void = console.log, now: () => number = Date.now): Logger {
  const write = (level: LogLevel, message: string, data?: Readonly<Record<string, unknown>>): void => {
    const parts = istParts(now());
    const stamp = `${parts.date} ${formatMinuteOfDay(parts.minuteOfDay)} IST`;
    const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`;
    sink(`${stamp} ${level.toUpperCase().padEnd(5)} ${message}${suffix}`);
  };
  return {
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
  };
}
