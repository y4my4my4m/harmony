import { defineStore } from 'pinia'
import { supabase } from '@/supabase'
import router from '@/router'
import { useAuthStore } from './auth'
import { viewContextTracker } from '@/services/ViewContextTracker'
import { NotificationFormatter } from '@/services/NotificationFormatter'
import { nativeNotify } from '@/services/nativeNotify'
import { isTauriRuntime } from '@/services/instanceConfig'
import { getEmojiUrl } from '@/utils/emojiUtils'
import { discordEmojiCdnUrl, parseDiscordEmojiToken } from '@/utils/discordEmoji'
import { services } from '@/services'
import { authContextService } from '@/services/AuthContextService'
import { userDataService } from '@/services/userDataService'
import { userEventChannel } from '@/services/UserEventChannel'
import { debug } from '@/utils/debug'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { updateFaviconBadge } from '@/utils/faviconBadge'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { resolveNotificationRoute } from '@/utils/notificationRoute'
import { isMobileUserAgent } from '@/utils/pwaUtils'
import { i18n } from '@/i18n'
import { UserStatus } from '@/types'
import type { 
  Notification, 
  NotificationType,
  NotificationPreferences,
  NotificationToast,
  AudioAction
} from '@/types'

/**
 * Return shape of the `notificationCounts` getter. Exported rather than
 * inline: vue-tsc/Pinia inference for cross-getter `this` access fails on
 * anonymous return types.
 */
export interface NotificationCounts {
  total: number
  unread: number
  unreadMentions: number
  unreadDMs: number
  mentionsAll: number
  dms: number
  reactions: number
  social: number
  follows: number
  unreadChannelMentions: Map<string, number>
  unreadServerMentions: Map<string, number>
  unreadConversationMentions: Map<string, number>
}

interface NotificationState {
  notifications: Notification[]
  // Server rows fetched, pre-filter. Paging offset; notifications.length
  // shifts under realtime prepends and hidden-user filtering.
  loadedCount: number
  unreadCount: number
  isLoading: boolean
  lastFetchedAt: Date | null
  preferences: NotificationPreferences | null
  isDndActive: boolean
  toasts: NotificationToast[]
  lastNotificationTime: Map<string, number>
  isInitialized: boolean
  fullListLoaded: boolean
  /** The last page of the full list was complete; more rows may exist. */
  hasMore: boolean
  loadError: string | null
  hasPermission: boolean
  currentFilter: string
  cachedProfileId: string | null
  cachedAuthUserId: string | null
}

const NOTIFICATION_SOUND_MAPPING: Record<NotificationType, AudioAction> = {
  mention: 'mention',
  dm: 'dm', 
  chat_message: 'dm',
  channel_message: 'dm',
  reaction: 'reaction',
  reply: 'reply',
  thread_reply: 'reply',
  voice_channel_activity: 'voice_channel_activity',
  server_invite: 'server_invite',
  friend_request: 'friend_request',
  server_update: 'server_update',
  emoji_added: 'emoji_added',
  activitypub_follow: 'friend_request',
  activitypub_favorite: 'reaction',
  activitypub_reblog: 'reaction',
  activitypub_reaction: 'reaction',
  activitypub_mention: 'mention',
  activitypub_reply: 'reply',
  activitypub_follow_request: 'friend_request',
  activitypub_follow_accepted: 'friend_request',
  move: 'friend_request',
  report_update: 'server_update',
  moderation_warning: 'server_update',
  newcomer_message: 'server_update',
  security: 'server_update',
  error: 'server_update',
  ui_success: 'ui_success',
  ui_error: 'ui_error',
}

const DEFAULT_PREFERENCES: Omit<NotificationPreferences, 'id' | 'user_id' | 'created_at' | 'updated_at'> = {
  desktop_notifications: true,
  desktop_mentions: true,
  desktop_dms: true,
  desktop_reactions: true,
  desktop_replies: true,
  desktop_chat_messages: true,
  sound_notifications: true,
  sound_mentions: true,
  sound_dms: true,
  sound_reactions: true,
  sound_replies: true,
  sound_chat_messages: true,
  sound_voice_activity: true,
  push_notifications: true,
  push_mentions: true,
  push_dms: true,
  push_offline_only: true,
  newcomer_alerts: true,
  email_notifications: false,
  email_digest: false,
  email_digest_frequency: 'weekly' as const,
  dnd_enabled: false,
  dnd_start_time: '22:00:00',
  dnd_end_time: '08:00:00',
  
  activitypub_notifications: true,
  activitypub_follows: true,
  activitypub_favorites: true,
  activitypub_reblogs: true,
  activitypub_mentions: true,
  activitypub_replies: true,
  activitypub_follow_requests: true,
  
  activitypub_desktop_notifications: true,
  activitypub_desktop_follows: true,
  activitypub_desktop_favorites: false,
  activitypub_desktop_reblogs: false,
  activitypub_desktop_mentions: true,
  activitypub_desktop_replies: true,
  
  activitypub_sound_notifications: true,
  activitypub_sound_follows: true,
  activitypub_sound_favorites: false,
  activitypub_sound_reblogs: false,
  activitypub_sound_mentions: true,
  activitypub_sound_replies: true
}

// Unsubscribe functions for UserEventChannel handlers (module-level to avoid
// polluting Pinia serializable state).
let _unsubNewNotification: (() => void) | null = null
let _unsubUpdateNotification: (() => void) | null = null
let _unsubBulkRead: (() => void) | null = null
let _unsubPrefsUpdated: (() => void) | null = null
let _unsubReconnected: (() => void) | null = null
let _unsubDeleted: (() => void) | null = null
let _onVisibility: (() => void) | null = null
let _lastUnreadRefresh = 0
let _dndInterval: ReturnType<typeof setInterval> | null = null
const _recentlyProcessedIds = new Set<string>()
const DEDUP_TTL_MS = 10_000
// 12 pages at the bell's 25-row page size.
const MAX_NOTIFICATIONS = 300
const PAGE_SIZE = 25
const UNREAD_FETCH_LIMIT = 200
const UNREAD_REFRESH_MIN_MS = 30_000

// Read-state changes applied here while a fetch is in flight, by id, stamped with
// _readClock. A fetch snapshot older than a row's stamp does not overwrite that
// row's is_read. Stamps are dropped once no fetch is in flight.
let _readClock = 0
let _fetchesInFlight = 0
const _readStamps = new Map<string, number>()

function stampRead(id: string): void {
  if (_fetchesInFlight > 0) _readStamps.set(id, ++_readClock)
}

function beginFetch(): number {
  _fetchesInFlight++
  return _readClock
}

function endFetch(): void {
  _fetchesInFlight = Math.max(0, _fetchesInFlight - 1)
  if (_fetchesInFlight === 0) _readStamps.clear()
}

function readChangedSince(since: number): (id: string) => boolean {
  return (id) => (_readStamps.get(id) ?? 0) > since
}

function setRead(n: Notification, isRead: boolean): void {
  n.is_read = isRead
  stampRead(n.id)
}

const DM_TYPES = new Set(['dm', 'chat_message'])

type DismissCriteria = {
  notificationIds?: string[]
  conversationId?: string
  channelId?: string
  all?: boolean
  keepIds?: string[]
}

// Web: the service worker's notifications. Android app: the push plugin's. Desktop Tauri
// notifications are not tracked.
async function dismissSystemNotifications(criteria: DismissCriteria): Promise<void> {
  if (isTauriRuntime()) {
    const { isAndroidApp, cancelNativeNotifications } = await import('@/services/androidPush')
    if (isAndroidApp()) await cancelNativeNotifications(criteria)
    return
  }
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  try {
    const { serviceWorkerManager } = await import('@/services/ServiceWorkerManager')
    await serviceWorkerManager.dismissNotifications(criteria)
  } catch (error) {
    debug.warn('Failed to dismiss system notifications:', error)
  }
}

