/**
 * Token handling in UserBotsManagement.vue.
 *
 * The plaintext token exists only in the create_bot / rotate_bot_token
 * response. It is shown once, in a dialog that closes only through its footer
 * button; an existing token is represented by its stored hint and never by a
 * copyable placeholder.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { supabase } from '@/supabase'
import UserBotsManagement from '../UserBotsManagement.vue'

const { toast, confirmMock } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  confirmMock: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('vue-toastification', () => ({
  useToast: () => toast,
}))

vi.mock('@/composables/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: confirmMock }),
}))

vi.mock('@/services/AuthContextService', () => ({
  authContextService: { getCurrentProfileId: vi.fn().mockResolvedValue('profile-1') },
}))

// vi.mock factories are hoisted above imports; the stub is built from a dynamic import.
async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/BotAvatar.vue', () => stub('BotAvatar'))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/LoadingSpinner.vue', () => stub('LoadingSpinner'))
vi.mock('@/components/common/ServerIcon.vue', () => stub('ServerIcon'))
vi.mock('@/components/settings/BridgeBotGuide.vue', () => stub('BridgeBotGuide'))

const BOT = {
  id: 'bot-1',
  username: 'echo-bot',
  display_name: 'Echo',
  bio: null,
  avatar_url: null,
  bot_type: 'bot',
  is_public: true,
  is_verified: false,
  created_at: '2026-09-01T00:00:00Z',
  last_online_at: null,
}

const NEW_TOKEN = `harmony_bot_${'f'.repeat(64)}`

type Result = { data: unknown; error: unknown }

function query(result: Result) {
  const q: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'range', 'or', 'update', 'delete']) {
    q[m] = vi.fn(() => q)
  }
  q.single = vi.fn(() => Promise.resolve(result))
  q.maybeSingle = vi.fn(() => Promise.resolve(result))
  q.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject)
  return q
}

let rpcResults: Record<string, Result>
const writeText = vi.fn()

function mountComponent() {
  return mount(UserBotsManagement, {
    props: { loading: false },
    global: { stubs: { teleport: true } },
  })
}

async function openBot(wrapper: ReturnType<typeof mountComponent>) {
  await flushPromises()
  await wrapper.find('.bot-row').trigger('click')
  await flushPromises()
}

beforeEach(() => {
  vi.clearAllMocks()
  confirmMock.mockResolvedValue(true)

  const tables: Record<string, Result> = {
    bots: { data: [BOT], error: null },
    bot_presence: { data: [], error: null },
    bot_tokens: {
      data: { token_prefix: 'a1b2', created_at: '2026-09-01T00:00:00Z', last_used_at: null },
      error: null,
    },
    servers: { data: [], error: null },
    bot_server_permissions: { data: [], error: null },
  }
  vi.mocked(supabase.from).mockImplementation(((table: string) => query(tables[table])) as never)

  rpcResults = {
    get_owned_bot_server_counts: { data: [{ bot_id: BOT.id, server_count: 2 }], error: null },
    rotate_bot_token: {
      data: { token: NEW_TOKEN, token_hint: 'ffff', token_created_at: '2026-09-30T00:00:00Z' },
      error: null,
    },
    create_bot: {
      data: { bot: { ...BOT, id: 'bot-2', username: 'new-bot', display_name: 'new-bot' }, token: NEW_TOKEN },
      error: null,
    },
  }
  vi.mocked(supabase.rpc).mockImplementation(((fn: string) =>
    Promise.resolve(rpcResults[fn] ?? { data: null, error: null })) as never)

  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  writeText.mockResolvedValue(undefined)
})

describe('UserBotsManagement token handling', () => {
  it('shows the stored hint for an existing token and offers no copy of it', async () => {
    const wrapper = mountComponent()
    await openBot(wrapper)

    expect(wrapper.find('.token-hint').text()).toBe('harmony_bot_…a1b2')
    expect(wrapper.find('.token-value').exists()).toBe(false)
  })

  it('shows a reset token until the footer button dismisses it', async () => {
    const wrapper = mountComponent()
    await openBot(wrapper)

    const reset = wrapper.findAll('button').find(b => b.text().includes('bots.token.reset'))!
    await reset.trigger('click')
    await flushPromises()

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('rotate_bot_token', { p_bot_id: BOT.id })
    expect(wrapper.find('.token-value').text()).toBe(NEW_TOKEN)

    await wrapper.find('.modal-overlay').trigger('click')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.find('.token-value').exists()).toBe(true)

    const done = wrapper.findAll('button').find(b => b.text() === 'bots.token.done')!
    await done.trigger('click')
    expect(wrapper.find('.token-value').exists()).toBe(false)
    expect(wrapper.find('.token-hint').text()).toBe('harmony_bot_…ffff')
  })

  it('shows no token when the reset fails', async () => {
    rpcResults.rotate_bot_token = { data: null, error: { message: 'boom' } }
    const wrapper = mountComponent()
    await openBot(wrapper)

    const reset = wrapper.findAll('button').find(b => b.text().includes('bots.token.reset'))!
    await reset.trigger('click')
    await flushPromises()

    expect(wrapper.find('.token-value').exists()).toBe(false)
    expect(toast.error).toHaveBeenCalledWith('bots.token.resetFailed')
    expect(wrapper.find('.token-hint').text()).toBe('harmony_bot_…a1b2')
  })

  it('reports a clipboard failure instead of claiming the copy succeeded', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    const wrapper = mountComponent()
    await openBot(wrapper)

    const reset = wrapper.findAll('button').find(b => b.text().includes('bots.token.reset'))!
    await reset.trigger('click')
    await flushPromises()

    const copy = wrapper.findAll('button').find(b => b.text() === 'common.copy')!
    await copy.trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith(NEW_TOKEN)
    expect(toast.error).toHaveBeenCalledWith('bots.token.copyFailed')
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringContaining('copied'))
    expect(wrapper.findAll('button').some(b => b.text() === 'common.copied')).toBe(false)
  })

  it('creates the bot and its token in one call and reveals the returned token', async () => {
    const wrapper = mountComponent()
    await flushPromises()

    const newBot = wrapper.findAll('button').find(b => b.text().includes('bots.newBot'))!
    await newBot.trigger('click')
    const username = wrapper.find('#bot-create-username')
    await username.setValue('New-Bot')
    expect((username.element as HTMLInputElement).value).toBe('new-bot')

    const submit = wrapper.findAll('button').find(b => b.text() === 'bots.create.submit')!
    await submit.trigger('click')
    await flushPromises()

    const createCalls = vi.mocked(supabase.rpc).mock.calls.filter(c => c[0] === 'create_bot')
    expect(createCalls).toEqual([[
      'create_bot',
      { p_username: 'new-bot', p_display_name: null, p_bio: null, p_bot_type: 'bot', p_is_public: true },
    ]])
    expect(supabase.from).not.toHaveBeenCalledWith('bot_tokens', expect.anything())
    expect(wrapper.find('.token-value').text()).toBe(NEW_TOKEN)
  })
})
