/**
 * The options bar of a bot slash command: one labelled field per option type, required ones
 * marked, values checked as the server checks them, Enter sends, Escape and the close button
 * leave, and a refusal of the invoke shows inside the bar.
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

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@/services/botCommandService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/botCommandService')>()),
  invokeBotCommand: invoke,
}))

const MEMBER = '33333333-3333-4333-8333-333333333333'
vi.mock('@/services/userDataService', () => ({
  userDataService: {
    getUsersInContext: () => [
      { id: MEMBER, username: 'alice', displayName: 'Alice', avatarUrl: '' },
      { id: 'discord:99', username: 'bridged', displayName: 'Bridged', avatarUrl: '' },
    ],
  },
}))
vi.mock('@/services/RoleService', () => ({
  roleService: { getRolesForServer: vi.fn(async () => [{ id: 'role-1', name: 'crew' }]) },
}))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({
    channels: [
      { id: 'ch-text', name: 'general', type: 0, server_id: 'server-1' },
      { id: 'ch-voice', name: 'Lounge', type: 1, server_id: 'server-1' },
    ],
  }),
}))

const store = vi.hoisted(() => ({ addInvoked: vi.fn(), addLocalFailure: vi.fn() }))
vi.mock('@/stores/useBotInteractions', () => ({ useBotInteractionsStore: () => store }))

import BotCommandBar from '../BotCommandBar.vue'
import { BotCommandError, BotOptionType, type BotCommandOption } from '@/services/botCommandService'
import type { ActiveBotCommand } from '@/composables/useAutoSuggest'

const CHANNEL = '11111111-1111-4111-8111-111111111111'
const bot = { id: 'b0000000-0000-4000-8000-000000000001', username: 'weatherbot', display_name: 'Weatherbot', avatar_url: null }

function active(options: BotCommandOption[], fullName = 'weather'): ActiveBotCommand {
  return {
    command: { id: 'c1', name: fullName.split(' ')[0], description: 'Forecast', options, bot },
    path: fullName.split(' ').slice(1),
    fullName,
    options,
    bot,
    channelId: CHANNEL,
    threadId: null,
  }
}

const mounted: VueWrapper[] = []
async function render(options: BotCommandOption[], fullName?: string) {
  const wrapper = mount(BotCommandBar, {
    props: { command: active(options, fullName), serverId: 'server-1' },
    attachTo: document.body,
    global: { stubs: { Avatar: true } },
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

const field = (wrapper: VueWrapper, name: string) => wrapper.find(`[data-testid="bot-command-option-${name}"]`)
const press = (wrapper: VueWrapper, name: string, key: string) =>
  field(wrapper, name).trigger('keydown', { key })

beforeEach(() => {
  setActivePinia(createPinia())
  invoke.mockReset()
  store.addInvoked.mockReset()
  store.addLocalFailure.mockReset()
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('BotCommandBar', () => {
  it('renders a typed, labelled field per option and marks required ones', async () => {
    const wrapper = await render([
      { type: BotOptionType.STRING, name: 'city', description: 'City name', required: true, max_length: 20 },
      { type: BotOptionType.INTEGER, name: 'days', min_value: 1, max_value: 7 },
      { type: BotOptionType.NUMBER, name: 'lat' },
      { type: BotOptionType.BOOLEAN, name: 'metric' },
      { type: BotOptionType.STRING, name: 'unit', choices: [{ name: 'Celsius', value: 'c' }, { name: 'Fahrenheit', value: 'f' }] },
      { type: BotOptionType.USER, name: 'who' },
      { type: BotOptionType.CHANNEL, name: 'where' },
      { type: BotOptionType.ROLE, name: 'role' },
    ])
    expect(wrapper.attributes('data-testid')).toBe('bot-command-bar')
    expect(wrapper.text()).toContain('/weather')
    expect(wrapper.text()).toContain('Weatherbot')

    const city = field(wrapper, 'city')
    expect(city.attributes('type')).toBe('text')
    expect(city.attributes('maxlength')).toBe('20')
    expect(city.attributes('aria-required')).toBe('true')
    expect(wrapper.find(`label[for="${city.attributes('id')}"]`).text()).toContain('city')
    expect(wrapper.find(`label[for="${city.attributes('id')}"]`).text()).toContain('required')

    const days = field(wrapper, 'days')
    expect(days.attributes()).toMatchObject({ type: 'number', step: '1', min: '1', max: '7' })
    expect(field(wrapper, 'lat').attributes('step')).toBe('any')
    expect(field(wrapper, 'metric').attributes('role')).toBe('switch')
    expect(field(wrapper, 'unit').element.tagName).toBe('SELECT')
    expect(field(wrapper, 'unit').findAll('option').map((o) => o.text())).toEqual(['Choose…', 'Celsius', 'Fahrenheit'])
    expect(field(wrapper, 'who').attributes('role')).toBe('combobox')
    expect(field(wrapper, 'where').findAll('option').map((o) => o.text())).toEqual(['Choose a channel…', '#general'])
    expect(field(wrapper, 'role').findAll('option').map((o) => o.text())).toEqual(['Choose a role…', '@crew'])
  })

  it('focuses the first field on open', async () => {
    const wrapper = await render([{ type: BotOptionType.STRING, name: 'city', required: true }])
    expect(document.activeElement).toBe(field(wrapper, 'city').element)
  })

  it('Enter with a required field empty marks it and sends nothing', async () => {
    const wrapper = await render([{ type: BotOptionType.STRING, name: 'city', required: true }])
    await press(wrapper, 'city', 'Enter')
    await flushPromises()
    expect(invoke).not.toHaveBeenCalled()
    expect(field(wrapper, 'city').attributes('aria-invalid')).toBe('true')
    const errorId = field(wrapper, 'city').attributes('aria-describedby')!
    expect(wrapper.find(`[id="${errorId}"]`).text()).toBe('Required.')
  })

  it('checks lengths, whole numbers and ranges as the server does', async () => {
    const wrapper = await render([
      { type: BotOptionType.STRING, name: 'code', min_length: 3, max_length: 4 },
      { type: BotOptionType.INTEGER, name: 'days', min_value: 1, max_value: 7 },
    ])
    await field(wrapper, 'code').setValue('天気')
    await field(wrapper, 'days').setValue('2.5')
    await press(wrapper, 'days', 'Enter')
    await flushPromises()
    expect(invoke).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('At least 3 characters.')
    expect(wrapper.text()).toContain('Enter a whole number.')
    await field(wrapper, 'days').setValue('9')
    expect(wrapper.text()).toContain('At most 7.')
  })

  it('Enter invokes with the typed values', async () => {
    invoke.mockResolvedValueOnce({ id: 'i-1', respond_in_ms: 5000, expires_in_ms: 900000 })
    const wrapper = await render([
      { type: BotOptionType.STRING, name: 'city', required: true },
      { type: BotOptionType.INTEGER, name: 'days' },
      { type: BotOptionType.NUMBER, name: 'lat' },
      { type: BotOptionType.BOOLEAN, name: 'metric' },
      { type: BotOptionType.BOOLEAN, name: 'alerts', required: true },
      { type: BotOptionType.INTEGER, name: 'level', choices: [{ name: 'Low', value: 1 }, { name: 'High', value: 5 }] },
      { type: BotOptionType.CHANNEL, name: 'where' },
      { type: BotOptionType.ROLE, name: 'role' },
      { type: BotOptionType.STRING, name: 'note' },
    ], 'forecast week')
    await field(wrapper, 'city').setValue('Tokyo')
    await field(wrapper, 'days').setValue('3')
    await field(wrapper, 'lat').setValue('35.68')
    await field(wrapper, 'metric').trigger('click')
    await field(wrapper, 'level').setValue('1')
    await field(wrapper, 'where').setValue('ch-text')
    await field(wrapper, 'role').setValue('role-1')
    await press(wrapper, 'city', 'Enter')
    await flushPromises()

    expect(invoke).toHaveBeenCalledWith({
      channelId: CHANNEL,
      threadId: null,
      commandId: 'c1',
      path: ['week'],
      options: { city: 'Tokyo', days: 3, lat: 35.68, metric: true, alerts: false, level: 5, where: 'ch-text', role: 'role-1' },
    })
    expect(store.addInvoked).toHaveBeenCalledWith(expect.objectContaining({
      result: { id: 'i-1', respond_in_ms: 5000, expires_in_ms: 900000 },
      bot,
      channelId: CHANNEL,
      threadId: null,
      commandName: 'forecast week',
    }))
    expect(wrapper.emitted('invoked')).toEqual([['i-1']])
  })

  it('picks a member from the server list by keyboard', async () => {
    invoke.mockResolvedValueOnce({ id: 'i-1', respond_in_ms: 5000, expires_in_ms: 900000 })
    const wrapper = await render([{ type: BotOptionType.USER, name: 'who', required: true }])
    const who = field(wrapper, 'who')
    await who.trigger('focus')
    await who.setValue('ali')
    const options = wrapper.findAll('[role="option"]')
    expect(options.map((o) => o.text())).toEqual([expect.stringContaining('Alice')])
    await press(wrapper, 'who', 'Enter')
    expect((who.element as HTMLInputElement).value).toBe('Alice')
    expect(invoke).not.toHaveBeenCalled()
    await press(wrapper, 'who', 'Enter')
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ options: { who: MEMBER } }))
  })

  it('a member typed but not picked is refused', async () => {
    const wrapper = await render([{ type: BotOptionType.USER, name: 'who' }])
    await field(wrapper, 'who').setValue('nobody')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(invoke).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Pick one from the list.')
  })

  it('Escape and the close button leave', async () => {
    const wrapper = await render([{ type: BotOptionType.STRING, name: 'city' }])
    await press(wrapper, 'city', 'Escape')
    expect(wrapper.emitted('close')).toHaveLength(1)
    await wrapper.find('[data-testid="bot-command-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(2)
  })

  it('the send button invokes, once while the invoke runs', async () => {
    let answer!: (value: unknown) => void
    invoke.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    const wrapper = await render([])
    await wrapper.find('[data-testid="bot-command-send"]').trigger('click')
    await wrapper.find('form').trigger('submit')
    answer({ id: 'i-2', respond_in_ms: 5000, expires_in_ms: 900000 })
    await flushPromises()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0][0]).toMatchObject({ path: [], options: {} })
    expect(wrapper.emitted('invoked')).toEqual([['i-2']])
  })

  it('shows a refusal inside the bar and keeps it open', async () => {
    const wrapper = await render([{ type: BotOptionType.STRING, name: 'city' }])
    const refusals: Array<[BotCommandError, string]> = [
      [new BotCommandError('slowmode', 'x', '12'), 'Slowmode is on. Try again in 12 s.'],
      [new BotCommandError('rate_limited', 'x', '4'), 'Too many commands. Try again in 4 s.'],
      [new BotCommandError('forbidden', 'x'), 'You do not have permission to use this command here.'],
      [new BotCommandError('timed_out', 'x'), 'You are timed out in this server.'],
      [new BotCommandError('thread_locked', 'x'), 'This thread is locked.'],
      [new BotCommandError('invalid_option', 'x', 'city'), 'The value of city is not accepted.'],
    ]
    for (const [error, text] of refusals) {
      invoke.mockRejectedValueOnce(error)
      await wrapper.find('form').trigger('submit')
      await flushPromises()
      expect(wrapper.find('[data-testid="bot-command-error"]').text()).toBe(text)
    }
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(store.addInvoked).not.toHaveBeenCalled()
  })

  it('an offline bot becomes a line in the list and the bar closes', async () => {
    invoke.mockRejectedValueOnce(new BotCommandError('bot_offline', 'BOT_COMMAND_BOT_OFFLINE'))
    const wrapper = await render([])
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(store.addLocalFailure).toHaveBeenCalledWith(expect.objectContaining({ error: 'offline', commandName: 'weather' }))
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
