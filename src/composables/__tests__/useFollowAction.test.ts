import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'

const software = new Map<string, string | null>()
const lookup = vi.fn(async (host: string) => (software.has(host) ? { software: software.get(host) } : null))
vi.mock('@/services/TrendingService', () => ({ trendingService: { getFederatedInstanceByDomain: (host: string) => lookup(host) } }))

import { useFollowAction } from '../useFollowAction'

beforeEach(() => {
  software.clear()
  lookup.mockClear()
})

describe('useFollowAction', () => {
  it('follows an account that does not approve followers, without a lookup', async () => {
    const user = ref({ is_local: false, domain: 'mastodon.social', federated_id: 'https://mastodon.social/users/a', manually_approves_followers: false })
    const { action } = useFollowAction(() => user.value)
    await flushPromises()
    expect(action.value).toBe('follow')
    expect(lookup).not.toHaveBeenCalled()
  })

  it('requests to follow a locked account', async () => {
    software.set('mastodon.social', 'mastodon')
    const user = ref({ is_local: false, domain: 'mastodon.social', federated_id: 'https://mastodon.social/users/a', manually_approves_followers: true })
    const { action } = useFollowAction(() => user.value)
    await flushPromises()
    expect(action.value).toBe('request')
  })

  it('sends a friend request to a Shoot account, read from the actor host', async () => {
    software.set('chat.understars.dev', 'Shoot')
    const user = ref({ is_local: false, domain: 'understars.dev', federated_id: 'https://chat.understars.dev/users/doesnm', manually_approves_followers: true })
    const { action } = useFollowAction(() => user.value)
    await flushPromises()
    expect(lookup).toHaveBeenCalledWith('chat.understars.dev')
    expect(action.value).toBe('friendRequest')
  })

  it('requests to follow a locked local account without a lookup', async () => {
    const user = ref({ is_local: true, domain: 'harmony.test', manually_approves_followers: true })
    const { action } = useFollowAction(() => user.value)
    await flushPromises()
    expect(action.value).toBe('request')
    expect(lookup).not.toHaveBeenCalled()
  })

  it('takes the lock from the caller when given', async () => {
    const locked = ref(false)
    const user = ref({ is_local: false, domain: 'example.social', federated_id: 'https://example.social/u/a' })
    const { action } = useFollowAction(() => user.value, () => locked.value)
    await flushPromises()
    expect(action.value).toBe('follow')
    locked.value = true
    await nextTick()
    await flushPromises()
    expect(action.value).toBe('request')
  })

  it('drops an answer for an account no longer shown', async () => {
    let release: (v: unknown) => void = () => {}
    lookup.mockImplementationOnce(() => new Promise((r) => { release = r }))
    const user = ref({ is_local: false, domain: 'understars.dev', federated_id: 'https://chat.understars.dev/u/a', manually_approves_followers: true })
    const { action } = useFollowAction(() => user.value)
    user.value = { is_local: false, domain: 'other.social', federated_id: 'https://other.social/u/b', manually_approves_followers: true }
    await nextTick()
    release({ software: 'shoot' })
    await flushPromises()
    expect(action.value).toBe('request')
  })
})
