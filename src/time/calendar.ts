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
 * Which of `sessionDates` are a weekly expiry: the expiry weekday, or the last session before it when that day is
 * missing and a later session in the same week proves it was a holiday. Undefined for an index with no verified rule.
 */
export function weeklyExpiryDates(underlying: string, sessionDates: readonly string[]): Set<string> | undefined {
  const expiryWeekday = WEEKLY_EXPIRY_WEEKDAY[underlying];
  if (expiryWeekday === undefined) {
    return undefined;
  }
  const weeks = new Map<number, string[]>();
  for (const date of sessionDates) {
    const week = Math.floor((Date.parse(`${date}T00:00:00Z`) / 86_400_000 + 3) / 7);
    weeks.set(week, [...(weeks.get(week) ?? []), date]);
  }
  const expiries = new Set<string>();
  for (const dates of weeks.values()) {
    const onDay = dates.find((date) => weekdayOf(date) === expiryWeekday);
    const before = dates.filter((date) => weekdayOf(date) < expiryWeekday).at(-1);
    const holidayProven = dates.some((date) => weekdayOf(date) > expiryWeekday);
    const expiry = onDay ?? (holidayProven ? before : undefined);
    if (expiry !== undefined) {
      expiries.add(expiry);
    }
  }
  return expiries;
}
