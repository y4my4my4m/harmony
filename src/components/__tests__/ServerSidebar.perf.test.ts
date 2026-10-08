/**
 * ServerSidebar render cost: 100 servers, 10 expanded folders of 5, 50 root
 * servers. Counts component updates (the `updated` hook) per reactive change.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive, nextTick, defineComponent, h } from 'vue'
import type { Server, ServerFolder } from '@/types'

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => reactive({ name: 'Chat', params: {}, fullPath: '/chat' }),
}))
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('@/composables/useDesktopUpdater', async () => {
  const { reactive, ref } = await import('vue')
  return { useDesktopUpdater: () => ({ state: reactive({ availableVersion: null }), isReady: ref(false), openUpdatePrompt: vi.fn() }) }
})
vi.mock('@/stores/useFunding', () => ({ useFundingStore: () => ({ config: null, goalPillMounted: false, load: vi.fn(async () => {}) }) }))
vi.mock('@/stores/useActivityPub', () => ({ useActivityPubStore: () => ({ mutedUsers: new Set(), blockedUsers: new Set() }) }))
vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentContext: vi.fn().mockResolvedValue({ isAuthenticated: false, profileId: null }),
    getCurrentProfileId: vi.fn().mockResolvedValue(null),
  },
}))
vi.mock('@/services/UserEventChannel', () => ({
  userEventChannel: { connect: vi.fn(), on: vi.fn().mockReturnValue(() => {}), send: vi.fn(), disconnect: vi.fn() },
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: vi.fn(() => ({ session: { user: { id: 'me' } } })) }))
vi.mock('@/router', () => ({ default: { push: vi.fn() } }))
vi.mock('@/utils/faviconBadge', () => ({ updateFaviconBadge: vi.fn() }))

import ServerSidebar from '../ServerSidebar.vue'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useNotificationStore } from '@/stores/useNotification'
import { useUnreadCounts } from '@/composables/useUnreadCounts'
import type { UnreadCount } from '@/types'

const FOLDERS = 10
const PER_FOLDER = 5
const ROOT = 50

function fixture() {
  const folders: ServerFolder[] = []
  const servers: Server[] = []
  let pos = 0
  for (let f = 0; f < FOLDERS; f++) {
    folders.push({ id: `f${f}`, user_id: 'me', name: `F${f}`, color: '#0EA5E9', position: pos++, is_expanded: true })
    for (let i = 0; i < PER_FOLDER; i++) {
      servers.push({ id: `f${f}s${i}`, name: `S${f}.${i}`, icon: null, folder_id: `f${f}`, position: i } as unknown as Server)
    }
  }
  for (let i = 0; i < ROOT; i++) {
    servers.push({ id: `r${i}`, name: `R${i}`, icon: null, folder_id: null, position: pos++ } as unknown as Server)
  }
  return { folders, servers }
}

let updates = 0
const counter = { updated() { updates++ } }

/** Shared unread map; the composable is module-scoped. */
function unreadMap(): Map<string, UnreadCount> {
  let map!: Map<string, UnreadCount>
  const probe = defineComponent({ setup() { map = useUnreadCounts().unreadCounts.value; return () => h('i') } })
  mount(probe).unmount()
  return map
}

function row(serverId: string, channelId: string, messages: number, mentions = 0): UnreadCount {
  return { id: channelId, user_id: 'me', server_id: serverId, channel_id: channelId, unread_messages: messages, unread_mentions: mentions, last_read_at: '' }
}

async function settle() {
  await nextTick()
  await nextTick()
}

describe('ServerSidebar update counts', () => {
  let wrapper: VueWrapper
  let map: Map<string, UnreadCount>

  beforeEach(async () => {
    setActivePinia(createPinia())
    const { folders, servers } = fixture()
    const store = useServerChannelStore()
    store.folders = folders
    store.servers = servers
    map = unreadMap()
    map.clear()
    for (let i = 0; i < 200; i++) map.set(`channel:c${i}`, row(`r${i % ROOT}`, `c${i}`, 0))
    wrapper = mount(ServerSidebar, {
      props: { servers: store.servers },
      global: {
        mixins: [counter],
        mocks: { $t: (key: string) => key },
        directives: { 'click-outside': {} },
        stubs: { InviteModal: true, FundingModal: true, ServerFolderSettingsModal: true, Teleport: true },
      },
    })
    await settle()
    updates = 0
  })

  afterEach(() => {
    wrapper.unmount()
  })

  const report: Record<string, number> = {}
  afterAll(() => {
    console.info('[sidebar-perf] component updates', JSON.stringify(report))
  })

  it('one unread change on a root server', async () => {
    map.set('channel:c0', row('r0', 'c0', 1))
    await settle()
    report.unreadRoot = updates
    expect(updates).toBeLessThanOrEqual(2)
  })

  it('one unread change on a server inside a folder', async () => {
    map.set('channel:x0', row('f3s2', 'x0', 1))
    await settle()
    report.unreadInFolder = updates
    expect(updates).toBeLessThanOrEqual(3)
  })

  it('ten messages into an already unread channel', async () => {
    map.set('channel:c0', row('r0', 'c0', 1))
    await settle()
    updates = 0
    for (let i = 2; i <= 11; i++) {
      map.set('channel:c0', row('r0', 'c0', i))
      await settle()
    }
    report.tenMessagesUnreadChannel = updates
    expect(updates).toBe(0)
  })

  it('a mention notification for one server', async () => {
    const notifications = useNotificationStore()
    notifications.notifications = [
      { id: 'n1', type: 'mention', is_read: false, data: { server_id: 'r5', channel_id: 'c5' } } as any,
      ...notifications.notifications,
    ]
    await settle()
    report.mentionNotification = updates
    expect(updates).toBeLessThanOrEqual(2)
  })

  it('an unrelated notification', async () => {
    const notifications = useNotificationStore()
    notifications.notifications = [
      { id: 'n2', type: 'reaction', is_read: false, data: {} } as any,
      ...notifications.notifications,
    ]
    await settle()
    report.unrelatedNotification = updates
    expect(updates).toBe(0)
  })

  it('200 unread changes spread over every server', async () => {
    const ids = useServerChannelStore().servers.map(x => x.id)
    const t0 = performance.now()
    for (let i = 0; i < 200; i++) {
      map.set(`channel:z${i}`, row(ids[i % ids.length], `z${i}`, 1))
      await settle()
    }
    report.spread200Updates = updates
    report.spread200Ms = Math.round(performance.now() - t0)
    // Each server's pill flips once; later rows on the same server change nothing visible.
    expect(updates).toBeLessThanOrEqual(ids.length + FOLDERS)
  })

  it('switching the selected server', async () => {
    useServerChannelStore().currentServerId = 'r7'
    await settle()
    report.selectServer = updates
    expect(updates).toBeLessThanOrEqual(2)
  })
})