/** The signed-in user's status is Busy (Do Not Disturb). */
function isStatusBusy(): boolean {
  try {
    return userDataService.getCurrentUser()?.status === UserStatus.Busy
  } catch {
    return false
  }
}

/**
 * Merges a fetched page into the loaded list by id. Loaded unread rows outside the
 * page are kept: unreadCount derives from this list and must not drop because a
 * page of mostly read rows replaced it. A row whose read state changed here after
 * the page was requested (`keepLocalRead`) keeps its loaded is_read.
 */
export function mergeNotificationPage(
  existing: Notification[],
  page: Notification[],
  replace: boolean,
  keepLocalRead: (id: string) => boolean = () => false,
): Notification[] {
  const loaded = new Map<string, Notification>()
  for (const n of existing) loaded.set(n.id, n)
  const byId = new Map<string, Notification>()
  for (const n of page) {
    const local = loaded.get(n.id)
    byId.set(n.id, local && local.is_read !== n.is_read && keepLocalRead(n.id) ? { ...n, is_read: local.is_read } : n)
  }
  for (const n of existing) {
    if (byId.has(n.id)) continue
    if (!replace || !n.is_read) byId.set(n.id, n)
  }
  return [...byId.values()].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )
}

// Actor id embedded in a notification payload (shape varies by type).
const notificationActorId = (n: Notification): string | undefined => {
  const d: any = n.data
  return d?.from_user_id ?? d?.sender?.user_id ?? d?.reactor?.user_id ?? d?.reactor?.id ?? d?.inviter?.user_id
}

// Muted/blocked users must not generate visible notifications.
const isFromHiddenUser = (n: Notification): boolean => {
  const id = notificationActorId(n)
  if (!id) return false
  try {
    const ap = useActivityPubStore()
    return ap.mutedUsers.has(id) || ap.blockedUsers.has(id)
  } catch {
    return false
  }
}

