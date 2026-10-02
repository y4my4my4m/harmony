import { describe, expect, it } from 'vitest'
import type { SignupCohort } from '@/services/AdminService'
import {
  RETENTION_METRICS,
  SMALL_COHORT,
  formatCohortDate,
  formatPercent,
  heatLevel,
  isSmallCohort,
  rate,
  sumCohorts,
} from '../retentionFormat'

const cohort = (start: string, n: Partial<SignupCohort> = {}): SignupCohort => ({
  cohort_start: start,
  signups: 0,
  joined_server: 0,
  joined_other_server: 0,
  day1_eligible: 0,
  wrote_day1: 0,
  days1_7_eligible: 0,
  active_days1_7: 0,
  days8_30_eligible: 0,
  active_days8_30: 0,
  days31_90_eligible: 0,
  active_days31_90: 0,
  first_message_eligible: 0,
  answered_1h: 0,
  answered_24h: 0,
  has_push: 0,
  follows_anyone: 0,
  ...n,
})

describe('rate', () => {
  it('is null without a denominator', () => {
    expect(rate(0, 0)).toBeNull()
    expect(rate(3, 0)).toBeNull()
  })

  it('divides and clamps to [0, 1]', () => {
    expect(rate(50, 66)).toBeCloseTo(0.7576, 4)
    expect(rate(0, 66)).toBe(0)
    expect(rate(7, 5)).toBe(1)
  })
})

describe('formatPercent', () => {
  it('renders a dash for a window not reached', () => {
    expect(formatPercent(null, 'en')).toBe('—')
  })

  it('rounds to whole percent', () => {
    expect(formatPercent(50 / 66, 'en')).toBe('76%')
    expect(formatPercent(2 / 66, 'en')).toBe('3%')
    expect(formatPercent(0, 'en')).toBe('0%')
    expect(formatPercent(1, 'en')).toBe('100%')
  })

  it('keeps a nonzero rate from reading as zero', () => {
    expect(formatPercent(1 / 1000, 'en')).toBe('<1%')
  })

  it('follows the locale', () => {
    expect(formatPercent(0.5, 'fr')).toMatch(/^50\s?%$/)
  })
})

describe('heatLevel', () => {
  it('leaves an unreached window unshaded', () => {
    expect(heatLevel(null)).toBeNull()
  })

  it('maps rates onto five steps, zero only for zero', () => {
    expect(heatLevel(0)).toBe(0)
    expect(heatLevel(0.01)).toBe(1)
    expect(heatLevel(0.2)).toBe(1)
    expect(heatLevel(0.21)).toBe(2)
    expect(heatLevel(0.5)).toBe(3)
    expect(heatLevel(0.8)).toBe(4)
    expect(heatLevel(0.81)).toBe(5)
    expect(heatLevel(1)).toBe(5)
  })
})

describe('formatCohortDate', () => {
  it('names a month by month and year in UTC', () => {
    expect(formatCohortDate('2026-05-01', 'month', 'en-US')).toBe('May 2026')
    expect(formatCohortDate('2026-01-01', 'month', 'en-US')).toBe('Jan 2026')
  })

  it('names a week by its Monday', () => {
    expect(formatCohortDate('2026-09-28', 'week', 'en-US')).toBe('Sep 28, 2026')
  })

  it('returns an unparseable value unchanged', () => {
    expect(formatCohortDate('not a date', 'month', 'en-US')).toBe('not a date')
  })
})

describe('isSmallCohort', () => {
  it('flags nonempty cohorts below the threshold', () => {
    expect(isSmallCohort(0)).toBe(false)
    expect(isSmallCohort(1)).toBe(true)
    expect(isSmallCohort(SMALL_COHORT - 1)).toBe(true)
    expect(isSmallCohort(SMALL_COHORT)).toBe(false)
  })
})

describe('sumCohorts', () => {
  it('sums every count so a total rate weighs each account once', () => {
    const total = sumCohorts([
      cohort('2026-05-01', { signups: 66, day1_eligible: 66, wrote_day1: 50 }),
      cohort('2026-06-01', { signups: 4, day1_eligible: 4, wrote_day1: 4 }),
    ])
    expect(total.signups).toBe(70)
    expect(total.wrote_day1).toBe(54)
    expect(rate(total.wrote_day1, total.day1_eligible)).toBeCloseTo(54 / 70, 6)
    expect('cohort_start' in total).toBe(false)
  })

  it('is all zeros for no rows', () => {
    expect(Object.values(sumCohorts([])).every(v => v === 0)).toBe(true)
  })
})

describe('RETENTION_METRICS', () => {
  it('pairs every count with a denominator from the same row', () => {
    const row = cohort('2026-05-01')
    for (const m of RETENTION_METRICS) {
      expect(m.numerator in row).toBe(true)
      expect(m.denominator in row).toBe(true)
      expect(m.numerator).not.toBe(m.denominator)
    }
  })

  it('divides window counts by their own eligibility', () => {
    const byKey = Object.fromEntries(RETENTION_METRICS.map(m => [m.numerator, m.denominator]))
    expect(byKey.wrote_day1).toBe('day1_eligible')
    expect(byKey.active_days8_30).toBe('days8_30_eligible')
    expect(byKey.answered_24h).toBe('first_message_eligible')
    expect(byKey.has_push).toBe('signups')
  })
})
