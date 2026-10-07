import { describe, expect, it } from 'vitest'
import { dmCallRoute, localCallReceivers } from '../dmCallRouting'

const local = (id: string) => ({ id, username: id, is_local: true })
const remote = (id: string) => ({ id, username: id, is_local: false, federated_id: `https://remote.test/users/${id}` })

describe('dmCallRoute', () => {
  it('places every group call locally, whatever other_user holds', () => {
    // get_user_conversations leaves other_user unset on groups; the legacy
    // load puts an is_local-less placeholder there.
    expect(dmCallRoute({ type: 'group', participants: [local('b'), local('c')] })).toBe('local')
    expect(dmCallRoute({ type: 'group', other_user: { id: 'b', username: '' }, participants: [] })).toBe('local')
    expect(dmCallRoute({ type: 'group', participants: [remote('r'), local('c')] })).toBe('local')
  })

  it('federates a direct call only to a peer known to be remote', () => {
    expect(dmCallRoute({ type: 'direct', other_user: remote('r') })).toBe('federated')
    expect(dmCallRoute({ type: 'direct', other_user: local('b') })).toBe('local')
  })

  it('leaves a placeholder peer unresolved instead of assuming remote', () => {
    expect(dmCallRoute({ type: 'direct', other_user: { id: 'b', username: '' } })).toBe('unknown')
  })
})

describe('localCallReceivers', () => {
  it('rings the local members of a group, not the caller and not remote members', () => {
    const group = { type: 'group', participants: [local('me'), local('b'), remote('r'), local('c')] }
    expect(localCallReceivers(group, 'me')).toEqual(['b', 'c'])
  })

  it('rings the peer of a direct conversation', () => {
    expect(localCallReceivers({ type: 'direct', other_user: local('b') }, 'me')).toEqual(['b'])
  })

  it('rings nobody without a caller id', () => {
    expect(localCallReceivers({ type: 'group', participants: [local('b')] }, undefined)).toEqual([])
  })
})
