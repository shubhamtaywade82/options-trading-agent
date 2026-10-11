/** Whole calendar days from `fromKey` to `toKey` (both `YYYY-MM-DD`). Negative when `toKey` is earlier. */
export function dayDifference(fromKey: string, toKey: string): number {
  const from = Date.parse(`${fromKey}T00:00:00Z`);
  const to = Date.parse(`${toKey}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new Error(`invalid date key pair: ${fromKey}, ${toKey}`);
  }
  return Math.round((to - from) / 86_400_000);
}
