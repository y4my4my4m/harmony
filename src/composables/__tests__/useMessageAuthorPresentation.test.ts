import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, defineComponent, ref } from 'vue'
import type { Message } from '@/types'

const calls = vi.hoisted(() => ({ profile: vi.fn(), bot: vi.fn() }))
vi.mock('@/supabase', () => ({ supabase: { from: calls.bot } }))
vi.mock('@/stores/useServerRoles', () => ({ useServerRolesStore: () => ({ getUserRoleColor: () => null }) }))
vi.mock('@/composables/useUserData', () => ({ DEFAULT_USER_COLOR: '#fff', useUserData: () => ({
  getUserDisplayName: (id: string) => { calls.profile(id); return computed(() => 'Native') },
  getUserAvatarUrl: (id: string) => { calls.profile(id); return computed(() => '/native.png') },
  getUserColor: () => computed(() => '#fff'),
}) }))
import { useMessageAuthorPresentation } from '../useMessageAuthorPresentation'

describe('shared author presentation for replies, search and Today', () => {
  it.each(['matrix', 'discord'] as const)('shows a %s person rather than the relay bot or native profile', platform => {
    calls.profile.mockClear(); calls.bot.mockClear()
    const message = ref({ id: 'm', bot_id: 'relay', user_id: 'not-a-person', created_at: new Date(), content: [], metadata: {
      bridge_author: { platform, id: 'remote-id', username: 'sam', display_name: 'Sam', avatar_url: 'https://cdn.test/sam.png' },
    } } as Message)
    let presentation!: ReturnType<typeof useMessageAuthorPresentation>
    const wrapper = mount(defineComponent({ setup() { presentation = useMessageAuthorPresentation(message); return presentation }, template: '<span>{{ displayName }} {{ avatarUrl }} {{ bridgeSource }}</span>' }))
    expect(presentation.displayName.value).toBe('Sam')
    expect(presentation.avatarUrl.value).toBe('https://cdn.test/sam.png')
    expect(presentation.bridgeSource.value).toBe(platform)
    expect(presentation.profileUserId.value).toBe('')
    expect(calls.profile).not.toHaveBeenCalled()
    expect(calls.bot).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
