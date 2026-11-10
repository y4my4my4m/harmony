/**
 * The invoker's lines at the end of a channel or thread list: thinking, a private reply with
 * Dismiss, did not respond, offline, can't post. A public reply arriving in the list removes
 * the line; opening the list re-reads its rows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/composables/useT', async () => {
  const { createI18n } = await import('vue-i18n')
  const en = (await import('@/locales/en.json')).default
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
  return { useT: () => ({ t: i18n.global.t, locale: i18n.global.locale }) }
})
vi.mock('@/composables/useInstanceMediaHidden', async () => {
  const { computed } = await import('vue')
  return { useServerMediaHidden: () => computed(() => false) }
})
vi.mock('@/services/UserEventChannel', () => ({ userEventChannel: { on: () => () => {} } }))
const getMine = vi.hoisted(() => vi.fn(async () => null))
vi.mock('@/services/botCommandService', () => ({ getMyBotInteractions: getMine }))

import BotInteractionNotice from '../BotInteractionNotice.vue'
import { useBotInteractionsStore } from '@/stores/useBotInteractions'
import type { Message } from '@/types'

const CHANNEL = '11111111-1111-4111-8111-111111111111'
const THREAD = '22222222-2222-4222-8222-222222222222'
const ID = 'a0000000-0000-4000-8000-000000000001'
const bot = { id: 'b0000000-0000-4000-8000-000000000001', username: 'weatherbot', display_name: 'Weatherbot', avatar_url: null }

let wrapper: VueWrapper | null = null

async function render(threadId: string | null = null, messages: Message[] = []) {
  wrapper = mount(BotInteractionNotice, {
    props: { channelId: CHANNEL, threadId, messages },
    global: { stubs: { Avatar: true, Icon: true, UnifiedMessageContent: { props: ['content'], template: '<div class="umc">{{ content[0].text }}</div>' } } },
  })
  await flushPromises()
  return wrapper
}

const invoke = (threadId: string | null = null) => useBotInteractionsStore().addInvoked({
  result: { id: ID, respond_in_ms: 5000, expires_in_ms: 900000 },
  bot,
  channelId: CHANNEL,
  threadId,
  commandName: 'weather',
})

const notice = () => wrapper!.find('[data-testid="bot-interaction-notice"]')

beforeEach(() => {
  setActivePinia(createPinia())
  getMine.mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
})

describe('BotInteractionNotice', () => {
  it('says the bot is thinking, then that it did not respond', async () => {
    invoke()
    await render()
    expect(notice().attributes()).toMatchObject({ 'data-interaction-id': ID, 'data-status': 'pending' })
    expect(notice().text().replace(/\s+/g, ' ')).toContain('You used /weather · Weatherbot is thinking…')
    expect(wrapper!.find('[data-testid="bot-interaction-dismiss"]').exists()).toBe(false)

    vi.advanceTimersByTime(5_000)
    await flushPromises()
    expect(notice().attributes('data-status')).toBe('timed_out')
    expect(notice().text()).toContain('Weatherbot did not respond.')
    await wrapper!.get('[data-testid="bot-interaction-dismiss"]').trigger('click')
    expect(notice().exists()).toBe(false)
  })

  it('shows a private reply, marked as visible to the invoker only', async () => {
    invoke()
    const store = useBotInteractionsStore()
    const row = store.rows[ID]
    row.status = 'responded'
    row.ephemeral = true
    row.replies = [{ id: 'r1', content: [{ type: 'text', text: 'Sunny in Tokyo' }], created_at: '', edited_at: null }]
    await render()
    expect(notice().attributes('data-status')).toBe('responded')
    expect(wrapper!.get('[data-testid="bot-interaction-reply"]').text()).toBe('Sunny in Tokyo')
    expect(notice().text().replace(/\s+/g, ' ')).toContain('Only you can see this · Dismiss')
    expect(notice().text()).toContain('Weatherbot')
  })

  it('names offline and channel refusals', async () => {
    const store = useBotInteractionsStore()
    store.addLocalFailure({ bot, channelId: CHANNEL, threadId: null, commandName: 'weather', error: 'offline' })
    store.addLocalFailure({ bot, channelId: CHANNEL, threadId: null, commandName: 'weather', error: 'bot_cannot_post' })
    await render()
    const lines = wrapper!.findAll('[data-testid="bot-interaction-notice"]')
    expect(lines.map((l) => l.attributes('data-status'))).toEqual(['offline', 'failed'])
    expect(lines[0].text()).toContain('Weatherbot is offline.')
    expect(lines[1].text()).toContain("Weatherbot can't post in this channel.")
  })

  it('keeps to its channel or thread', async () => {
    invoke(THREAD)
    await render(null)
    expect(notice().exists()).toBe(false)
    await wrapper!.setProps({ threadId: THREAD })
    expect(notice().exists()).toBe(true)
  })

  it('a public reply in the list removes the line', async () => {
    invoke()
    await render()
    expect(notice().exists()).toBe(true)
    const reply = {
      id: 'm1', created_at: new Date(), channel_id: CHANNEL, bot_id: bot.id, content: [],
      metadata: { interaction: { id: ID, name: 'weather', user_id: 'u1' } },
    } as unknown as Message
    await wrapper!.setProps({ messages: [reply] })
    expect(notice().exists()).toBe(false)
  })

  it('re-reads the rows of the list it opens', async () => {
    invoke(THREAD)
    await render(THREAD)
    expect(getMine).toHaveBeenCalledWith([ID])
  })
})
