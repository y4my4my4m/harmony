// The members of the open server.
//
// Three modes, chosen when a server opens:
//   complete  at most COMPLETE_LIST_MAX members: one or two requests bring them all, with
//             profiles, presence and roles; the sidebar groups and sorts them and follows
//             presence broadcasts by itself.
//   windowed  a larger server: the instance orders the list and counts its groups
//             (get_server_member_list); the pages near the viewport are held, the rest are
//             placeholders. A presence, membership or role change re-reads the visible pages,
//             REFRESH_MIN_MS apart at most and no sooner than the instance's order can have
//             changed. A server the instance sends no presence broadcasts for (live false)
//             is re-read every REFRESH_QUIET_MS while on screen.
//   legacy    an instance without the member directory: every member id, read in pages, then
//             profiles in the background (userDataService.subscribeToContext).
// Nothing here reads the members of a server that is not open.
//
// A module singleton over refs, as userDataService is: a component reads it without a store
// being installed.

import { computed, reactive, ref } from 'vue'
import { userDataService } from '@/services/userDataService'
import { getUserIdsForServer } from '@/services/usersService'
import {
  fetchMemberPage,
  memberDirectoryAvailable,
  searchServerMembers,
  type DirectoryMember,
  type MemberListPage,
} from '@/services/memberDirectoryService'
import {
  COMPLETE_LIST_MAX,
  MEMBER_PAGE_ROWS,
  MemberListModel,
  type MemberRun,
  type MemberSlot,
} from '@/services/memberListModel'
import { useServerRolesStore } from '@/stores/useServerRoles'
import { debug } from '@/utils/debug'

export type MemberDirectoryMode = 'idle' | 'legacy' | 'complete' | 'windowed'

/** Least time between two re-reads of the visible pages. */
const REFRESH_MIN_MS = 3000
/** A windowed list on screen is re-read this often with no event at all. */
const REFRESH_IDLE_MS = 60_000
/** The same for a server whose presence changes are not broadcast. */
const REFRESH_QUIET_MS = 20_000
/** How often the idle check runs. */
const IDLE_TICK_MS = 5000
/** Rows read ahead of the viewport on each side. */
const PREFETCH_ROWS = 50
/** A failed read is tried again after RETRY_BASE_MS, doubling to RETRY_MAX_MS. */
const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 30_000

const retryDelay = (failures: number): number => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1))

