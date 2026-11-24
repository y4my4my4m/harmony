/** MatrixBridgeSettings.vue: Server settings → Bridges → Matrix. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'

const api = vi.hoisted(() => ({
  fetchServerMatrixBridges: vi.fn(),
  fetchOwnedBotInstalls: vi.fn(),
  setMatrixBridgeSenderMode: vi.fn(),
  configureMatrixBridge: vi.fn(),
  unconfigureMatrixBridge: vi.fn(),
  fetchServerChannels: vi.fn(),
  confirm: vi.fn(),
}))
vi.mock('../matrixBridgeApi', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchServerMatrixBridges: api.fetchServerMatrixBridges,
  fetchOwnedBotInstalls: api.fetchOwnedBotInstalls,
  setMatrixBridgeSenderMode: api.setMatrixBridgeSenderMode,
  configureMatrixBridge: api.configureMatrixBridge,
  unconfigureMatrixBridge: api.unconfigureMatrixBridge,
}))
vi.mock('@/components/settings/discord-bridge/bridgeApi', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchServerChannels: api.fetchServerChannels,
}))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: api.confirm }) }))
vi.mock('@/stores/useProfile', async () => {
  const { reactive } = await import('vue')
  const profile = reactive({ profileId: 'member' })
  return { useProfileStore: () => profile }
})

import MatrixBridgeSettings from '../MatrixBridgeSettings.vue'
import { MATRIX_BRIDGE_GUIDE_URL, type MatrixBotInstall, type MatrixBridgePair } from '../matrixBridgeApi'
import { useProfileStore } from '@/stores/useProfile'

const missingKeys: string[] = []
const i18n = () => createI18n({
  legacy: false,
  locale: 'en',
  messages: { en },
  missing: (_locale: string, key: string) => { missingKeys.push(key) },
  missingWarn: false,
  fallbackWarn: false,
})

const CHANNELS = [
  { id: 'c-general', name: 'general', categoryName: null },
  { id: 'c-news', name: 'news', categoryName: 'Community' },
  { id: 'c-secret', name: 'secret', categoryName: 'Community' },
]
const myBot: MatrixBotInstall = {
  bot_id: 'bot', bot_display_name: 'Matrix Bridge', bot_active: true, install_active: true, read_send: true,
  allowed_channel_ids: ['c-general', 'c-news'],
}
const pair: MatrixBridgePair = {
  bot_id: 'bot', bot_display_name: 'Matrix Bridge', channel_id: 'c-general', channel_name: 'general',
  room_id: '!room:hs', sender_mode: 'relay', active: true,
}

let wrapper: VueWrapper
const PrivacyPanel = { name: 'BridgePrivacyPanel', props: ['serverId', 'platform'], template: '<div class="privacy-stub" />' }

function given({ pairs = [pair] as unknown, installs = [myBot] as unknown, channels = CHANNELS as unknown } = {}) {
  api.fetchServerMatrixBridges.mockResolvedValue(pairs)
  api.fetchOwnedBotInstalls.mockResolvedValue(installs)
  api.fetchServerChannels.mockResolvedValue(channels)
}
const mountSettings = () => mount(MatrixBridgeSettings, {
  props: { serverId: 'server' },
  attachTo: document.body,
  global: { plugins: [i18n()], stubs: { BridgePrivacyPanel: PrivacyPanel } },
})
async function open(state?: Parameters<typeof given>[0]) {
  given(state)
  wrapper = mountSettings()
  await flushPromises()
}
const byTest = (id: string) => wrapper.find(`[data-testid="${id}"]`)
const reload = () => wrapper.findAll('[data-testid="matrix-bridge-reload"]').at(-1)!.trigger('click')
const pairsHeading = () => wrapper.findAll('h3').find(h => h.text() === 'Paired channels')!
function deferred() { let resolve!: (value: unknown) => void; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  useProfileStore().profileId = 'member'
  missingKeys.length = 0
})
afterEach(() => {
  wrapper?.unmount()
  expect(missingKeys).toEqual([])
})

describe('status card', () => {
  it('says the bridge is not set up when nothing is paired', async () => {
    await open({ pairs: [] })
    expect(byTest('matrix-status-title').text()).toBe('Not set up')
    expect(byTest('matrix-status-line').text()).toBe('No channel on this server is bridged to Matrix yet.')
    expect(byTest('matrix-status-paired').exists()).toBe(false)
  })

  it('counts paired, connected, waiting and stopped channels and names the bots', async () => {
    await open({
      pairs: [
        pair,
        { ...pair, channel_id: 'c-news', channel_name: 'news', room_id: null },
        { ...pair, bot_id: 'other', bot_display_name: 'Other Bridge', channel_id: 'c-secret', channel_name: 'secret', active: false },
      ],
    })
    expect(byTest('matrix-status').attributes('data-state')).toBe('problem')
    expect(byTest('matrix-status-title').text()).toBe('Needs attention')
    expect(byTest('matrix-status-line').text()).toContain("1 paired channel isn't being bridged")
    expect(byTest('matrix-status-bot').text()).toBe('Matrix Bridge, Other Bridge')
    expect(wrapper.text()).toContain('Bridge bots')
    expect(byTest('matrix-status-paired').text()).toBe('3')
    expect(byTest('matrix-status-rooms').text()).toBe('1')
    expect(byTest('matrix-status-waiting').text()).toBe('1')
    expect(byTest('matrix-status-stopped').text()).toBe('1')
  })

  it.each([
    [[{ ...pair, room_id: null }], 'Waiting for Matrix rooms', '1 channel is waiting for the bridge to connect a Matrix room.'],
    [[pair], 'Bridged to Matrix', 'Every paired channel has a Matrix room.'],
  ])('reads %j as one state', async (pairs, title, line) => {
    await open({ pairs })
    expect(byTest('matrix-status-title').text()).toBe(title)
    expect(byTest('matrix-status-line').text()).toBe(line)
    expect(byTest('matrix-status-stopped').exists()).toBe(false)
  })
})

describe('setup from the empty state', () => {
  it('pairs chosen channels of the caller\'s bot, explains the ones outside its list, and shows the new card', async () => {
    await open({ pairs: [] })
    expect(byTest('matrix-bridge-empty').text()).toBe('No channel is paired with Matrix yet.')
    const form = byTest('matrix-setup')
    expect(form.find('h4').text()).toBe('Pair channels with Matrix')
    expect(form.findAll('[data-testid="matrix-setup-bot"] option').map(o => o.text())).toEqual(['Matrix Bridge'])
    const boxes = form.findAll('input[type="checkbox"]')
    expect(boxes.map(box => (box.element as HTMLInputElement).disabled)).toEqual([false, false, true])
    const secret = form.find('[data-channel="c-secret"]')
    expect(secret.text()).toContain("Not in Matrix Bridge's channel list")
    const help = byTest('matrix-setup-allowlist-help')
    expect(help.text()).toContain('Server settings → Advanced settings → Server bots')
    expect(boxes[2].attributes('aria-describedby')).toBe(help.attributes('id'))
    expect(byTest('matrix-guide-link').attributes('href')).toBe(MATRIX_BRIDGE_GUIDE_URL)

    await form.trigger('submit')
    expect(byTest('matrix-setup-error').text()).toBe('Choose at least one channel.')
    expect(api.configureMatrixBridge).not.toHaveBeenCalled()

    await boxes[1].setValue(true)
    expect(byTest('matrix-setup-error').exists()).toBe(false)
    api.configureMatrixBridge.mockResolvedValueOnce(true)
    api.fetchServerMatrixBridges.mockResolvedValue([{ ...pair, channel_id: 'c-news', channel_name: 'news', room_id: null }])
    await form.trigger('submit'); await flushPromises()
    expect(api.configureMatrixBridge).toHaveBeenCalledWith('bot', 'server', ['c-news'])
    const card = byTest('matrix-pair')
    expect(card.text()).toContain('#news')
    expect(card.text()).toContain('Waiting for the bridge to connect a room')
    expect(card.find('[data-testid="matrix-pair-badge"]').text()).toBe('Waiting for a room')
    expect(byTest('matrix-bridge-notice').text()).toBe('1 channel is paired with Matrix.')
    expect(byTest('matrix-bridge-notice').attributes('role')).toBe('status')
    expect(document.activeElement).toBe(pairsHeading().element)
    expect(byTest('matrix-setup').exists()).toBe(false)
    expect(byTest('matrix-status-waiting').text()).toBe('1')
  })

  it('offers text channels only: a voice channel the loader returns is not in the form', async () => {
    await open({ pairs: [], channels: [...CHANNELS, { id: 'c-lounge', name: 'lounge', categoryName: null, voice: true }] })
    const form = byTest('matrix-setup')
    expect(form.find('[data-channel="c-lounge"]').exists()).toBe(false)
    expect(form.findAll('input[type="checkbox"]')).toHaveLength(3)
  })

  it('keeps the form and says why when the server refuses', async () => {
    await open({ pairs: [] })
    await byTest('matrix-setup').findAll('input[type="checkbox"]')[0].setValue(true)
    api.configureMatrixBridge.mockRejectedValueOnce({ code: '22023', message: 'Channels must be text channels of the server in the install allowlist' })
    await byTest('matrix-setup').trigger('submit'); await flushPromises()
    expect(byTest('matrix-setup-error').attributes('role')).toBe('alert')
    expect(byTest('matrix-setup-error').text()).toBe("A chosen channel isn't in the bot's channel list anymore. Reload and choose again.")
    expect(byTest('matrix-setup-save').attributes('disabled')).toBeUndefined()
    expect(api.fetchServerMatrixBridges).toHaveBeenCalledTimes(1)
  })

  it('gives a manager without a bot the steps and the guide', async () => {
    await open({ pairs: [], installs: [] })
    expect(byTest('matrix-setup').exists()).toBe(false)
    const steps = byTest('matrix-guide-steps').findAll('li').map(li => li.text())
    expect(steps).toHaveLength(4)
    expect(steps[0]).toContain('Matrix bridge service')
    expect(steps[1]).toContain('User settings → My bots')
    expect(steps[2]).toContain('Server settings → Advanced settings → Server bots')
    const link = byTest('matrix-guide-link')
    expect(link.attributes()).toMatchObject({ href: 'https://docs.mony.lol/run/matrix-bridge', target: '_blank', rel: 'noopener noreferrer' })
    expect(link.text()).toContain('Read the Matrix bridge guide')
    expect(byTest('matrix-guide-blocked').exists()).toBe(false)
  })

  it('says why the caller\'s own bot cannot bridge yet', async () => {
    await open({ pairs: [], installs: [{ ...myBot, allowed_channel_ids: null }, { ...myBot, bot_id: 'off', bot_display_name: 'Sleepy', bot_active: false }] })
    expect(byTest('matrix-setup').exists()).toBe(false)
    const blocked = byTest('matrix-guide-blocked')
    expect(blocked.text()).toContain("Your bots in this server can't bridge yet:")
    expect(blocked.findAll('li').map(li => li.attributes('data-block'))).toEqual(['all_channels', 'bot_inactive'])
    expect(blocked.text()).toContain('Matrix Bridge: it may use every channel')
    expect(byTest('matrix-guide-steps').exists()).toBe(true)
  })

  it('keeps the pairs when the caller\'s bots cannot be read', async () => {
    given()
    api.fetchOwnedBotInstalls.mockRejectedValue(new Error('private detail'))
    wrapper = mountSettings(); await flushPromises()
    expect(byTest('matrix-setup-load-error').text()).toContain('Could not load your bots')
    expect(wrapper.text()).not.toContain('private detail')
    expect(byTest('matrix-pair').exists()).toBe(true)
    expect(byTest('matrix-edit').exists()).toBe(false)
  })
})

describe('editing paired channels', () => {
  it('opens on the bot\'s current channels, moves focus, and cancels back to the button', async () => {
    await open()
    expect(byTest('matrix-setup').exists()).toBe(false)
    await byTest('matrix-edit').trigger('click'); await flushPromises()
    const form = byTest('matrix-setup')
    expect(form.find('h4').text()).toBe('Change paired channels')
    expect(document.activeElement).toBe(form.find('h4').element)
    expect(form.findAll('input[type="checkbox"]').map(box => (box.element as HTMLInputElement).checked)).toEqual([true, false, false])
    expect(byTest('matrix-setup-save').text()).toBe('Save channels')

    await form.findAll('input[type="checkbox"]')[0].setValue(false)
    await form.trigger('submit')
    expect(byTest('matrix-setup-error').text()).toBe('Choose at least one channel. To stop bridging all of them, use Unpair below.')

    await byTest('matrix-setup-cancel').trigger('click'); await flushPromises()
    expect(byTest('matrix-setup').exists()).toBe(false)
    expect(document.activeElement).toBe(byTest('matrix-edit').element)
  })

  it('saves the whole new set in sidebar order', async () => {
    await open()
    await byTest('matrix-edit').trigger('click'); await flushPromises()
    await byTest('matrix-setup').findAll('input[type="checkbox"]')[1].setValue(true)
    api.configureMatrixBridge.mockResolvedValueOnce(true)
    api.fetchServerMatrixBridges.mockResolvedValue([pair, { ...pair, channel_id: 'c-news', channel_name: 'news', room_id: null }])
    await byTest('matrix-setup').trigger('submit'); await flushPromises()
    expect(api.configureMatrixBridge).toHaveBeenCalledWith('bot', 'server', ['c-general', 'c-news'])
    expect(wrapper.findAll('[data-testid="matrix-pair"]')).toHaveLength(2)
    expect(byTest('matrix-bridge-notice').text()).toBe('2 channels are paired with Matrix.')
  })

  it('tells a manager who does not own the bot who can change it', async () => {
    await open({ installs: [] })
    expect(byTest('matrix-edit').exists()).toBe(false)
    expect(byTest('matrix-not-owner').text()).toBe('Only the owner of Matrix Bridge can change which channels it bridges. You can still choose how members appear, or unpair it.')
    expect(byTest('matrix-guide-steps').exists()).toBe(false)
    expect(byTest('matrix-guide-link').exists()).toBe(true)
  })
})

describe('unpairing', () => {
  it('asks first, unpairs the bot from the server, and says so', async () => {
    await open({ pairs: [pair, { ...pair, channel_id: 'c-news', channel_name: 'news' }] })
    const button = byTest('matrix-unpair')
    expect(button.attributes('aria-label')).toBe('Unpair Matrix Bridge from Matrix')
    expect(byTest('matrix-unpair-card').text()).toContain('Matrix Bridge: 2 channels')

    api.confirm.mockResolvedValueOnce(false)
    await button.trigger('click'); await flushPromises()
    expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Unpair Matrix Bridge?',
      message: expect.stringContaining('Matrix Bridge stops bridging 2 channels with Matrix.'),
      confirmButtonText: 'Unpair',
      dangerAction: true,
    }))
    expect(api.unconfigureMatrixBridge).not.toHaveBeenCalled()

    api.confirm.mockResolvedValueOnce(true)
    api.unconfigureMatrixBridge.mockResolvedValueOnce(true)
    api.fetchServerMatrixBridges.mockResolvedValue([])
    await button.trigger('click'); await flushPromises()
    expect(api.unconfigureMatrixBridge).toHaveBeenCalledWith('bot', 'server')
    expect(byTest('matrix-pair').exists()).toBe(false)
    expect(byTest('matrix-unpair-card').exists()).toBe(false)
    expect(byTest('matrix-bridge-notice').text()).toBe('Matrix Bridge is unpaired from Matrix.')
    expect(byTest('matrix-status-title').text()).toBe('Not set up')
    expect(document.activeElement).toBe(pairsHeading().element)
  })

  it('reports a failed unpair without server text', async () => {
    await open()
    api.confirm.mockResolvedValueOnce(true)
    api.unconfigureMatrixBridge.mockRejectedValueOnce(new Error('secret'))
    await byTest('matrix-unpair').trigger('click'); await flushPromises()
    expect(byTest('matrix-unpair-error').text()).toBe('Could not unpair the bot. Reload and try again.')
    expect(wrapper.text()).not.toContain('secret')
    expect(byTest('matrix-pair').exists()).toBe(true)
  })
})

describe('sender mode', () => {
  it('labels the choice in plain words and keeps the technical detail in the explanation', async () => {
    await open()
    const select = byTest('matrix-pair-mode')
    expect(wrapper.get(`label[for="${select.attributes('id')}"]`).text()).toBe('Harmony members appear in Matrix')
    expect(select.findAll('option').map(option => option.text())).toEqual(['As their own Matrix users (recommended)', 'Through one shared bridge account'])
    const hint = wrapper.get(`#${select.attributes('aria-describedby')}`)
    expect(hint.text()).toBe("Every message comes from the bridge's account, with the member's name in front.")
    expect(byTest('matrix-pair').text()).not.toContain('namespace')
    expect(byTest('matrix-modes').find('summary').text()).toBe('How the two choices work')
    expect(byTest('matrix-modes').text()).toContain('user namespace')
    expect(byTest('matrix-modes').text()).toContain('invite people into the room')
  })

  it('targets bot+channel, waits for canonical state, and leaves a second pair unchanged', async () => {
    await open({ pairs: [pair, { ...pair, bot_id: 'second-bot' }] })
    const pending = deferred()
    api.setMatrixBridgeSenderMode.mockReturnValueOnce(pending.promise)
    await wrapper.findAll('[data-testid="matrix-pair-mode"]')[0].setValue('ghost')
    expect(api.setMatrixBridgeSenderMode).toHaveBeenLastCalledWith('bot', 'c-general', 'ghost')
    expect(wrapper.findAll('[data-testid="matrix-pair-mode"]')[1].attributes('disabled')).toBeDefined()
    expect((wrapper.findAll('[data-testid="matrix-pair-mode"]')[0].element as HTMLSelectElement).value).toBe('relay')
    pending.resolve({ ...pair, sender_mode: 'ghost' }); await flushPromises()
    expect(wrapper.findAll('[data-testid="matrix-pair-mode"]').map(select => (select.element as HTMLSelectElement).value)).toEqual(['ghost', 'relay'])
  })

  it('allows a choice while a room is pending and none for a pair that is not bridged', async () => {
    await open({ pairs: [{ ...pair, room_id: null }, { ...pair, channel_id: 'c-news', channel_name: 'news', active: false }] })
    const [waiting, stopped] = wrapper.findAll('[data-testid="matrix-pair"]')
    expect(waiting.find('[data-testid="matrix-pair-fix"]').text()).toContain('ask whoever runs the bridge to add it')
    expect(waiting.find('select').attributes('disabled')).toBeUndefined()
    expect(stopped.find('[data-testid="matrix-pair-badge"]').text()).toBe('Not being bridged')
    expect(stopped.find('[data-testid="matrix-pair-fix"]').text()).toContain("Matrix Bridge can't bridge #news anymore")
    expect(stopped.find('select').attributes('disabled')).toBeDefined()
  })

  it('locks uncertain saves until reload and never prints server exception text', async () => {
    await open()
    api.setMatrixBridgeSenderMode.mockRejectedValueOnce(new Error('secret credentials'))
    await byTest('matrix-pair-mode').setValue('ghost'); await flushPromises()
    expect(byTest('matrix-bridge-error').text()).toContain('Could not confirm the change')
    expect(wrapper.text()).not.toContain('secret credentials')
    expect(byTest('matrix-pair-mode').attributes('disabled')).toBeDefined()
    expect((byTest('matrix-pair-mode').element as HTMLSelectElement).value).toBe('relay')
    api.fetchServerMatrixBridges.mockResolvedValue([{ ...pair, sender_mode: 'ghost' }])
    await reload(); await flushPromises()
    expect((byTest('matrix-pair-mode').element as HTMLSelectElement).value).toBe('ghost')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })
})

describe('loading', () => {
  it('shows a load failure with a way to retry', async () => {
    given()
    api.fetchServerMatrixBridges.mockRejectedValueOnce(new Error('private'))
    wrapper = mountSettings(); await flushPromises()
    expect(byTest('matrix-bridge-error').attributes('role')).toBe('alert')
    expect(byTest('matrix-bridge-error').text()).toContain('Could not load')
    expect(byTest('matrix-status').exists()).toBe(false)
    await reload(); await flushPromises()
    expect(byTest('matrix-pair').exists()).toBe(true)
  })

  it('ignores late load responses after a server switch', async () => {
    given()
    const pending = deferred()
    api.fetchServerMatrixBridges.mockReturnValueOnce(pending.promise)
    wrapper = mountSettings()
    api.fetchServerMatrixBridges.mockResolvedValueOnce([{ ...pair, room_id: '!new:hs' }])
    await wrapper.setProps({ serverId: 'new-server' }); await flushPromises()
    pending.resolve([pair]); await flushPromises()
    expect(wrapper.text()).toContain('!new:hs')
    expect(wrapper.text()).not.toContain('!room:hs')
    expect(api.fetchOwnedBotInstalls).toHaveBeenLastCalledWith('new-server', 'member')
  })

  it('discards a pending save and error after an account switch', async () => {
    await open()
    const pending = deferred()
    api.setMatrixBridgeSenderMode.mockReturnValueOnce(pending.promise)
    await byTest('matrix-pair-mode').setValue('ghost')
    api.fetchServerMatrixBridges.mockResolvedValue([])
    useProfileStore().profileId = 'new-member'; await flushPromises()
    pending.resolve(Promise.reject(new Error('private'))); await flushPromises()
    expect(byTest('matrix-pair-mode').exists()).toBe(false)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(byTest('matrix-bridge-empty').exists()).toBe(true)
    expect(api.fetchOwnedBotInstalls).toHaveBeenLastCalledWith('server', 'new-member')
  })

  it('sits under the Bridges heading and offers the Matrix privacy panel while a pair exists', async () => {
    await open()
    expect(wrapper.get('[data-testid="matrix-bridge"] h3').text()).toBe('Matrix bridge')
    expect(wrapper.find('h2').exists()).toBe(false)
    expect(wrapper.getComponent(PrivacyPanel).props()).toEqual({ serverId: 'server', platform: 'matrix' })
    api.fetchServerMatrixBridges.mockResolvedValue([])
    await reload(); await flushPromises()
    expect(wrapper.findComponent(PrivacyPanel).exists()).toBe(false)
  })
})
