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
}))

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
    pinnedMessages: () => [{
      id: 'm1', user_id: 'u1', created_at: '2026-10-20T00:00:00Z', metadata: {},
      content: [{ type: 'text', text: 'pinned' }, { type: 'file', url: 'https://host.test/a.png', fileType: 'image' }],
    }],
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
})
