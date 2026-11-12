/**
 * A message author shows the server profile (nickname, server avatar) inside a server channel
 * and the account profile in a DM, which has no server id.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'

vi.mock('@/supabase', () => ({
  SUPABASE_URL: 'http://db.test',
  SUPABASE_ANON_KEY: 'anon',
  supabase: {
    from: () => {
      const q: any = { select: () => q, eq: () => q, in: () => q, single: async () => ({ data: null }), then: (r: any) => r({ data: [], error: null }) }
      return q
    },
    rpc: vi.fn(async () => ({ data: null, error: null })),
    channel: () => {
      const ch: any = { on: () => ch, subscribe: () => ch }
      return ch
    },
    removeChannel: vi.fn(async () => 'ok'),
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}))

import { setActivePinia, createPinia } from 'pinia'
import { userDataService } from '@/services/userDataService'
import { useMessageAuthorPresentation } from '../useMessageAuthorPresentation'
import type { Message } from '@/types'

const U = 'user-1'
const S = 'server-S'

const message = (extra: Partial<Message> = {}) =>
  ref({ id: 'm1', user_id: U, channel_id: 'c1', content: 'hi', metadata: {}, ...extra } as unknown as Message)

describe('useMessageAuthorPresentation server profiles', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(userDataService as any).users.clear()
    ;(userDataService as any).users.set(U, {
      id: U, username: 'ally_acct', displayName: 'Account Name', avatarUrl: 'account.png',
      status: 0, isOnline: false, isMobile: false, createdAt: '', lastSeen: '', lastHeartbeat: '',
      isLocal: true, lastCacheUpdate: '', source: 'database',
    })
    userDataService.setMemberServerProfile(S, U, { nickname: 'Ally', avatar_url: 'server.png' })
  })

  it('shows the nickname and server avatar in a server channel', () => {
    const author = useMessageAuthorPresentation(message(), { serverId: S })
    expect(author.displayName.value).toBe('Ally')
    expect(author.avatarUrl.value).toBe('server.png')
  })

  it('shows the account name and avatar in a DM, which has no server id', () => {
    const author = useMessageAuthorPresentation(message({ channel_id: null as never, conversation_id: 'conv-1' }), { serverId: null })
    expect(author.displayName.value).toBe('Account Name')
    expect(author.avatarUrl.value).toBe('account.png')
    const noOptions = useMessageAuthorPresentation(message())
    expect(noOptions.displayName.value).toBe('Account Name')
  })

  it('shows the account profile for a member of a different server', () => {
    const author = useMessageAuthorPresentation(message(), { serverId: 'other-server' })
    expect(author.displayName.value).toBe('Account Name')
  })
})
