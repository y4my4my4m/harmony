import { describe, it, expect } from 'vitest'
import { profileCount, isRemoteProfile, remoteCountFields } from '@/utils/profileCounts'

// A remote account shows its origin's totals once read; the local counters stand in only
// before the first read.

const local = { is_local: true, posts_count: 12, followers_count: 3, following_count: 4 }

// @strypey@mastodon.nzoss.nz as stored before the fix: one local follower, nothing else.
const neverRead = { is_local: false, posts_count: 0, followers_count: 1, following_count: 0 }

const read = {
  ...neverRead,
  remote_posts_count: 15230,
  remote_followers_count: 2104,
  remote_following_count: 987,
  remote_counts_fetched_at: '2026-10-10T12:00:00Z',
}

describe('profileCount', () => {
  it('shows a local account\'s counters', () => {
    expect(profileCount(local, 'posts')).toBe(12)
    expect(profileCount(local, 'followers')).toBe(3)
    expect(profileCount({ ...local, remote_followers_count: 999 }, 'followers')).toBe(3)
    expect(profileCount({ is_local: true }, 'following')).toBe(0)
  })

  it('shows a remote account\'s origin totals once read', () => {
    expect(profileCount(read, 'posts')).toBe(15230)
    expect(profileCount(read, 'followers')).toBe(2104)
    expect(profileCount(read, 'following')).toBe(987)
  })

  it('falls back to the local counters before the first read', () => {
    expect(profileCount(neverRead, 'followers')).toBe(1)
    expect(profileCount(neverRead, 'posts')).toBe(0)
  })

  it('reports a total the origin withholds as hidden, not as the local counter', () => {
    const hidden = { ...read, remote_followers_count: null, remote_following_count: null }
    expect(profileCount(hidden, 'followers')).toBeNull()
    expect(profileCount(hidden, 'following')).toBeNull()
    expect(profileCount(hidden, 'posts')).toBe(15230)
  })

  it('treats a row without is_local as local', () => {
    expect(isRemoteProfile({ followers_count: 2 })).toBe(false)
    expect(profileCount({ followers_count: 2, remote_followers_count: 50 }, 'followers')).toBe(2)
    expect(profileCount(null, 'posts')).toBeNull()
  })
})

describe('remoteCountFields', () => {
  it('copies the remote figures present on a row, nulls included', () => {
    expect(remoteCountFields({ ...read, remote_following_count: null, posts_count: 4 })).toEqual({
      remote_posts_count: 15230,
      remote_followers_count: 2104,
      remote_following_count: null,
      remote_counts_fetched_at: '2026-10-10T12:00:00Z',
    })
    expect(remoteCountFields(neverRead)).toEqual({})
    expect(remoteCountFields(undefined)).toEqual({})
  })
})