export const useNotificationStore = defineStore('notification', {
  state: (): NotificationState => ({
    notifications: [],
    loadedCount: 0,
    unreadCount: 0,
    isLoading: false,
    lastFetchedAt: null,
    preferences: null,
    isDndActive: false,
    toasts: [],
    lastNotificationTime: new Map(),
    isInitialized: false,
    fullListLoaded: false,
    hasMore: false,
    loadError: null,
    hasPermission: false,
    currentFilter: 'all',
    cachedProfileId: null,
    cachedAuthUserId: null,
  }),

  getters: {
    sortedNotifications: (state) => {
      return [...state.notifications].sort((a, b) => {
        if (a.is_read !== b.is_read) {
          return a.is_read ? 1 : -1
        }
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      })
    },

    /**
     * Single-pass projection of `notifications` into every counter the UI
     * reads. Replaces 5+ `filter().length` getters that each scanned the
     * full array (BUGS.md PC5).
     *
     * Parameterized counts (per-channel, per-server, per-conversation) are
     * Maps, so callers do an O(1) lookup instead of an O(n) scan. Recomputed
     * only when `state.notifications` changes; dependents reading several
     * counts in one frame share one scan.
     */
    notificationCounts(): NotificationCounts {
      const total = this.notifications.length
      let unread = 0
      let unreadMentions = 0          // activitypub_mention only (matches legacy `unreadMentions` getter)
      let unreadDMs = 0
      let mentionsAll = 0             // mention OR activitypub_mention
      let dms = 0
      let reactions = 0
      let social = 0
      let follows = 0

      const unreadChannelMentions = new Map<string, number>()
      const unreadServerMentions = new Map<string, number>()
      const unreadConversationMentions = new Map<string, number>()

      const bumpMap = (m: Map<string, number>, key: string | undefined | null) => {
        if (!key) return
        m.set(key, (m.get(key) ?? 0) + 1)
      }

      for (const n of this.notifications) {
        const isMention = n.type === 'mention'
        const isApMention = n.type === 'activitypub_mention'
        const isDM = n.type === 'dm'
        const isReaction = n.type === 'reaction'
        const isFollow = n.type === 'activitypub_follow' || n.type === 'activitypub_follow_request' || n.type === 'activitypub_follow_accepted' || n.type === 'move'
        const isSocial = typeof n.type === 'string' && n.type.startsWith('activitypub_')

        if (isMention || isApMention) mentionsAll++
        if (isDM) dms++
        if (isReaction) reactions++
        if (isSocial) social++
        if (isFollow) follows++

        if (!n.is_read) {
          unread++
          if (isApMention) unreadMentions++
          if (isDM) unreadDMs++
          // A channel at level 'all' badges every message, as a mention does.
          if (isMention || n.type === 'channel_message') {
            // Legacy getters used `||` between top-level and nested forms,
            // so a notification carrying both `data.channel_id = X` and
            // `data.location.channel_id = Y` (X !== Y) counted for both.
            // Bumping both keys when they differ preserves that; `??` would
            // count only one. BUGS.md M3.
            const cid = n.data?.channel_id
            const cidLoc = n.data?.location?.channel_id
            if (cid) bumpMap(unreadChannelMentions, cid)
            if (cidLoc && cidLoc !== cid) bumpMap(unreadChannelMentions, cidLoc)

            const sid = n.data?.server_id
            const sidLoc = n.data?.location?.server_id
            if (sid) bumpMap(unreadServerMentions, sid)
            if (sidLoc && sidLoc !== sid) bumpMap(unreadServerMentions, sidLoc)
          }
          if (isMention || isDM) {
            const cv = n.data?.conversation_id
            const cvNested = n.data?.conversation?.id
            if (cv) bumpMap(unreadConversationMentions, cv)
            if (cvNested && cvNested !== cv) bumpMap(unreadConversationMentions, cvNested)
          }
        }
      }

      return {
        total,
        unread,
        unreadMentions,
        unreadDMs,
        mentionsAll,
        dms,
        reactions,
        social,
        follows,
        unreadChannelMentions,
        unreadServerMentions,
        unreadConversationMentions,
      }
    },

    filteredNotifications(): Notification[] {
      if (this.currentFilter === 'all') {
        return this.sortedNotifications
      }
      
      return this.sortedNotifications.filter((notification: Notification) => {
        switch (this.currentFilter) {
          case 'unread':
            return !notification.is_read
          case 'mentions':
            return notification.type === 'mention' || notification.type === 'activitypub_mention'
          case 'dms':
            return notification.type === 'dm'
          case 'reactions':
            return notification.type === 'reaction'
          case 'social':
            return notification.type.startsWith('activitypub_')
          case 'follows':
            return notification.type === 'activitypub_follow' || notification.type === 'activitypub_follow_request' || notification.type === 'activitypub_follow_accepted' || notification.type === 'move'
          default:
            return true
        }
      })
    },

    // Per-type unread counts, read from the single-pass `notificationCounts`
    // projection above rather than each scanning the full array.
    //
    // The `(this as any).notificationCounts` cast works around a vue-tsc /
    // Pinia inference limit: a method-form getter referencing another via
    // `this` surfaces it as the raw `() => T` function type instead of `T`.
    // Pinia unwraps correctly at runtime.

    unreadMentions(): number {
      return (this as any).notificationCounts.unreadMentions
    },

    unreadDMs(): number {
      return (this as any).notificationCounts.unreadDMs
    },

    unreadChannelMentions(): (channelId: string) => number {
      const map: Map<string, number> = (this as any).notificationCounts.unreadChannelMentions
      return (channelId: string) => map.get(channelId) ?? 0
    },

    unreadServerMentions(): (serverId: string) => number {
      const map: Map<string, number> = (this as any).notificationCounts.unreadServerMentions
      return (serverId: string) => map.get(serverId) ?? 0
    },

    unreadConversationMentions(): (conversationId: string) => number {
      const map: Map<string, number> = (this as any).notificationCounts.unreadConversationMentions
      return (conversationId: string) => map.get(conversationId) ?? 0
    },

    isQuietHours: (state) => {
      if (!state.preferences?.dnd_enabled) return false

      const now = new Date()
      const currentTime = now.getHours() * 60 + now.getMinutes()

      // DND times are stored as UTC; convert to local minutes for comparison
      const startTime = utcTimeStringToLocalMinutes(state.preferences.dnd_start_time)
      const endTime = utcTimeStringToLocalMinutes(state.preferences.dnd_end_time)

      if (startTime > endTime) {
        return currentTime >= startTime || currentTime <= endTime
      }

      return currentTime >= startTime && currentTime <= endTime
    },

    shouldShowDesktopNotification: (state) => {
      return (type: NotificationType) => {
        const store = useNotificationStore()
        if (!state.preferences?.desktop_notifications || store.isQuietHours) return false

        switch (type) {
          case 'mention':
            return state.preferences.desktop_mentions
          case 'dm':
            return state.preferences.desktop_dms
          case 'chat_message':
          case 'channel_message':
            return state.preferences.desktop_chat_messages
          case 'reaction':
            return state.preferences.desktop_reactions
          case 'reply':
          case 'thread_reply':
            return state.preferences.desktop_replies
          
          case 'activitypub_follow':
            return state.preferences.activitypub_desktop_notifications && state.preferences.activitypub_desktop_follows
          case 'activitypub_favorite':
          case 'activitypub_reaction':
            return state.preferences.activitypub_desktop_notifications && state.preferences.activitypub_desktop_favorites
          case 'activitypub_reblog':
            return state.preferences.activitypub_desktop_notifications && state.preferences.activitypub_desktop_reblogs
          case 'activitypub_mention':
            return state.preferences.activitypub_desktop_notifications && state.preferences.activitypub_desktop_mentions
          case 'activitypub_reply':
            return state.preferences.activitypub_desktop_notifications && state.preferences.activitypub_desktop_replies
          case 'activitypub_follow_request':
          case 'activitypub_follow_accepted':
          case 'move':
            return state.preferences.activitypub_desktop_notifications && state.preferences.activitypub_desktop_follows
          
          default:
            return true
        }
      }
    },

    shouldPlaySound: (state) => {
      return (type: NotificationType) => {
        const store = useNotificationStore()
        if (!state.preferences?.sound_notifications || store.isQuietHours) return false
        
        switch (type) {
          case 'mention':
            return state.preferences.sound_mentions
          case 'dm':
            return state.preferences.sound_dms
          case 'chat_message':
          case 'channel_message':
            return state.preferences.sound_chat_messages
          case 'reaction':
            return state.preferences.sound_reactions
          case 'reply':
          case 'thread_reply':
            return state.preferences.sound_replies
          case 'voice_channel_activity':
            return state.preferences.sound_voice_activity
          
          case 'activitypub_follow':
            return state.preferences.activitypub_sound_notifications && state.preferences.activitypub_sound_follows
          case 'activitypub_favorite':
          case 'activitypub_reaction':
            return state.preferences.activitypub_sound_notifications && state.preferences.activitypub_sound_favorites
          case 'activitypub_reblog':
            return state.preferences.activitypub_sound_notifications && state.preferences.activitypub_sound_reblogs
          case 'activitypub_mention':
            return state.preferences.activitypub_sound_notifications && state.preferences.activitypub_sound_mentions
          case 'activitypub_reply':
            return state.preferences.activitypub_sound_notifications && state.preferences.activitypub_sound_replies
          case 'activitypub_follow_request':
          case 'activitypub_follow_accepted':
          case 'move':
            return state.preferences.activitypub_sound_notifications && state.preferences.activitypub_sound_follows
          
          default:
            return true
        }
      }
    },

    notificationFilters() {
      // Counts come from the single-pass `notificationCounts` projection, so
      // one read of this getter costs one scan of `notifications` rather than
      // five. The `as any` cast is the vue-tsc workaround documented above.
      const c: NotificationCounts = (this as any).notificationCounts
      return [
        {
          key: 'all',
          label: 'All',
          icon: 'list',
          count: c.total
        },
        {
          key: 'unread',
          label: 'Unread',
          icon: 'circle',
          count: c.unread
        },
        {
          key: 'mentions',
          label: 'Mentions',
          icon: 'at-sign',
          count: c.mentionsAll
        },
        {
          key: 'dms',
          label: 'Messages',
          icon: 'message-circle',
          count: c.dms
        },
        {
          key: 'social',
          label: 'Social',
          icon: 'globe',
          count: c.social
        },
        {
          key: 'follows',
          label: 'Follows',
          icon: 'users',
          count: c.follows
        }
      ]
    }
  },

  actions: {
    /**
     * Notification rows are created by database triggers; the client only
     * loads, subscribes, and renders.
     */
    async initialize(userId: string) {
      if (this.isInitialized) return
      
      try {
        this.isLoading = true
        debug.log('Notification Store: Initializing for user:', userId)

        this.hasPermission = await this.requestNativePermissionIfNeeded()

        await this.loadPreferences(userId)

        // Handlers first: an event arriving during the fetch is applied, not lost.
        await this.setupBroadcastNotificationHandlers(userId)

        await this.fetchNotifications(userId)
        
        this.setupDndCheck()
        
        this.isInitialized = true
        debug.log('Notification Store: Initialized successfully')
      } catch (error) {
        debug.error('Notification Store: Failed to initialize:', error)
        this.showToast('server_update', 'Failed to load notifications', 'Please refresh the page', 5000)
      } finally {
        this.isLoading = false
      }
    },

    /**
     * Loads only unread notifications (for badge counts) plus the realtime
     * subscription. The full list is deferred to loadFullNotificationList.
     */
    async initializeUnreadCountOnly(userId: string) {
      if (this.isInitialized) return
      
      try {
        debug.log('Notification Store: Initializing with unread notifications')

        this.hasPermission = await this.requestNativePermissionIfNeeded()

        await this.loadPreferences(userId)
        
        const profileId = await this.getProfileId(userId)

        // Handlers first: an event arriving during the fetch is applied, not lost.
        await this.setupBroadcastNotificationHandlers(userId)

        // Sidebar badge getters (unreadDMs, unreadServerMentions, ActivityPub
        // count) need these rows present on first paint.
        await this.refreshUnread(profileId)
        
        this.setupDndCheck()
        
        this.isInitialized = true
        debug.log('Notification Store: Initialization complete')
      } catch (error) {
        debug.error('Notification Store: Failed to initialize:', error)
        this.unreadCount = 0
      }
    },

    /**
     * Loads read notifications too. Called when the notification panel opens.
     */
    async loadFullNotificationList(userId: string, force = false) {
      if (this.fullListLoaded && !force) return

      try {
        this.isLoading = true
        this.loadError = null
        await this.fetchNotifications(userId, PAGE_SIZE, 0)
        this.fullListLoaded = true
      } catch (error) {
        debug.error('Failed to load full notification list:', error)
        this.loadError = "Couldn't load notifications"
      } finally {
        this.isLoading = false
      }
    },

    /**
     * Next page of the full list. Unread rows are preloaded regardless of age, so a
     * page can hold only rows already shown; paging continues until one adds a row.
     */
    async loadMoreNotifications(userId: string) {
      for (let page = 0; page < 10 && this.hasMore; page++) {
        const before = this.notifications.length
        await this.fetchNotifications(userId, PAGE_SIZE, this.loadedCount)
        if (this.notifications.length > before) return
      }
    },

    /**
     * Loads the newest unread rows and reconciles them with the loaded list: rows
     * missing locally are added without alerts, and loaded unread rows the server
     * no longer reports unread were read elsewhere while updates were missed. Rows
     * that arrived or changed during the request are newer than its snapshot and
     * are left as they are.
     */
    async refreshUnread(profileIdOrAuthId?: string) {
      const id = profileIdOrAuthId || this.cachedProfileId || this.cachedAuthUserId
      if (!id) return
      _lastUnreadRefresh = Date.now()
      const since = beginFetch()
      const changed = readChangedSince(since)
      const unreadAtStart = new Set(this.notifications.filter(n => !n.is_read).map(n => n.id))
      try {
        const profileId = await this.getProfileId(id)
        const { data, error } = await supabase
          .from('notifications')
          .select('id, type, is_read, data, created_at, user_id')
          .eq('user_id', profileId)
          .eq('is_read', false)
          .order('created_at', { ascending: false })
          .limit(UNREAD_FETCH_LIMIT)
        if (error) throw error

        const rows = ((data || []) as Notification[]).filter(n => !isFromHiddenUser(n))
        const serverUnread = new Set(rows.map(n => n.id))
        // With a full page, rows older than its oldest are unknown, not read.
        const horizon = rows.length === UNREAD_FETCH_LIMIT
          ? new Date(rows[rows.length - 1].created_at).getTime()
          : -Infinity

        for (const n of this.notifications) {
          if (n.is_read || serverUnread.has(n.id) || !unreadAtStart.has(n.id) || changed(n.id)) continue
          if (new Date(n.created_at).getTime() >= horizon) n.is_read = true
        }
        this.notifications = mergeNotificationPage(this.notifications, rows, false, changed)
        this._capNotifications()
        this.updateUnreadCount()
        this.syncSystemTray()
      } catch (error) {
        debug.error('Failed to load unread notifications:', error)
      } finally {
        endFetch()
      }
    },

    /**
     * Closes system notifications for rows no longer unread. Visible window only:
     * a hidden tab has not shown its user anything yet.
     */
    syncSystemTray() {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
      const keepIds = this.notifications.filter(n => !n.is_read).map(n => n.id)
      void dismissSystemNotifications({ keepIds })
    },

    async fetchNotifications(userId: string, limit = PAGE_SIZE, offset = 0) {
      const changed = readChangedSince(beginFetch())
      try {
        debug.log('Fetching notifications for user:', userId)

        const profileId = await this.getProfileId(userId)

        const data = await services.notifications.fetchNotifications(profileId, {
          limit,
          offset
        })

        debug.log(`Fetched ${data?.length || 0} notifications`)

        const visible = (data || []).filter((n: Notification) => !isFromHiddenUser(n))

        this.notifications = mergeNotificationPage(this.notifications, visible, offset === 0, changed)
        this.loadedCount = offset === 0 ? (data || []).length : this.loadedCount + (data || []).length
        this.hasMore = (data || []).length >= limit
        this._capNotifications()

        // Prime user cache so NotificationItem DisplayName can resolve custom emojis
        const actorIds = (data || []).flatMap((n: Notification) => {
          const d = n.data
          const id = d?.from_user_id ?? d?.sender?.user_id ?? d?.reactor?.user_id ?? d?.reactor?.id ?? d?.inviter?.user_id
          return id && typeof id === 'string' ? [id] : []
        })
        if (actorIds.length) userDataService.ensureUsersLoaded([...new Set(actorIds)]).catch(() => {})

        this.updateUnreadCount()
        this.lastFetchedAt = new Date()

        return data || []
      } catch (error) {
        debug.error('Failed to fetch notifications:', error)
        return await this._fetchNotificationsFallback(userId, limit, offset, changed)
      } finally {
        endFetch()
      }
    },

    /**
     * Direct table query, used when the notifications service throws.
     */
    async _fetchNotificationsFallback(
      userId: string,
      limit = PAGE_SIZE,
      offset = 0,
      keepLocalRead: (id: string) => boolean = () => false,
    ) {
      const profileId = await this.getProfileId(userId)

      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', profileId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (error) throw error

      const visible = (data || []).filter((n: Notification) => !isFromHiddenUser(n))

      this.notifications = mergeNotificationPage(this.notifications, visible, offset === 0, keepLocalRead)
      this.loadedCount = offset === 0 ? (data || []).length : this.loadedCount + (data || []).length
      this.hasMore = (data || []).length >= limit
      this._capNotifications()

      // Prime user cache so NotificationItem DisplayName can resolve custom emojis
      const actorIds = (data || []).flatMap((n: Notification) => {
        const d = n.data
        const id = d?.from_user_id ?? d?.sender?.user_id ?? d?.reactor?.user_id ?? d?.reactor?.id ?? d?.inviter?.user_id
        return id && typeof id === 'string' ? [id] : []
      })
      if (actorIds.length) userDataService.ensureUsersLoaded([...new Set(actorIds)]).catch(() => {})

      this.updateUnreadCount()
      this.lastFetchedAt = new Date()

      return data || []
    },

    /**
     * Registers UserEventChannel broadcast handlers (realtime.send() from DB
     * triggers). Events funnel through _processIncomingNotification /
     * _processNotificationUpdate, which dedupe by notification id, so
     * double-delivery is harmless.
     *
     * No postgres_changes CDC subscription exists.
     */
    async setupBroadcastNotificationHandlers(userId: string) {
      if (_unsubNewNotification) {
        debug.log('Notification handlers already registered, skipping')
        return
      }

      const profileId = await this.getProfileId(userId)
      debug.log('Setting up dual-mode notification handlers for profile:', profileId)

      // Broadcast handlers: best-effort, low latency.
      if (!_unsubNewNotification) {
        userEventChannel.connect(profileId)

        _unsubNewNotification = userEventChannel.on('notification:new', async (data) => {
          try {
            const n = data.notification as Notification
            if (!n?.id) return
            debug.log('Broadcast notification:new →', n.id)
            await this._processIncomingNotification(n)
          } catch (error) {
            debug.error('Broadcast notification:new error:', error)
          }
        })

        _unsubUpdateNotification = userEventChannel.on('notification:update', async (data) => {
          try {
            this._processNotificationUpdate(data.id as string, data.is_read as boolean)
          } catch (error) {
            debug.error('Broadcast notification:update error:', error)
          }
        })

        _unsubBulkRead = userEventChannel.on('notification:bulk_read', (_data) => {
          this.notifications.forEach(n => { if (!n.is_read) setRead(n, true) })
          this.updateUnreadCount()
          void dismissSystemNotifications({ all: true })
        })

        _unsubDeleted = userEventChannel.on('notification:deleted', (data) => {
          const ids = Array.isArray(data.ids) ? (data.ids as string[]) : null
          if (!ids) {
            // Above 500 rows the server sends no ids.
            void this.loadFullNotificationList(profileId, true)
            return
          }
          this._removeLocal(ids)
        })

        _unsubPrefsUpdated = userEventChannel.on('preferences:updated', () => {
          debug.log('Preferences updated on another tab/device, reloading...')
          // Prefer the profile id: the preferences row is keyed on it.
          // loadPreferences resolves either id to a profile id internally.
          const id = this.cachedProfileId || this.cachedAuthUserId
          if (id) {
            this.loadPreferences(id)
          }
        })

        _unsubReconnected = userEventChannel.on('_reconnected', async () => {
          // Events sent while disconnected are lost; the unread set is re-read.
          await this.refreshUnread(profileId)
          if (this.fullListLoaded) await this.loadFullNotificationList(profileId, true)
        })

        if (typeof document !== 'undefined' && !_onVisibility) {
          _onVisibility = () => {
            if (document.visibilityState !== 'visible') return
            if (Date.now() - _lastUnreadRefresh < UNREAD_REFRESH_MIN_MS) {
              this.syncSystemTray()
              return
            }
            void this.refreshUnread(profileId)
          }
          document.addEventListener('visibilitychange', _onVisibility)
        }
      }
    },

    /**
     * Local mirror of mark_notifications_read_by_context: the same predicate over
     * the loaded rows.
     */
    applyContextRead(contextType: 'channel' | 'conversation' | 'post', contextId: string) {
      const matches = (n: Notification): boolean => {
        const d: any = n.data || {}
        if (contextType === 'channel') return d.channel_id === contextId || d.location?.channel_id === contextId
        if (contextType === 'conversation') return d.conversation_id === contextId || d.conversation?.id === contextId
        return d.post_id === contextId || d.post?.id === contextId
      }
      const ids: string[] = []
      for (const n of this.notifications) {
        if (!n.is_read && matches(n)) {
          setRead(n, true)
          ids.push(n.id)
        }
      }
      if (ids.length === 0) return
      this.updateUnreadCount()
      void dismissSystemNotifications({ notificationIds: ids })
    },

    /** Drops rows deleted on any device and closes their system notifications. */
    _removeLocal(ids: string[]) {
      const gone = new Set(ids)
      const before = this.notifications.length
      this.notifications = this.notifications.filter(n => !gone.has(n.id))
      if (this.notifications.length !== before) {
        this.loadedCount = Math.max(0, this.loadedCount - (before - this.notifications.length))
        this.updateUnreadCount()
      }
      void dismissSystemNotifications({ notificationIds: ids })
    },

    /** Local user attention is elsewhere: quiet hours or Busy status. */
    isSilenced(): boolean {
      return this.isQuietHours || isStatusBusy()
    },

    /**
     * Entry point for an incoming notification. Dedupes by id within
     * DEDUP_TTL_MS.
     */
    async _processIncomingNotification(newNotification: Notification) {
      if (!newNotification?.id) return

      if (_recentlyProcessedIds.has(newNotification.id)) return
      if (this.notifications.find(n => n.id === newNotification.id)) return

      _recentlyProcessedIds.add(newNotification.id)
      setTimeout(() => _recentlyProcessedIds.delete(newNotification.id), DEDUP_TTL_MS)

      if (isFromHiddenUser(newNotification)) return

      const notifData = newNotification.data || {}
      const notificationContext = {
        server_id: notifData.location?.server_id || notifData.server_id,
        channel_id: notifData.location?.channel_id || notifData.channel_id,
        conversation_id: notifData.conversation?.id || notifData.conversation_id || notifData.location?.conversation_id,
        type: newNotification.type
      }

      let activeConversationId: string | undefined
      if (!notificationContext.conversation_id && DM_TYPES.has(newNotification.type)) {
        try {
          const { useDMStore } = await import('./useDM')
          const dmStore = useDMStore()
          activeConversationId = dmStore.currentConversationId || undefined
        } catch { /* DM store may not be loaded */ }
      }

      const uiDecision = viewContextTracker.shouldShowNotificationUI(notificationContext, activeConversationId)

      if (!uiDecision.showToast && !uiDecision.showDesktop && !uiDecision.playSound) {
        setRead(newNotification, true)
        this.notifications.unshift(newNotification)
        this._capNotifications()
        services.notifications.markAsRead(newNotification.id).catch(() => {})
        return
      }

      if (this.isSilenced() && newNotification.type !== 'server_update') {
        this.notifications.unshift(newNotification)
        this._capNotifications()
        this.updateUnreadCount()
        return
      }

      this.notifications.unshift(newNotification)
      this._capNotifications()
      this.updateUnreadCount()

      const formatted = NotificationFormatter.formatNotification(newNotification)
      this.handleRealtimeNotification(newNotification, formatted, uiDecision)
    },

    // Evicts oldest-first, read entries only: unreadCount derives from this
    // array. Stays over the cap when every retained entry is unread.
    _capNotifications() {
      let excess = this.notifications.length - MAX_NOTIFICATIONS
      if (excess <= 0) return
      for (let i = this.notifications.length - 1; i >= 0 && excess > 0; i--) {
        if (this.notifications[i].is_read) {
          this.notifications.splice(i, 1)
          excess--
        }
      }
    },

    /**
     * Applies a read-state change. No-op when the state already matches.
     */
    _processNotificationUpdate(id: string, isRead: boolean) {
      if (!id) return
      const existing = this.notifications.find(n => n.id === id)
      if (!existing) return
      if (existing.is_read === isRead) return

      debug.log('Notification read state synced:', id, 'is_read:', isRead)
      setRead(existing, isRead)
      this.updateUnreadCount()

      if (isRead) {
        this.dismissSystemNotification(existing)
      }
    },

    /**
     * Unregisters notification handlers. Leaves the UserEventChannel
     * connected: other consumers share it.
     */
    cleanupBroadcastHandlers() {
      if (_unsubNewNotification) { _unsubNewNotification(); _unsubNewNotification = null }
      if (_unsubUpdateNotification) { _unsubUpdateNotification(); _unsubUpdateNotification = null }
      if (_unsubBulkRead) { _unsubBulkRead(); _unsubBulkRead = null }
      if (_unsubPrefsUpdated) { _unsubPrefsUpdated(); _unsubPrefsUpdated = null }
      if (_unsubReconnected) { _unsubReconnected(); _unsubReconnected = null }
      if (_unsubDeleted) { _unsubDeleted(); _unsubDeleted = null }
      if (_onVisibility) {
        document.removeEventListener('visibilitychange', _onVisibility)
        _onVisibility = null
      }
      // BUGS.md M11: clearing `_dndInterval` here stops the DND check from
      // firing after logout / store reset.
      if (_dndInterval) {
        clearInterval(_dndInterval)
        _dndInterval = null
      }
      _recentlyProcessedIds.clear()
    },


    /**
     * Fans a notification out to toast / desktop / sound according to
     * `uiDecision` from ViewContextTracker and the user's preferences.
     */
    handleRealtimeNotification(
      notification: Notification, 
      formatted: any, 
      uiDecision: any
    ) {
      try {
        debug.log('Processing notification:', notification.type)

        if (uiDecision.showToast) {
          let emojiUrl: string | undefined
          let emojiName: string | undefined
          if (notification.type === 'activitypub_reaction' || notification.type === 'reaction') {
            const data = notification.data
            const reactionData = data.reaction || data
            
            emojiName = reactionData?.emoji_name || reactionData?.custom_emoji_content || data.emoji_name
            emojiUrl = reactionData?.emoji_url || data.emoji_url
            
            if (emojiUrl) {
              emojiUrl = getEmojiUrl(emojiUrl, 48)
            } else {
              // Bridged Discord reactions carry discord:name:id and no url.
              const discord = emojiName ? parseDiscordEmojiToken(emojiName) : null
              if (discord) {
                emojiUrl = discordEmojiCdnUrl(discord)
                emojiName = discord.name
              }
            }
          }
          
          const actorInfo = NotificationFormatter.getActorInfo(notification)
          this.showToast(
            notification.type,
            formatted.title,
            formatted.message,
            4000,
            NotificationFormatter.getAvatarUrl(notification),
            emojiUrl,
            emojiName,
            actorInfo?.actorUserId,
            actorInfo?.titleSuffix,
            notification.id
          )
        }

        // A backgrounded mobile page may not get audio; the system notification
        // carries the sound there. Elsewhere the app sound plays and the system
        // notification stays silent.
        const osCarriesSound = typeof document !== 'undefined' && document.hidden && isMobileUserAgent()
        const appSound = uiDecision.playSound && this.shouldPlaySound(notification.type) && !osCarriesSound

        if (uiDecision.showDesktop && this.shouldShowDesktopNotification(notification.type)) {
          this.showDesktopNotification(notification, formatted, { silent: !osCarriesSound })
        }

        if (appSound) {
          this.playNotificationSound(notification.type)
        }

        debug.log('Notification processed successfully')
      } catch (error) {
        debug.error('Error processing notification:', error)
        this.showToast(
          'server_update',
          'New notification',
          'A notification was received but could not be processed properly',
          3000
        )
      }
    },

    async showDesktopNotification(notification: Notification, formatted?: any, opts: { silent?: boolean } = {}) {
      try {
        // A focused, visible window shows the in-app toast instead.
        if (!document.hidden && document.hasFocus()) {
          return
        }

        if (!formatted) {
          formatted = NotificationFormatter.formatNotification(notification)
        }

        // Tauri clients have no service worker; use the OS notification plugin.
        if (isTauriRuntime()) {
          const data: any = notification.data || {}
          const actor = data.actor || data.reactor || data.sender || {}
          const sender =
            actor.display_name || actor.username || data.sender_display_name || data.display_name || formatted.title
          const serverName = data.server_name || data.location?.server_name || ''
          const channelName = data.channel_name || data.location?.channel_name || ''
          const conversationTitle = serverName
            ? channelName ? `${serverName} #${channelName}` : serverName
            : channelName ? `#${channelName}` : ''

          // MessagingStyle renders sender+message with no title line. When
          // the body is the recipient's own content being acted on, a bare
          // preview reads as if the actor wrote it; prefix the action.
          const contentAction: Record<string, string> = {
            reaction: 'Reacted to your message',
            activitypub_reaction: 'Reacted to your post',
            activitypub_favorite: 'Favorited your post',
            activitypub_reblog: 'Reblogged your post',
            newcomer_message: i18n.global.t('newcomerAlerts.notification.nativePrefix'),
          }
          let message = formatted.message
          const action = contentAction[notification.type]
          if (action) {
            let emojiPrefix = ''
            if (notification.type === 'reaction' || notification.type === 'activitypub_reaction') {
              const reactionData = data.reaction || data
              const emojiUrl = reactionData?.emoji_url || data.emoji_url
              const emojiName = reactionData?.emoji_name || reactionData?.custom_emoji_content || data.emoji_name
              // Unicode emoji renders as text; custom image emoji cannot, so omit it.
              if (emojiName && !emojiUrl) emojiPrefix = emojiName + ' '
            }
            message = `${emojiPrefix}${action}: ${formatted.message}`
          }

          // Large icon: server icon for server mentions, sender avatar otherwise.
          const senderAvatar = NotificationFormatter.getAvatarUrl(notification)
          const serverId = data.server_id || data.location?.server_id
          let largeIconUrl = senderAvatar
          if (serverId) {
            try {
              const { useServerChannelStore } = await import('@/stores/useServerChannel')
              const { getServerIconUrl } = await import('@/utils/serverUtils')
              const server = useServerChannelStore().servers.find((s: any) => s.id === serverId)
              if (server?.icon) largeIconUrl = getServerIconUrl(server.icon, 256)
            } catch {
              /* fall back to sender avatar */
            }
          }
          const pickId = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
          await nativeNotify({
            title: formatted.title,
            sender,
            conversationTitle,
            message,
            avatarUrl: senderAvatar,
            largeIconUrl,
            target: {
              id: notification.id,
              type: notification.type,
              url: this.getNotificationUrl(notification),
              conversation_id: pickId(data.conversation_id || data.conversation?.id),
              server_id: pickId(serverId),
              channel_id: pickId(data.channel_id || data.location?.channel_id),
              thread_id: pickId(data.thread_id || data.thread?.id),
              message_id: pickId(data.message_id || data.message?.id),
              post_id: pickId(data.post_id || data.post?.id),
            },
          })
          return
        }

        if (typeof Notification === 'undefined') {
          return
        }

        if (Notification.permission !== 'granted') {
          return
        }

        // Tags and data match the push payload (PushNotificationService), so a push
        // and this notification replace each other and the worker drops the second.
        const d: any = notification.data || {}
        const conversationId = d.conversation_id || d.conversation?.id
        const channelId = d.channel_id || d.location?.channel_id
        const contextTag = conversationId
          ? `harmony-${notification.type}-conv-${conversationId}`
          : channelId
            ? `harmony-${notification.type}-ch-${channelId}`
            : `harmony-${notification.type}-${notification.id}`

        const pick = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
        const notificationOptions = {
          body: formatted.message,
          icon: NotificationFormatter.getAvatarUrl(notification),
          badge: '/img/app_icon_badge.png',
          tag: contextTag,
          renotify: true,
          silent: opts.silent ?? false,
          data: {
            notification_id: notification.id,
            type: notification.type,
            url: this.getNotificationUrl(notification),
            conversation_id: pick(conversationId),
            server_id: pick(d.server_id || d.location?.server_id),
            channel_id: pick(channelId),
            thread_id: pick(d.thread_id || d.thread?.id),
            message_id: pick(d.message_id || d.message?.id),
          }
        }

        const { serviceWorkerManager } = await import('@/services/ServiceWorkerManager')
        if (await serviceWorkerManager.showNotification(formatted.title, { ...notificationOptions, requireInteraction: false })) {
          debug.log(`Desktop notification queued via SW for ${notification.type}`)
        } else {
          const desktopNotification = new window.Notification(formatted.title, {
            ...notificationOptions,
            requireInteraction: false
          })

          desktopNotification.onclick = () => {
            window.focus()
            this.handleNotificationClick(notification)
            desktopNotification.close()
          }

          const timeout = (notification.type === 'mention' || notification.type === 'dm') ? 12000 : 8000
          setTimeout(() => desktopNotification.close(), timeout)

          debug.log(`Desktop notification shown for ${notification.type}`)
        }
      } catch (error) {
        debug.error('Error showing desktop notification:', error)
      }
    },

    /**
     * Closes OS-level notifications posted via the service worker that match
     * a notification read on another device.
     */
    async dismissSystemNotification(notification: Notification) {
      try {
        const d: any = notification.data || {}
        await dismissSystemNotifications({
          notificationIds: [notification.id],
          conversationId: d.conversation_id || d.conversation?.id,
          channelId: d.channel_id || d.location?.channel_id,
        })
      } catch (error) {
        debug.error('Error dismissing system notification:', error)
      }
    },

    showToast(
      type: NotificationType,
      title: string,
      message: string,
      duration = 4000,
      avatar?: string,
      emojiUrl?: string,
      emojiName?: string,
      actorUserId?: string,
      titleSuffix?: string,
      notificationId?: string
    ) {
      if (this.isSilenced() && type !== 'server_update') return

      const toast: NotificationToast = {
        id: `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type,
        title,
        message,
        avatar,
        emojiUrl,
        emojiName,
        actorUserId,
        titleSuffix,
        duration,
        timestamp: new Date(),
        notificationId
      }
      
      this.toasts.push(toast)
      
      setTimeout(() => {
        this.removeToast(toast.id)
      }, duration)
    },

    removeToast(toastId: string) {
      const index = this.toasts.findIndex(t => t.id === toastId)
      if (index >= 0) {
        this.toasts.splice(index, 1)
      }
    },

    async playNotificationSound(type: NotificationType) {
      try {
        if (!this.shouldPlaySound(type)) return

        const audioAction = NOTIFICATION_SOUND_MAPPING[type]
        if (!audioAction) return

        const { useThemeStore } = await import('./useTheme')
        const themeStore = useThemeStore()
        
        if (!themeStore.isInitialized) {
          await themeStore.initialize()
        }
        
        await themeStore.playAudio(audioAction)
        
        debug.log(`Played sound for ${type}`)
      } catch (error) {
        debug.error(`Failed to play sound for ${type}:`, error)
      }
    },

    updateUnreadCount() {
      this.unreadCount = this.notifications.filter(n => !n.is_read).length
      
      if (typeof navigator !== 'undefined' && 'setAppBadge' in navigator) {
        if (this.unreadCount > 0) {
          ;(navigator as any).setAppBadge(this.unreadCount)
        } else {
          ;(navigator as any).clearAppBadge()
        }
      }

      if (typeof document !== 'undefined') {
        const baseTitle = useInstanceSettingsStore().settings.instanceName || 'Harmony'
        if (this.unreadCount > 0) {
          document.title = `(${this.unreadCount}) ${baseTitle}`
        } else {
          document.title = baseTitle
        }
      }

      updateFaviconBadge(this.unreadCount)
    },

    /**
     * notification_preferences.user_id references profiles(id). Callers pass
     * either an auth user id (legacy) or a profile id; the id is resolved to
     * a profile id before touching the row so loads, upserts, and broadcast
     * reload-handlers stay consistent.
     */
    async loadPreferences(userIdOrAuthId: string) {
      const profileId = await this.getProfileId(userIdOrAuthId)
      try {
        const { data, error } = await supabase
          .from('notification_preferences')
          .select('*')
          .eq('user_id', profileId)
          .maybeSingle()

        if (error && error.code !== 'PGRST116') {
          debug.error('Error loading preferences:', error)
          this.preferences = {
            ...DEFAULT_PREFERENCES,
            id: crypto.randomUUID(),
            user_id: profileId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }
          return
        }

        this.preferences = data || {
          ...DEFAULT_PREFERENCES,
          id: crypto.randomUUID(),
          user_id: profileId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }

        // BUGS.md H1: setupDndCheck early-returns when dnd_enabled is false,
        // so it must be re-invoked on every preference change to (re)start
        // the interval on enable and stop it on disable. Without this a DND
        // toggle in another tab leaves this tab's check dead until reload.
        this.setupDndCheck()

        debug.log('Loaded notification preferences')
      } catch (error) {
        debug.error('Failed to load preferences:', error)
        this.preferences = {
          ...DEFAULT_PREFERENCES,
          id: crypto.randomUUID(),
          user_id: profileId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
        this.setupDndCheck()
      }
    },

    async updatePreferences(newPreferences: Partial<NotificationPreferences>) {
      try {
        if (!this.preferences) return

        const previousPreferences = { ...this.preferences }
        // BUGS.md H1: dnd_enabled flips start/stop the interval;
        // dnd_start_time / dnd_end_time changes require re-evaluating
        // `isQuietHours` immediately.
        const dndFieldsChanged =
          ('dnd_enabled' in newPreferences && newPreferences.dnd_enabled !== previousPreferences.dnd_enabled) ||
          ('dnd_start_time' in newPreferences && newPreferences.dnd_start_time !== previousPreferences.dnd_start_time) ||
          ('dnd_end_time' in newPreferences && newPreferences.dnd_end_time !== previousPreferences.dnd_end_time)

        Object.assign(this.preferences, newPreferences)

        const { error } = await supabase
          .from('notification_preferences')
          .upsert({
            ...this.preferences,
          })

        if (error) {
          this.preferences = previousPreferences
          throw error
        }

        // Re-arms the DND interval: re-evaluates `isQuietHours` synchronously
        // and starts or stops the 60 s tick per the new `dnd_enabled` state.
        if (dndFieldsChanged) {
          this.setupDndCheck()
        }

        if (this.cachedProfileId) {
          userEventChannel.send('preferences:updated', {})
        }

        debug.log('Updated notification preferences')
      } catch (error) {
        debug.error('Failed to update preferences:', error)
        throw error
      }
    },

    // reads only, never prompts (unprompted requests get flagged as spammy)
    async checkNotificationPermission(): Promise<boolean> {
      if (typeof Notification === 'undefined') {
        return false
      }

      return Notification.permission === 'granted'
    },

    // Native has no web-push soft-ask banner; ask the OS once post-login. Web
    // stays read-only here - its gesture-based soft-ask issues the prompt.
    async requestNativePermissionIfNeeded(): Promise<boolean> {
      if (!isTauriRuntime()) return this.checkNotificationPermission()
      try {
        const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification')
        if (await isPermissionGranted()) return true
        return (await requestPermission()) === 'granted'
      } catch (error) {
        debug.warn('native notification permission request failed:', error)
        return false
      }
    },

    setupDndCheck() {
      if (_dndInterval) {
        clearInterval(_dndInterval)
        _dndInterval = null
      }
      // Compute synchronously so the UI reflects DND state without waiting
      // for the first tick.
      this.isDndActive = this.isQuietHours
      // No transitions to detect while DND is off. loadPreferences and
      // updatePreferences re-invoke this when the setting changes.
      if (!this.preferences?.dnd_enabled) return
      _dndInterval = setInterval(() => {
        this.isDndActive = this.isQuietHours
      }, 60000)
    },

    async markAsRead(notificationId: string) {
      const notification = this.notifications.find(n => n.id === notificationId)
      
      try {
        if (notification) {
          setRead(notification, true)
          this.updateUnreadCount()
        }

        await services.notifications.markAsRead(notificationId)
        void dismissSystemNotifications({ notificationIds: [notificationId] })
      } catch (error) {
        debug.error('Failed to mark notification as read:', error)

        if (notification) {
          setRead(notification, false)
          this.updateUnreadCount()
        }
        throw error
      }
    },

    /**
     * Marks read by id, including rows not loaded here (a push clicked while the app
     * was closed). No revert: the ids come from explicit reads.
     */
    async markManyAsRead(ids: string[]) {
      const unique = [...new Set(ids.filter(Boolean))]
      if (unique.length === 0) return
      const wanted = new Set(unique)
      let changed = false
      for (const n of this.notifications) {
        if (wanted.has(n.id) && !n.is_read) {
          setRead(n, true)
          changed = true
        }
      }
      if (changed) this.updateUnreadCount()
      void dismissSystemNotifications({ notificationIds: unique })

      const { error } = await supabase
        .from('notifications')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .in('id', unique)
        .eq('is_read', false)
      if (error) debug.error('Failed to mark notifications as read:', error)
    },

    async markAsUnread(notificationId: string) {
      const notification = this.notifications.find(n => n.id === notificationId)
      
      try {
        if (notification) {
          setRead(notification, false)
          this.updateUnreadCount()
        }

        await services.notifications.markAsUnread(notificationId)
      } catch (error) {
        debug.error('Failed to mark notification as unread:', error)
        
        if (notification) {
          setRead(notification, true)
          this.updateUnreadCount()
        }
        throw error
      }
    },

    async deleteNotification(notificationId: string) {
      const index = this.notifications.findIndex(n => n.id === notificationId)
      if (index === -1) return
      
      const notification = this.notifications[index]
      
      try {
        this.notifications.splice(index, 1)
        this.loadedCount = Math.max(0, this.loadedCount - 1)
        this.updateUnreadCount()

        await services.notifications.deleteNotification(notificationId)
        void dismissSystemNotifications({ notificationIds: [notificationId] })
      } catch (error) {
        debug.error('Failed to delete notification:', error)
        
        this.notifications.splice(index, 0, notification)
        this.updateUnreadCount()
        this.showToast('server_update', 'Failed to delete notification', 'Please try again', 3000)
        throw error
      }
    },  

    /**
     * Marks mention/reply notifications for the given post ids as read.
     * Called by the Mentions view as posts enter the viewport, so only
     * notifications for posts actually seen are cleared.
     *
     * Local state is updated optimistically, then mirrored to the DB so rows
     * the store has not loaded are still persisted. A failed DB write rejects
     * and local state is not reverted; the caller retries on the next view.
     */
    async markMentionNotificationsForPostsAsRead(postIds: string[]) {
      if (!postIds.length) return

      const idSet = new Set(postIds.map(String))
      const types = new Set(['activitypub_mention', 'activitypub_reply'])

      const localToMark = this.notifications.filter(n => {
        if (n.is_read) return false
        if (!types.has(n.type)) return false
        const refId = n.data?.post_id ?? n.data?.post?.id
        return refId !== undefined && idSet.has(String(refId))
      })

      if (localToMark.length > 0) {
        // Optimistic so the badge reacts immediately. No revert path: a
        // failed DB write is retried on the next view of these posts. Stale
        // `read=true` beats a badge flicker mid-read.
        localToMark.forEach(n => setRead(n, true))
        this.updateUnreadCount()
      }

      try {
        const authStore = useAuthStore()
        const authUserId = authStore.session?.user?.id
        if (!authUserId) return
        const profileId = await this.getProfileId(authUserId)
        if (!profileId) return

        await services.notifications.markMentionNotificationsForPostsAsRead(profileId, postIds)
      } catch (error) {
        debug.error('Failed to persist mention notifications as read:', error)
        throw error
      }
    },

    /**
     * Deletes every notification for the current user. Clears the in-memory
     * list optimistically and restores the snapshot on failure.
     */
    async clearAllNotifications() {
      if (this.notifications.length === 0) return

      const snapshot = [...this.notifications]
      const loadedSnapshot = this.loadedCount

      try {
        const authStore = useAuthStore()
        const authUserId = authStore.session?.user?.id
        if (!authUserId) return

        const profileId = await this.getProfileId(authUserId)
        if (!profileId) return

        this.notifications = []
        this.loadedCount = 0
        this.hasMore = false
        this.updateUnreadCount()

        await services.notifications.deleteAllNotifications(profileId)
        void dismissSystemNotifications({ all: true })
      } catch (error) {
        debug.error('Failed to clear all notifications:', error)
        // Revert on server rejection (RLS, network).
        this.notifications = snapshot
        this.loadedCount = loadedSnapshot
        this.updateUnreadCount()
        this.showToast('server_update', 'Failed to clear notifications', 'Please try again', 3000)
      }
    },

    async markAllAsRead() {
      // Snapshot read state for revert if the RPC fails. Marking happens only
      // after a profile id is resolved; otherwise the UI flips to "all read"
      // and the next refresh restores the unread state.
      const previousReadStates = this.notifications.map(n => ({ id: n.id, is_read: n.is_read }))

      const revertOptimistic = () => {
        previousReadStates.forEach(({ id, is_read }) => {
          const notification = this.notifications.find(n => n.id === id)
          if (notification) notification.is_read = is_read
        })
        this.updateUnreadCount()
      }

      try {
        const authStore = useAuthStore()
        const authUserId = authStore.session?.user?.id
        if (!authUserId) return

        // The RPC validates p_user_id against get_current_profile_id(), so it
        // takes the profile id, not the auth user id. The auth id trips the
        // DB's "Not authorized" guard and reverts the UI.
        const profileId = await this.getProfileId(authUserId)
        if (!profileId) return

        this.notifications.forEach(n => { if (!n.is_read) setRead(n, true) })
        this.updateUnreadCount()

        const { error } = await supabase
          .rpc('mark_all_notifications_read', { p_user_id: profileId })

        if (error) {
          revertOptimistic()
          throw error
        }

      } catch (error) {
        debug.error('Failed to mark all notifications as read:', error)
        this.showToast('server_update', "Couldn't mark notifications as read", 'Try again.', 3000)
      }
    },

    setFilter(filter: string) {
      this.currentFilter = filter;
    },

    async setVolume(volume: number) {
      try {
        const { useThemeStore } = await import('./useTheme')
        const themeStore = useThemeStore()

        if (!themeStore.isInitialized) {
          await themeStore.initialize()
        }

        themeStore.setAudioVolume(Math.max(0, Math.min(1, volume)))

        debug.log(`Set notification volume to ${Math.round(volume * 100)}%`)
      } catch (error) {
        debug.error('Failed to set notification volume:', error)
      }
    },
    /** Route path for a notification; also the url carried by system notifications. */
    getNotificationUrl(notification: Notification): string {
      return resolveNotificationRoute(notification)
    },

    handleNotificationClick(notification: Notification) {
      try {
        if (!notification.is_read) {
          this.markAsRead(notification.id).catch(() => {})
        }
        supabase
          .from('notifications')
          .update({ is_clicked: true })
          .eq('id', notification.id)
          .then(({ error }) => {
            if (error) debug.warn('Failed to set is_clicked:', error)
          })

        router.push(resolveNotificationRoute(notification)).catch((error) => {
          debug.warn('Notification navigation failed:', error)
        })
      } catch (error) {
        debug.error('Error handling notification click:', error)
      }
    },

    /**
     * Sign-out: drops handlers and every row, restores the title, badge and favicon,
     * and closes this account's system notifications.
     */
    resetForLogout() {
      this.cleanupBroadcastHandlers()
      this.$reset()
      this.updateUnreadCount()
      void dismissSystemNotifications({ all: true })
    },

    async getProfileId(authUserId: string): Promise<string> {
      if (this.cachedProfileId && this.cachedAuthUserId === authUserId) {
        return this.cachedProfileId
      }

      try {
        const context = await authContextService.getCurrentContext()
        
        if (context.isAuthenticated) {
          this.cachedProfileId = context.profileId
          this.cachedAuthUserId = authUserId
          return context.profileId
        } else {
          // Fall back to the auth user id for backward compatibility.
          this.cachedProfileId = authUserId
          this.cachedAuthUserId = authUserId
          return authUserId
        }
      } catch (error) {
        debug.warn('Could not get profile from AuthContextService, using auth user ID:', error)
        this.cachedProfileId = authUserId
        this.cachedAuthUserId = authUserId
        return authUserId
      }
    },

    clearProfileCache() {
      this.cachedProfileId = null
      this.cachedAuthUserId = null
    },
  }
})

function utcTimeStringToLocalMinutes(utcTimeString: string): number {
  const [h, m] = utcTimeString.split(':').map(Number)
  const now = new Date()
  const utcDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), h, m))
  return utcDate.getHours() * 60 + utcDate.getMinutes()
}