import { describe, it, expect } from 'vitest'
import { badgeFromMembership } from '../FundingService'

const GOLD = { name: 'Gold', badge_icon: 'star', badge_color: '#fc0' }
const BADGE = { tier_name: 'Gold', badge_icon: 'star', badge_color: '#fc0', is_active: true }

describe('badgeFromMembership', () => {
  // PostgREST embeds instance_supporters (user_id unique) as one object.
  it('reads the one-to-one embed object', () => {
    expect(badgeFromMembership({ is_active: true, tier: GOLD })).toEqual(BADGE)
    expect(badgeFromMembership({ is_active: false, tier: GOLD })).toBeNull()
    expect(badgeFromMembership(null)).toBeNull()
  })

  it('reads the array get_home_timeline_page builds', () => {
    expect(badgeFromMembership([{ is_active: true, tier: GOLD }])).toEqual(BADGE)
    expect(badgeFromMembership([{ is_active: true, tier: null }])).toBeNull()
    expect(badgeFromMembership([])).toBeNull()
  })
})
