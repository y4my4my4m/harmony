import type { SignupCohort } from '@/services/AdminService'

export type CohortCountKey = Exclude<keyof SignupCohort, 'cohort_start'>

export interface RetentionMetric {
  /** Key under adminRetention.columns and adminRetention.help. */
  key: string
  numerator: CohortCountKey
  denominator: CohortCountKey
}

/** Column order of the cohort table. Each rate is numerator / denominator of one cohort row. */
export const RETENTION_METRICS: readonly RetentionMetric[] = [
  { key: 'joinedServer', numerator: 'joined_server', denominator: 'signups' },
  { key: 'joinedOther', numerator: 'joined_other_server', denominator: 'signups' },
  { key: 'wroteDay1', numerator: 'wrote_day1', denominator: 'day1_eligible' },
  { key: 'activeDays1to7', numerator: 'active_days1_7', denominator: 'days1_7_eligible' },
  { key: 'activeDays8to30', numerator: 'active_days8_30', denominator: 'days8_30_eligible' },
  { key: 'activeDays31to90', numerator: 'active_days31_90', denominator: 'days31_90_eligible' },
  { key: 'answered1h', numerator: 'answered_1h', denominator: 'first_message_eligible' },
  { key: 'answered24h', numerator: 'answered_24h', denominator: 'first_message_eligible' },
  { key: 'push', numerator: 'has_push', denominator: 'signups' },
  { key: 'follows', numerator: 'follows_anyone', denominator: 'signups' },
]

const COUNT_KEYS: readonly CohortCountKey[] = [
  'signups', 'joined_server', 'joined_other_server',
  'day1_eligible', 'wrote_day1', 'days1_7_eligible', 'active_days1_7',
  'days8_30_eligible', 'active_days8_30', 'days31_90_eligible', 'active_days31_90',
  'first_message_eligible', 'answered_1h', 'answered_24h', 'has_push', 'follows_anyone',
]

/** Below this many signups one account moves a rate by more than 10 points. */
export const SMALL_COHORT = 10

export const RANGE_MONTHS = [3, 6, 12, 24] as const

/** Fraction in [0, 1], or null when the denominator is zero. */
export function rate(numerator: number, denominator: number): number | null {
  if (!denominator || denominator <= 0) return null
  return Math.min(1, Math.max(0, numerator / denominator))
}

/** Whole percent; '—' for null; '<1%' for a nonzero rate that rounds to zero. */
export function formatPercent(value: number | null, locale?: string): string {
  if (value === null) return '—'
  const fmt = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 })
  if (value > 0 && value < 0.005) return '<' + fmt.format(0.01)
  return fmt.format(value)
}

/** Shade step 0..5 for a rate; null stays unshaded. 0 only for an exact zero. */
export function heatLevel(value: number | null): number | null {
  if (value === null) return null
  if (value <= 0) return 0
  return Math.min(5, Math.ceil(value * 5))
}

/** cohort_start is a UTC calendar date, 'YYYY-MM-DD'. Months render as month and year. */
export function formatCohortDate(cohortStart: string, period: 'month' | 'week', locale?: string): string {
  const date = new Date(`${cohortStart}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return cohortStart
  const options: Intl.DateTimeFormatOptions = period === 'month'
    ? { month: 'short', year: 'numeric', timeZone: 'UTC' }
    : { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }
  return new Intl.DateTimeFormat(locale, options).format(date)
}

export function isSmallCohort(signups: number): boolean {
  return signups > 0 && signups < SMALL_COHORT
}

/** Column sums across cohorts: a rate over all of them weighs each account once. */
export function sumCohorts(rows: readonly SignupCohort[]): Omit<SignupCohort, 'cohort_start'> {
  const total = {} as Omit<SignupCohort, 'cohort_start'>
  for (const key of COUNT_KEYS) total[key] = rows.reduce((acc, row) => acc + (row[key] || 0), 0)
  return total
}
