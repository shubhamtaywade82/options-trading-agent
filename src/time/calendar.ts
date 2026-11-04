/** Whole calendar days from `fromKey` to `toKey` (both `YYYY-MM-DD`). Negative when `toKey` is earlier. */
export function dayDifference(fromKey: string, toKey: string): number {
  const from = Date.parse(`${fromKey}T00:00:00Z`);
  const to = Date.parse(`${toKey}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new Error(`invalid date key pair: ${fromKey}, ${toKey}`);
  }
  return Math.round((to - from) / 86_400_000);
}

/** Weekday (0 = Sunday) of each index's weekly expiry, as verified on Dhan rolling data in docs/TIME_MACHINE.md. */
const WEEKLY_EXPIRY_WEEKDAY: Readonly<Record<string, number>> = { NIFTY: 2, SENSEX: 4 };

function weekdayOf(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

/**
 * The weekly expiry a session trades against, from its calendar date alone (OTA-203, revised for look-ahead).
 * It is the next expiry weekday on or after the date, so a Monday trades against that week's Tuesday. Nothing here depends
 * on which other sessions exist, so the answer is the same whenever it is asked, and no later data can change it.
 *
 * Known limit: an exchange holiday on the expiry weekday moves the real expiry to the session before it. That shift is not
 * modelled, because the exchange holiday calendar is not in the repository. Sessions in such a week are classed by the
 * nominal date, so the session before the holiday is NEAR when it was in fact the expiry day.
 */
export function nominalWeeklyExpiry(underlying: string, dateKey: string): string | undefined {
  const expiryWeekday = WEEKLY_EXPIRY_WEEKDAY[underlying];
  if (expiryWeekday === undefined) {
    return undefined;
  }
  const daysAhead = (expiryWeekday - weekdayOf(dateKey) + 7) % 7;
  return daysAhead === 0 ? dateKey : shiftDays(dateKey, daysAhead);
}

function shiftDays(dateKey: string, days: number): string {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
