/**
 * Pinned messages: a conversation's pins follow conversation rules (any participant unpins,
 * unpin_message), whatever server was viewed last; a server's messages render with its media
 * hidden when this instance hides it (instance_server_blocks.media_hidden).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'

const s = vi.hoisted(() => ({
  local: true,
  canPinInChannel: true,
  currentServerId: 'copy-1' as string | null,
  hidden: ['copy-1'] as string[],
  pins: [] as Record<string, unknown>[],
}))

const PROFILE_PIN = {
  id: 'm1', user_id: 'u1', created_at: '2026-10-20T00:00:00Z', metadata: {},
  content: [{ type: 'text', text: 'pinned' }, { type: 'file', url: 'https://host.test/a.png', fileType: 'image' }],
}

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('@/composables/useDialog', () => ({ useDialog: () => ({ titleId: 't', descriptionId: 'd' }) }))
vi.mock('@/composables/useServerPermissions', async () => {
  const { computed } = await import('vue')
  return { useServerPermissions: () => ({ isLocalServer: computed(() => s.local), canPinMessages: computed(() => false) }) }
})
vi.mock('@/composables/useChannelMessagePermissions', async () => {
  const { computed } = await import('vue')
  return { useChannelMessagePermissions: () => ({ canPinMessages: computed(() => s.canPinInChannel) }) }
})
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ get currentServerId() { return s.currentServerId } }) }))
vi.mock('@/composables/usePinActions', () => ({ usePinActions: () => ({ setPinned: vi.fn() }) }))
vi.mock('@/stores/usePins', () => ({
  pinScopeKey: (channelId?: string | null, conversationId?: string | null) =>
    conversationId ? `dm:${conversationId}` : channelId ? `channel:${channelId}` : null,
  usePinsStore: () => ({
    pinnedMessages: () => s.pins,
    loadList: vi.fn(async () => {}),
    isListStale: () => false,
  }),
}))
vi.mock('@/composables/useUserData', () => ({
  useUserData: () => ({
    getUserDisplayName: () => ref('U1'),
    getUserColor: () => ref(undefined),
    getUserAvatarUrl: () => ref(null),
  }),
}))
vi.mock('@/services/instanceServerTools', () => ({ fetchMediaHiddenServerIds: vi.fn(async () => s.hidden) }))

const ContentStub = defineComponent({
  name: 'UnifiedMessageContent',
  props: { mediaHidden: { type: Boolean, default: false } },
  setup: (props) => () => h('div', { class: 'content-stub', 'data-media-hidden': String(props.mediaHidden) }),
})

import PinnedMessagesPopup from '../PinnedMessagesPopup.vue'
import { resetInstanceMediaHidden } from '@/composables/useInstanceMediaHidden'
import { supabase } from '@/supabase'

enableAutoUnmount(afterEach)

async function mountPopup(props: Record<string, unknown>) {
  const wrapper = mount(PinnedMessagesPopup, {
    props: { isVisible: true, ...props },
    global: {
      stubs: {
        Teleport: true, Transition: false, Avatar: true, LoadingSpinner: true, Icon: true, EmptyState: true, DisplayName: true,
        UnifiedMessageContent: ContentStub,
      },
      mocks: { $t: (key: string) => key },
    },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  resetInstanceMediaHidden()
  s.local = true
  s.canPinInChannel = true
  s.currentServerId = 'copy-1'
  s.hidden = ['copy-1']
  s.pins = [PROFILE_PIN]
})

describe('PinnedMessagesPopup', () => {
  it('offers Unpin in a conversation after a copy of a remote server was the last server viewed', async () => {
    s.local = false
    s.canPinInChannel = false
    const w = await mountPopup({ conversationId: 'dm-1', channelId: 'c-last' })
    expect(w.find('.unpin-btn').exists()).toBe(true)
  })

  it('offers no Unpin in a copy, whose pins are the host\'s', async () => {
    s.local = false
    const w = await mountPopup({ channelId: 'c1' })
    expect(w.find('.unpin-btn').exists()).toBe(false)
  })

  it('hides the media of a server this instance hides', async () => {
    const w = await mountPopup({ channelId: 'c1' })
    expect(w.get('.content-stub').attributes('data-media-hidden')).toBe('true')
  })

  it('shows the media of a conversation, whatever the last server', async () => {
    const w = await mountPopup({ conversationId: 'dm-1', channelId: 'c-last' })
    expect(w.get('.content-stub').attributes('data-media-hidden')).toBe('false')
  })

  it('shows a bridged Discord pin under the Discord name and avatar, not Unknown', async () => {
    s.pins = [{
      id: 'm2', user_id: null, bot_id: 'bridge-bot', created_at: '2026-10-20T00:00:00Z', content: [{ type: 'text', text: 'hi' }],
      metadata: { history_import: true, discord_user: { id: '42', username: 'gus', display_name: 'Gus', avatar_url: 'https://cdn.discordapp.com/avatars/42/a.png' } },
    }]
    const w = await mountPopup({ channelId: 'c1' })
    expect(w.get('.message-author').text()).toBe('Gus')
    expect(w.find('.message-author').text()).not.toContain('Unknown')
    expect(w.findComponent({ name: 'DisplayName' }).exists()).toBe(false)
    expect(w.get('.message-avatar').attributes('src')).toBe('https://cdn.discordapp.com/avatars/42/a.png')
  })

  it('shows a webhook pin under the webhook name', async () => {
    s.pins = [{
      id: 'm3', user_id: null, bot_id: 'hook-bot', created_at: '2026-10-20T00:00:00Z', content: [{ type: 'text', text: 'hi' }],
      metadata: { webhook: { id: 'w1', name: 'Deploys', avatar_url: null } },
    }]
    const w = await mountPopup({ channelId: 'c1' })
    expect(w.get('.message-author').text()).toBe('Deploys')
    expect(w.get('.message-avatar').attributes('src')).toBe('/default_avatar.webp')
  })

  it('shows a bot pin under the bot\'s name and avatar, as chat does', async () => {
    const single = vi.fn(async () => ({
      data: { id: 'plain-bot', username: 'deploybot', display_name: 'Deploy Bot', avatar_url: 'https://cdn.test/bot.png' },
      error: null,
    }))
    const eq = vi.fn(() => ({ single }))
    vi.mocked(supabase.from).mockReturnValue({ select: () => ({ eq }) } as never)
    s.pins = [
      { id: 'm4', user_id: null, bot_id: 'plain-bot', created_at: '2026-10-20T00:00:00Z', content: [{ type: 'text', text: 'hi' }], metadata: {} },
      { id: 'm5', user_id: null, bot_id: 'plain-bot', created_at: '2026-10-21T00:00:00Z', content: [{ type: 'text', text: 'again' }], metadata: {} },
    ]
    const w = await mountPopup({ channelId: 'c1' })
    expect(supabase.from).toHaveBeenCalledWith('bots')
    expect(eq).toHaveBeenCalledWith('id', 'plain-bot')
    expect(single).toHaveBeenCalledTimes(1)
    expect(w.findAll('.message-author').map(a => a.text())).toEqual(['Deploy Bot', 'Deploy Bot'])
    expect(w.findAll('.message-avatar').map(a => a.attributes('src'))).toEqual(['https://cdn.test/bot.png', 'https://cdn.test/bot.png'])
    expect(w.findComponent({ name: 'DisplayName' }).exists()).toBe(false)
  })

  it('keeps the member profile for a pin a person wrote', async () => {
    const w = await mountPopup({ channelId: 'c1' })
    expect(w.findComponent({ name: 'DisplayName' }).exists()).toBe(true)
  })
})