function createMemberDirectory() {
  const serverId = ref<string | null>(null)
  const mode = ref<MemberDirectoryMode>('idle')
  const loading = ref(false)
  /** Accepted members of the open server; null until the instance has answered. */
  const total = ref<number | null>(null)
  /** Active member search of a windowed list. */
  const query = ref('')
  // The model is plain data; version makes its readers recompute.
  const version = ref(0)
  let model = new MemberListModel()

  // token: the load whose answers still count. openSeq: the latest open() call.
  let token = 0
  let openSeq = 0
  let opening: Promise<void> | null = null
  // Unsubscribes of closed servers, in order: an open waits for them.
  let closing: Promise<void> = Promise.resolve()
  // Member indexes on screen, as runs; the head of the list until a view reports its rows.
  let visible: MemberRun[] = [[0, 0]]
  const inflight = new Set<number>()
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let idleTimer: ReturnType<typeof setInterval> | null = null
  let lastRefresh = 0
  // Of the last answer: whether presence changes are broadcast, and how old its order may be.
  let live = true
  let maxAgeMs = 0
  let failures = 0
  let dirty = false
  let viewers = 0
  let listening = false

  const onScreen = () => viewers > 0 && (typeof document === 'undefined' || document.visibilityState !== 'hidden')

  /** Members the list holds under the active search; the whole list without one. */
  const listed = computed(() => {
    void version.value
    return model.total
  })

  /** The instance has answered for the list as it stands (the active search included). */
  const answered = computed(() => {
    void version.value
    return model.answered
  })

  function slots(collapsed: Record<string, boolean> = {}): MemberSlot[] {
    void version.value
    return model.slots(collapsed)
  }

  function loadedMembers(): DirectoryMember[] {
    void version.value
    return model.loadedMembers()
  }

  function clearTimers(): void {
    if (refreshTimer) clearTimeout(refreshTimer)
    if (retryTimer) clearTimeout(retryTimer)
    refreshTimer = null
    retryTimer = null
  }

  async function cache(id: string, members: DirectoryMember[]): Promise<void> {
    await userDataService.primeMembers(members)
    useServerRolesStore().setMemberRoles(id, members)
  }

  async function adopt(id: string, page: MemberListPage, mine: number): Promise<void> {
    await cache(id, page.members)
    if (mine !== token) return
    total.value = page.total
    failures = 0
    if (page.total <= page.members.length) {
      mode.value = 'complete'
      model = new MemberListModel()
      version.value++
      stopIdleTimer()
      await userDataService.subscribeToContext(id, 'server', page.members.map(m => m.id), { preloaded: true })
      return
    }
    mode.value = 'windowed'
    model = new MemberListModel()
    model.apply(page)
    live = page.live
    maxAgeMs = page.maxAgeMs
    lastRefresh = Date.now()
    version.value++
    startIdleTimer()
    await userDataService.subscribeToContext(id, 'server', model.loadedIds(), { preloaded: true, partial: true })
  }

  // The head of the list: one page, and the rest of a server small enough to hold whole.
  async function readHead(id: string): Promise<MemberListPage | null> {
    const page = await fetchMemberPage(id, 0, MEMBER_PAGE_ROWS)
    if (!page || page.total <= page.members.length || page.total > COMPLETE_LIST_MAX) return page
    const rest = await fetchMemberPage(id, page.members.length, COMPLETE_LIST_MAX - page.members.length)
    if (!rest) return null
    const seen = new Set(page.members.map(m => m.id))
    return { ...rest, offset: 0, members: [...page.members, ...rest.members.filter(m => !seen.has(m.id))] }
  }

  async function openLegacy(id: string, mine: number): Promise<void> {
    mode.value = 'legacy'
    const ids = await getUserIdsForServer(id)
    if (mine !== token) return
    total.value = ids.length
    await userDataService.subscribeToContext(id, 'server', ids)
  }

  // The table reads are for an instance without the functions: no capability listed, or
  // PGRST202 (fetchMemberPage answers null). Any other failure of the directory is thrown,
  // and the open is tried again: a timeout must not turn into a read of every member.
  async function load(id: string, mine: number): Promise<void> {
    // Imported here: instanceCapabilities reads the stored instance when it loads.
    const { hasCapability } = await import('@/services/instanceCapabilities')
    if (mine !== token) return
    if (hasCapability('member-directory') && memberDirectoryAvailable()) {
      let page: MemberListPage | null
      try {
        page = await readHead(id)
      } catch (error) {
        // Not a member of the server: a list of nobody, as the table reads would answer.
        if ((error as { code?: string } | null)?.code !== '42501') throw error
        page = { total: 0, offset: 0, groups: [], members: [], live: true, maxAgeMs: 0 }
      }
      if (mine !== token) return
      if (page) {
        await adopt(id, page, mine)
        return
      }
    }
    await openLegacy(id, mine)
  }

  /** Opens a server's member list; the server open before it is closed. Idempotent per server. */
  async function open(id: string): Promise<void> {
    if (!id) return
    if (serverId.value === id && mode.value !== 'idle') return
    if (serverId.value === id && opening) return opening
    const seq = ++openSeq
    if (serverId.value && serverId.value !== id) void close()
    await closing
    // A later open took over while the server before this one was closing.
    if (seq !== openSeq) return
    listen()
    clearTimers()
    const mine = ++token
    serverId.value = id
    loading.value = true
    total.value = null
    query.value = ''
    visible = [[0, 0]]
    model = new MemberListModel()
    version.value++
    const work = load(id, mine)
      .catch((error) => {
        if (mine !== token) return
        debug.error('Member list failed to open:', error)
        // Left idle and tried again: a transient failure must not leave the list empty.
        mode.value = 'idle'
        failures++
        retryTimer = setTimeout(() => {
          retryTimer = null
          if (serverId.value === id && mode.value === 'idle') void open(id)
        }, retryDelay(failures))
      })
      .finally(() => {
        if (mine !== token) return
        loading.value = false
        opening = null
      })
    opening = work
    return work
  }

  function close(): Promise<void> {
    const id = serverId.value
    token++
    opening = null
    stopIdleTimer()
    clearTimers()
    inflight.clear()
    dirty = false
    lastRefresh = 0
    live = true
    maxAgeMs = 0
    failures = 0
    serverId.value = null
    mode.value = 'idle'
    loading.value = false
    total.value = null
    query.value = ''
    model = new MemberListModel()
    version.value++
    if (id) {
      closing = closing
        .then(() => userDataService.unsubscribeFromContext(id))
        .catch((error) => debug.warn('Member list close failed:', error))
    }
    return closing
  }

  // Reads the list again from its head: a server that crossed COMPLETE_LIST_MAX changes mode.
  async function reopen(): Promise<void> {
    const id = serverId.value
    if (!id || mode.value === 'legacy' || mode.value === 'idle') return
    const mine = ++token
    inflight.clear()
    try {
      const page = await readHead(id)
      if (mine !== token || !page) return
      query.value = ''
      await adopt(id, page, mine)
    } catch (error) {
      debug.warn('Member directory re-read failed:', error)
    }
  }

  const padded = (): MemberRun[] => visible.map(([from, to]) => [from - PREFETCH_ROWS, to + PREFETCH_ROWS])

  async function loadPage(offset: number): Promise<void> {
    const id = serverId.value
    if (!id || mode.value !== 'windowed' || inflight.has(offset)) return
    const mine = token
    const asked = query.value
    inflight.add(offset)
    let failed = false
    try {
      const page = await fetchMemberPage(id, offset, MEMBER_PAGE_ROWS, asked || null)
      if (mine !== token || asked !== query.value || !page) return
      if (!asked && page.total <= COMPLETE_LIST_MAX) {
        void reopen()
        return
      }
      await cache(id, page.members)
      if (mine !== token || asked !== query.value) return
      model.apply(page)
      model.trim(padded())
      if (!asked) {
        total.value = page.total
        live = page.live
        maxAgeMs = page.maxAgeMs
      }
      failures = 0
      userDataService.setContextMembers(id, model.loadedIds())
      version.value++
    } catch (error) {
      failed = true
      debug.warn(`Member page ${offset} failed:`, error)
    } finally {
      inflight.delete(offset)
    }
    if (mine !== token || asked !== query.value) return
    if (failed) {
      // Asked again after a pause, not at once: offline, a retry per failure is a request loop.
      failures++
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null
          requestVisible(true)
        }, retryDelay(failures))
      }
      return
    }
    requestVisible(false)
  }

  // Reads the pages in view that are absent, and the stale ones when `includeStale`. Stale
  // pages left in view are read by the next scheduled refresh: an answer whose counts differ
  // from the ones held marks the other pages stale, and reading those at once would chase a
  // list that changes faster than a round trip.
  function requestVisible(includeStale: boolean): void {
    if (mode.value !== 'windowed' || retryTimer) return
    for (const offset of model.wanted(padded(), includeStale)) void loadPage(offset)
    // A stale page already being read is not a reason to read again.
    if (!includeStale && model.stale(visible).some(offset => !inflight.has(offset))) scheduleRefresh()
  }

  /** The member indexes on screen, as runs in list order; their pages load. */
  function showRanges(runs: MemberRun[]): void {
    const kept = runs
      .map(([from, to]): MemberRun => [Math.max(0, from), Math.max(from, to)])
      .filter(([from, to]) => to >= from)
    visible = kept.length > 0 ? kept : [[0, 0]]
    requestVisible(false)
  }

  function refresh(): void {
    if (mode.value !== 'windowed') return
    lastRefresh = Date.now()
    dirty = false
    model.markAllStale()
    requestVisible(true)
  }

  /**
   * A change somewhere in the list: the visible pages are read again, REFRESH_MIN_MS after
   * the last read at the earliest, and maxAgeMs from now at the earliest: an order the
   * instance holds may predate the change for that long.
   */
  function scheduleRefresh(): void {
    if (mode.value !== 'windowed' || refreshTimer) return
    const wait = Math.max(0, REFRESH_MIN_MS - (Date.now() - lastRefresh), maxAgeMs)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      if (onScreen()) refresh()
      else dirty = true
    }, wait)
  }

  /** Filters a windowed list on the instance; an empty query restores the whole list. */
  function search(text: string): void {
    if (mode.value !== 'windowed') return
    const next = text.trim()
    if (next === query.value) return
    query.value = next
    inflight.clear()
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    model = new MemberListModel()
    version.value++
    visible = [[0, 0]]
    requestVisible(false)
  }

  /**
   * Members of a server matching `text`, cached with their roles. Null on an instance
   * without the member directory.
   */
  async function searchMembers(id: string, text: string, limit = 20): Promise<DirectoryMember[] | null> {
    const found = await searchServerMembers(id, text, limit)
    if (found && found.length > 0) await cache(id, found)
    return found
  }

  /** A view showing the list mounts and unmounts; an unseen list is not re-read. */
  function attach(): void {
    viewers++
    if (dirty && onScreen()) refresh()
  }

  function detach(): void {
    viewers = Math.max(0, viewers - 1)
  }

  function startIdleTimer(): void {
    if (idleTimer) return
    idleTimer = setInterval(() => {
      const due = live ? REFRESH_IDLE_MS : Math.max(REFRESH_QUIET_MS, maxAgeMs)
      if (mode.value === 'windowed' && onScreen() && Date.now() - lastRefresh >= due) refresh()
    }, IDLE_TICK_MS)
  }

  function stopIdleTimer(): void {
    if (idleTimer) clearInterval(idleTimer)
    idleTimer = null
  }

  function listen(): void {
    if (listening) return
    listening = true
    userDataService.addEventListener('presence-event', (event) => {
      // This client's own status change: the instance places the caller by the status it
      // chose, whatever the age of the order it holds, so the list is read now.
      if ((event as CustomEvent).detail?.self && mode.value === 'windowed' && onScreen()) refresh()
      else scheduleRefresh()
    })
    userDataService.addEventListener('context-updated', (event) => {
      const detail = (event as CustomEvent).detail
      const id = serverId.value
      if (!id || detail?.contextId !== id) return
      if (detail.type !== 'member-join' && detail.type !== 'member-leave') return
      if (mode.value === 'windowed') {
        scheduleRefresh()
        return
      }
      // The context holds every member in these modes.
      const count = userDataService.getContextMemberCount(id)
      total.value = count
      if (mode.value === 'complete' && count > COMPLETE_LIST_MAX) void reopen()
    })
    if (typeof window !== 'undefined') {
      const onRoleChange = (event: Event) => {
        const detail = (event as CustomEvent).detail
        const id = detail?.new?.server_id ?? detail?.old?.server_id
        if (id && id === serverId.value) scheduleRefresh()
      }
      window.addEventListener('server-structure:role-change', onRoleChange)
      window.addEventListener('server-structure:user-role-change', onRoleChange)
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (dirty && onScreen()) refresh()
      })
    }
  }

  // reactive() unwraps the refs: readers write memberDirectory.mode, not .value.
  return reactive({
    serverId,
    mode,
    loading,
    total,
    query,
    listed,
    answered,
    version,
    open,
    close,
    slots,
    loadedMembers,
    showRanges,
    refresh,
    scheduleRefresh,
    search,
    searchMembers,
    attach,
    detach,
  })
}

/** One directory per client: the member sidebar shows one server at a time. */
export const memberDirectory = createMemberDirectory()
