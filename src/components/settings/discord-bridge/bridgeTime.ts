type Translate = (key: string, named: Record<string, unknown>, plural: number) => string

/** "12 seconds ago" … "3 days ago" under discordBridge.time; plural forms come from the locale. */
export function formatAgo(t: Translate, iso: string | null | undefined, now: number): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return t('discordBridge.time.secondsAgo', { count: seconds }, seconds)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('discordBridge.time.minutesAgo', { count: minutes }, minutes)
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return t('discordBridge.time.hoursAgo', { count: hours }, hours)
  const days = Math.floor(hours / 24)
  return t('discordBridge.time.daysAgo', { count: days }, days)
}

/** Whole minutes left, rounded up; 0 once expired. */
export function minutesLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60_000))
}
