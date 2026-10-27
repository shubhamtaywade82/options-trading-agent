import type { Logger } from './logger.js';

/** Journal events an operator must hear about without watching the cockpit. */
export const ALERT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'daily_loss_breach',
  'book_kill_switch',
  'halted',
  'entry_rejected',
  'exit_rejected',
  'late_entry_fill',
  'audit_gap',
]);

const ALERT_TIMEOUT_MS = 5_000;

type PostText = (url: string, body: string) => Promise<{ ok: boolean; status: number }>;

const postText: PostText = (url, body) =>
  fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(ALERT_TIMEOUT_MS) });

/** One line a phone notification can show: event type, then the payload's scalar fields. */
export function alertText(type: string, payload: Readonly<Record<string, unknown>>): string {
  const fields = Object.entries(payload)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => `${key}=${String(value)}`);
  return [type, ...fields].join(' ');
}

/**
 * Returns an event listener that POSTs alert-worthy events as plain text (the format ntfy.sh accepts).
 * Delivery is best effort: a failure is logged and never reaches the trading path.
 */
export function createAlertSink(url: string, logger: Logger, post: PostText = postText): (type: string, payload: Readonly<Record<string, unknown>>) => void {
  return (type, payload) => {
    if (!ALERT_EVENT_TYPES.has(type)) {
      return;
    }
    post(url, alertText(type, payload))
      .then((response) => {
        if (!response.ok) {
          logger.warn('alert delivery refused', { type, status: response.status });
        }
      })
      .catch((error: unknown) => logger.warn('alert delivery failed', { type, error: error instanceof Error ? error.message : String(error) }));
  };
}
