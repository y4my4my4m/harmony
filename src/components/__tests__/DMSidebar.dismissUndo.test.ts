/**
 * DMSidebar.vue rows and dismissal: a row is a link named with its unread
 * count, Dismiss is a separate button after it, and dismissing leaves an Undo
 * in its place that takes focus.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

const state = vi.hoisted(() => ({
  hideResult: true,
  restoreResult: true,
  hide: null as unknown as ReturnType<typeof vi.fn>,
  restore: null as unknown as ReturnType<typeof vi.fn>,
  reset: () => {},
}))

vi.mock('@/stores/useDM', async () => {
  const { reactive } = await import('vue')
  const seed = () => [
    { id: 'conv-a', type: 'direct', unread_count: 3, is_muted: false, created_at: '2026-01-02', other_user: { id: 'a', username: 'alice', is_local: true } },
    { id: 'conv-b', type: 'direct', unread_count: 0, is_muted: true, created_at: '2026-01-01', other_user: { id: 'b', username: 'bob', is_local: true } },
  ]
  const conversations = reactive(seed())
  state.reset = () => conversations.splice(0, conversations.length, ...seed())
  state.hide = vi.fn(async (id: string) => {
    const i = conversations.findIndex((c) => c.id === id)
    const [removed] = conversations.splice(i, 1)
    if (state.hideResult) return true
    conversations.splice(i, 0, removed)
    return false
  })
  state.restore = vi.fn(async (conversation: (typeof conversations)[number]) => {
    if (!conversations.some((c) => c.id === conversation.id)) conversations.unshift(conversation)
    return state.restoreResult
  })
  const store = reactive({
    get getSortedConversations() {
      return conversations
    },
    conversations,
    loadingConversations: false,
    isInitializing: false,
    currentConversationId: null,
    searchResults: [],
    isSearching: false,
    hideConversation: (id: string) => state.hide(id),
    restoreConversation: (c: unknown) => state.restore(c),
    prefetchConversationMessages: vi.fn(),
    loadConversationUserProfile: vi.fn(async () => false),
  })
  return { useDMStore: () => store }
})
vi.mock('@/stores/useActivityPub', () => ({ useActivityPubStore: () => ({ blockedUsers: new Set(), isBlocked: () => false }) }))
vi.mock('@/composables/useUserData', async () => {
  const { ref } = await import('vue')
  const names: Record<string, string> = { a: 'Alice', b: 'Bob' }
  return {
    useUserData: () => ({
      getUserDisplayName: (id: string) => ref(names[id] ?? ''),
      getUserAvatarUrl: () => ref(''),
      getCurrentUser: ref({ id: 'me' }),
      subscribeToDMPresence: vi.fn(),
      getPresenceAwareStatus: () => ref('online'),
    }),
  }
})
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    t: (key: string, named?: Record<string, unknown>) => (named ? `${key}(${Object.values(named).join(',')})` : key),
  }),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => ({ isConnectedOrJoining: false, effectiveChannelId: null }) }))
vi.mock('@/composables/useCallSwitch', () => ({ dmConversationIdFromChannel: () => null }))
vi.mock('@/composables/useDMCallJoin', () => ({ useDMCallJoin: () => ({ joinConversationCall: vi.fn() }) }))

const stub = vi.hoisted(() => (name: string) => ({ default: { name, render: () => null } }))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/EmptyState.vue', () => stub('EmptyState'))
vi.mock('@/components/common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/common/GroupIcon.vue', () => stub('GroupIcon'))
vi.mock('@/components/DisplayName.vue', async () => {
  const { defineComponent, h } = await import('vue')
  const names: Record<string, string> = { a: 'Alice', b: 'Bob' }
  return { default: defineComponent({ props: ['userId'], setup: (p) => () => h('span', names[p.userId as string]) }) }
})
vi.mock('@/components/dm/GroupChatInviteModal.vue', () => stub('GroupChatInviteModal'))

import DMSidebar from '../DMSidebar.vue'

let wrapper: VueWrapper | null = null
const mountSidebar = () => {
  wrapper = mount(DMSidebar, { attachTo: document.body, global: { mocks: { $t: (key: string) => key } } })
  return wrapper
}
const link = (id: string) => document.querySelector<HTMLAnchorElement>(`[data-conversation-id="${id}"] .conversation-link`)
const dismiss = (id: string) => document.querySelector<HTMLButtonElement>(`[data-conversation-id="${id}"] [data-testid="dm-conversation-dismiss"]`)
const undo = () => document.querySelector<HTMLButtonElement>('[data-testid="dm-undo-dismiss"]')

beforeEach(() => {
  state.reset()
  state.hide.mockClear()
  state.restore.mockClear()
  state.hideResult = true
  state.restoreResult = true
  toast.error.mockReset()
})

afterEach(async () => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('DMSidebar rows', () => {
  it('are links named with unread count and mute, ahead of the preview', () => {
    mountSidebar()
    const a = link('conv-a')!
    expect(a.getAttribute('href')).toBe('/dm/conv-a')
    const sr = a.querySelector('.sr-only')!.textContent
    expect(sr).toBe(', chatNav.rail.unreadMessages(3). ')
    expect(link('conv-b')!.querySelector('.sr-only')!.textContent).toBe(', chatNav.channel.muted. ')
    expect(a.querySelector('.unread-count')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('activating a row selects it and never dismisses', async () => {
    const w = mountSidebar()
    link('conv-a')!.click()
    await flushPromises()
    expect(w.emitted('conversationSelected')).toEqual([['conv-a']])
    expect(state.hide).not.toHaveBeenCalled()
  })

  it('places Dismiss after the link, named for the conversation', () => {
    mountSidebar()
    const row = document.querySelector('[data-conversation-id="conv-a"]')!
    const focusables = Array.from(row.querySelectorAll('a, button'))
    expect(focusables[0]).toBe(link('conv-a'))
    expect(focusables.at(-1)).toBe(dismiss('conv-a'))
    expect(dismiss('conv-a')!.getAttribute('aria-label')).toBe('chatNav.dm.dismissNamed(Alice)')
  })
})

describe('DMSidebar dismiss and undo', () => {
  it('leaves an Undo in place of the row with focus; Undo restores the row and focuses it', async () => {
    mountSidebar()
    dismiss('conv-a')!.focus()
    dismiss('conv-a')!.click()
    await flushPromises()
    expect(state.hide).toHaveBeenCalledWith('conv-a')
    expect(link('conv-a')).toBeNull()
    expect(document.activeElement).toBe(undo())
    const describedBy = undo()!.getAttribute('aria-describedby')!
    expect(document.getElementById(describedBy)?.textContent).toBe('chatNav.dm.dismissed(Alice)')

    undo()!.click()
    await flushPromises()
    expect(state.restore).toHaveBeenCalled()
    expect(undo()).toBeNull()
    expect(document.activeElement).toBe(link('conv-a'))
  })

  it('dismissing the last conversation still offers Undo', async () => {
    mountSidebar()
    dismiss('conv-b')!.click()
    await flushPromises()
    undo()!.click()
    await flushPromises()
    dismiss('conv-a')!.click()
    await flushPromises()
    dismiss('conv-b')!.click()
    await flushPromises()
    expect(document.querySelectorAll('[data-testid="dm-conversation-item"]')).toHaveLength(0)
    expect(document.activeElement).toBe(undo())
  })

  it('a failed dismissal puts the row back with focus and reports it', async () => {
    state.hideResult = false
    mountSidebar()
    dismiss('conv-a')!.click()
    await flushPromises()
    expect(undo()).toBeNull()
    expect(document.activeElement).toBe(link('conv-a'))
    expect(toast.error).toHaveBeenCalledWith('dm.failedToDismissConversation')
  })

  it('Undo expires; focus on it moves to the row now in its place', async () => {
    vi.useFakeTimers()
    mountSidebar()
    dismiss('conv-a')!.click()
    await flushPromises()
    expect(document.activeElement).toBe(undo())
    vi.advanceTimersByTime(10_000)
    await flushPromises()
    expect(undo()).toBeNull()
    expect(document.activeElement).toBe(link('conv-b'))
  })
})
