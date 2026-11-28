import { describe, it, expect } from 'vitest'
import {
  instanceRulesToAp,
  MAX_RULES,
  parseGroupWelcome,
  ruleTitles,
  welcomeToAp,
} from '../activitypub/groupWelcome.js'

// harmony:welcome and harmony:instanceRules: what a host sends, and what a copy accepts.

const NOW = new Date('2026-11-27T00:00:00Z')

describe('welcomeToAp', () => {
  it('drops rules with no title and caps the list at the screen\'s limit', () => {
    const rules = [{ title: '  ', description: 'x' }, ...Array.from({ length: 30 }, (_, i) => ({ title: `R${i}`, description: '' }))]
    const welcome = welcomeToAp({ enabled: false, rules }, null)
    expect(welcome.rules).toHaveLength(MAX_RULES)
    expect(welcome.rules[0].title).toBe('R0')
  })

  it('keeps line breaks in the message and descriptions, not in titles', () => {
    const welcome = welcomeToAp({
      enabled: true, enabled_at: '2026-11-01T00:00:00Z', message: 'a\nb',
      rules: [{ title: 'one\ntwo', description: 'c\nd' }],
    }, null)
    expect(welcome.message).toBe('a\nb')
    expect(welcome.rules[0]).toEqual({ title: 'one two', description: 'c\nd' })
  })
})

describe('parseGroupWelcome', () => {
  it('is null for anything but an object, which leaves a copy\'s screen alone', () => {
    for (const value of [undefined, null, 'rules', [], 3]) expect(parseGroupWelcome(value, NOW)).toBeNull()
  })

  it('reads a missing time as now, which holds no one who joined earlier', () => {
    const welcome = parseGroupWelcome({ enabled: true, requireAcceptance: true, rules: [{ title: 'Be kind' }] }, NOW)
    expect(welcome).toMatchObject({ enabledAt: NOW.toISOString(), acceptanceRequiredAt: NOW.toISOString() })
  })

  it('does not require acceptance of no rules', () => {
    const welcome = parseGroupWelcome({ requireAcceptance: true, acceptanceRequiredAt: '2026-11-01T00:00:00Z', rules: [] }, NOW)
    expect(welcome).toMatchObject({ requireAcceptance: false, acceptanceRequiredAt: null })
  })

  it('keeps no message on a disabled screen, and bounds what it keeps', () => {
    expect(parseGroupWelcome({ enabled: false, message: 'hidden' }, NOW)?.message).toBe('')
    const long = parseGroupWelcome({
      enabled: true, message: 'm'.repeat(5000), rules: [{ title: 't'.repeat(300), description: 'd'.repeat(900) }],
    }, NOW)!
    expect(long.message).toHaveLength(2000)
    expect(long.rules[0].title).toHaveLength(100)
    expect(long.rules[0].description).toHaveLength(500)
  })

  it('takes plain strings as titles, as servers.rules holds them', () => {
    expect(ruleTitles(parseGroupWelcome({ rules: ['No spam', { title: 'Be kind' }, 7] }, NOW))).toEqual(['No spam', 'Be kind'])
  })
})

describe('instanceRulesToAp', () => {
  it('keeps non-empty strings only', () => {
    expect(instanceRulesToAp(['Follow the law', '', 3, null, ' Be kind '])).toEqual(['Follow the law', 'Be kind'])
    expect(instanceRulesToAp({ rules: [] })).toEqual([])
  })
})
