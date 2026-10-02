/**
 * ServerBotsSettings.vue channel access: loads get_bot_channel_access, marks channels hidden
 * from @everyone, and saves through set_bot_allowed_channels, NULL for every visible channel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { supabase } from '@/supabase'
import ServerBotsSettings from '../ServerBotsSettings.vue'

const { toast } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('vue-router', () => ({ useRoute: () => ({ hash: '' }) }))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn() }) }))

const SERVER_ID = 's1'
const BOT_ID = 'bot-1'
const GENERAL = 'c-general'
const STAFF = 'c-staff'

const INSTALLATION = {
  id: 'inst-1',
  bot_id: BOT_ID,
  installed_at: '2026-10-01T00:00:00Z',
  read_messages: true,
  send_messages: true,
  bot: { id: BOT_ID, username: 'bridge', display_name: 'Bridge', bio: null, avatar_url: null, bot_type: 'bridge', is_public: true },
}

const CHANNELS = [
  { id: GENERAL, name: 'general', type: 0, category_id: null, everyone_can_view: true },
  { id: STAFF, name: 'staff', type: 0, category_id: null, everyone_can_view: false },
]

/** Every builder method chains; awaiting resolves the table's rows. */
function tableResult(table: string) {
  const data = table === 'bot_server_permissions' ? [INSTALLATION] : []
  const result = { data, error: null }
  const builder: any = new Proxy(
    { then: (resolve: (r: unknown) => unknown) => resolve(result) },
    { get: (target, prop) => (prop in target ? (target as any)[prop] : () => builder) },
  )
  return builder
}

let access: { allowed_channel_ids: string[] | null; channels: typeof CHANNELS }

function mountSettings() {
  return mount(ServerBotsSettings, {
    props: { serverId: SERVER_ID },
    global: {
      stubs: {
        Icon: true,
        LoadingSpinner: true,
        BotAvatar: true,
        EmptyState: true,
        BaseModal: {
          props: ['show'],
          template: '<div v-if="show" class="modal-stub"><slot /><slot name="footer" /></div>',
        },
      },
    },
  })
}

async function openChannels() {
  const w = mountSettings()
  await flushPromises()
  const button = w.findAll('button').find((b) => b.text() === 'bots.server.channels')
  expect(button).toBeDefined()
  await button!.trigger('click')
  await flushPromises()
  return w
}

function saveButton(w: ReturnType<typeof mountSettings>) {
  return w.get('.modal-stub').findAll('button').find((b) => b.text() === 'bots.server.save')!
}

beforeEach(() => {
  setActivePinia(createPinia())
  toast.success.mockReset()
  toast.error.mockReset()
  access = { allowed_channel_ids: null, channels: CHANNELS }
  vi.mocked(supabase.from).mockReset().mockImplementation(((table: string) => tableResult(table)) as any)
  vi.mocked(supabase.rpc).mockReset().mockImplementation((async (fn: string) => {
    if (fn === 'get_bot_channel_access') return { data: access, error: null }
    if (fn === 'set_bot_allowed_channels') return { data: null, error: null }
    throw new Error(`unexpected rpc ${fn}`)
  }) as any)
})

describe('ServerBotsSettings channel access', () => {
  it('loads the installation\'s access and marks channels hidden from @everyone', async () => {
    access = { allowed_channel_ids: [GENERAL], channels: CHANNELS }
    const w = await openChannels()

    expect(supabase.rpc).toHaveBeenCalledWith('get_bot_channel_access', { p_server_id: SERVER_ID, p_bot_id: BOT_ID })
    const rows = w.findAll('.channel-row')
    expect(rows.map((r) => r.find('.channel-name').text())).toEqual(['general', 'staff'])
    expect(rows.map((r) => r.find('.hidden-badge').exists())).toEqual([false, true])
    expect(rows.map((r) => (r.find('input').element as HTMLInputElement).checked)).toEqual([true, false])
  })

  it('grants a hidden channel by checking it', async () => {
    access = { allowed_channel_ids: [GENERAL], channels: CHANNELS }
    const w = await openChannels()
    await w.findAll('.channel-row')[1].find('input').setValue(true)
    await saveButton(w).trigger('click')
    await flushPromises()

    expect(supabase.rpc).toHaveBeenCalledWith('set_bot_allowed_channels', {
      p_server_id: SERVER_ID,
      p_bot_id: BOT_ID,
      p_channel_ids: [GENERAL, STAFF],
    })
    expect(toast.success).toHaveBeenCalledWith('bots.server.channelsSaved')
  })

  it('saves NULL for every channel @everyone can view', async () => {
    access = { allowed_channel_ids: [GENERAL, STAFF], channels: CHANNELS }
    const w = await openChannels()
    await w.find('input[type="radio"][value="all"]').setValue(true)
    expect(w.findAll('.channel-row')).toHaveLength(0)
    await saveButton(w).trigger('click')
    await flushPromises()

    expect(supabase.rpc).toHaveBeenCalledWith('set_bot_allowed_channels', {
      p_server_id: SERVER_ID,
      p_bot_id: BOT_ID,
      p_channel_ids: null,
    })
  })

  it('reports a refused save and keeps the dialog open', async () => {
    vi.mocked(supabase.rpc).mockImplementation((async (fn: string) =>
      fn === 'get_bot_channel_access'
        ? { data: access, error: null }
        : { data: null, error: { code: '42501', message: 'Missing permission: MANAGE_SERVER' } }) as any)
    const w = await openChannels()
    await w.find('input[type="radio"][value="selected"]').setValue(true)
    await saveButton(w).trigger('click')
    await flushPromises()

    expect(toast.error).toHaveBeenCalledWith('bots.server.channelsFailed')
    expect(w.find('.modal-stub .channel-picker').exists()).toBe(true)
  })
})
