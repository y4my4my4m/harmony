import { describe, it, expect, vi, beforeEach } from 'vitest'

const hasPermission = vi.fn()
const getRolesForServer = vi.fn()

vi.mock('@/services/RoleService', () => ({
  roleService: { hasPermission: (...a: unknown[]) => hasPermission(...a), getRolesForServer: (...a: unknown[]) => getRolesForServer(...a) },
  Permission: { MENTION_EVERYONE: 'MENTION_EVERYONE' },
}))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: { id: 'me' } }) }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ currentServerId: null, channels: [] }) }))
vi.mock('@/composables/useVisualTheme', () => ({ emoticonPreferences: () => ({ convertSent: false }) }))
vi.mock('@/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      getSession: async () => ({ data: { session: null } }),
    },
    channel: () => ({ on() { return this }, subscribe() { return this } }),
  },
}))

import { resolveChatMassMentions } from '@/utils/chatParseOptions'
import { parseContentToMessageParts } from '@/utils/unifiedContentProcessing'

const SERVER = 's1'
const CHANNEL = 'c1'
const EVERYONE = { id: '00000000-0000-4000-8000-0000000000e0', name: 'everyone', color: null, is_default: true }
const CREW = { id: '00000000-0000-4000-8000-0000000000c1', name: 'crew', color: null, is_default: false }

beforeEach(() => {
  hasPermission.mockReset().mockResolvedValue(false)
  getRolesForServer.mockReset().mockResolvedValue([CREW, EVERYONE])
})

describe('resolveChatMassMentions', () => {
  it('resolves the author\'s right for a role token as for a typed word', async () => {
    for (const text of ['@role:here standup', `@role:${EVERYONE.id} standup`, '@everyone standup']) {
      expect(await resolveChatMassMentions(text, SERVER, CHANNEL)).toEqual({
        allowed: false,
        everyoneRole: { id: EVERYONE.id, name: 'everyone', color: null },
      })
    }
    expect(hasPermission).toHaveBeenCalledWith('me', SERVER, 'MENTION_EVERYONE', CHANNEL)
  })

  it('asks nothing for text without either, or outside a channel', async () => {
    expect(await resolveChatMassMentions('hello @crew', SERVER, CHANNEL)).toBeUndefined()
    expect(await resolveChatMassMentions('@role:here', SERVER, null)).toBeUndefined()
    expect(hasPermission).not.toHaveBeenCalled()
  })

  it('turns a refused @role:<default> and @role:here into text', async () => {
    const text = `@role:${EVERYONE.id} @role:here @role:${CREW.id}`
    const massMentions = await resolveChatMassMentions(text, SERVER, CHANNEL)
    const parts = await parseContentToMessageParts(text, {}, {}, {},
      { [EVERYONE.id]: { name: 'everyone', color: null }, [CREW.id]: { name: 'crew', color: null } },
      { massMentions })
    expect(parts.filter((p) => p.type === 'role_mention')).toEqual([
      { type: 'role_mention', roleId: CREW.id, roleName: 'crew', roleColor: null },
    ])
    expect(parts.map((p) => (p.type === 'text' ? p.text : `<${p.type}>`)).join('')).toBe('@everyone @here <role_mention>')
  })
})
