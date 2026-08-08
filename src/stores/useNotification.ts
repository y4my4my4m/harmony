import { defineStore } from 'pinia'
import { supabase } from '@/supabase'
import router from '@/router'
import { useAuthStore } from './auth'
import { viewContextTracker } from '@/services/ViewContextTracker'
import { NotificationFormatter } from '@/services/NotificationFormatter'
import { nativeNotify } from '@/services/nativeNotify'
import { isTauriRuntime } from '@/services/instanceConfig'
import { getEmojiUrl } from '@/utils/emojiUtils'
import { services } from '@/services'
import { authContextService } from '@/services/AuthContextService'
import { userDataService } from '@/services/userDataService'
import { userEventChannel } from '@/services/UserEventChannel'
import { debug } from '@/utils/debug'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { updateFaviconBadge } from '@/utils/faviconBadge'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
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
  hasPermission: boolean
  currentFilter: string
  cachedProfileId: string | null
  cachedAuthUserId: string | null
}

const NOTIFICATION_SOUND_MAPPING: Record<NotificationType, AudioAction> = {
  mention: 'mention',
  dm: 'dm', 
  chat_message: 'dm',
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
  report_update: 'server_update',
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
let _dndInterval: ReturnType<typeof setInterval> | null = null
const _recentlyProcessedIds = new Set<string>()
const DEDUP_TTL_MS = 10_000
// 12 pages at the bell's 25-row page size.
const MAX_NOTIFICATIONS = 300

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
        const isFollow = n.type === 'activitypub_follow' || n.type === 'activitypub_follow_request' || n.type === 'activitypub_follow_accepted'
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
          if (isMention) {
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
            return notification.type === 'activitypub_follow' || notification.type === 'activitypub_follow_request' || notification.type === 'activitypub_follow_accepted'
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
          case 'reaction':
            return state.preferences.desktop_reactions
          case 'reply':
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
          case 'reaction':
            return state.preferences.sound_reactions
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
        
        await this.fetchNotifications(userId)
        
        this.setupBroadcastNotificationHandlers(userId)
        
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
        
        // Sidebar badge getters (unreadDMs, unreadServerMentions, ActivityPub
        // count) need these rows present on first paint.
        try {
          const { data, error } = await supabase
            .from('notifications')
            .select('id, type, is_read, data, created_at, user_id')
            .eq('user_id', profileId)
            .eq('is_read', false)
            .order('created_at', { ascending: false })
            .limit(200)

          if (error) {
            debug.error('Failed to load unread notifications:', error)
          } else {
            this.notifications = (data || []) as any
            debug.log(`Loaded ${this.notifications.length} unread notifications for badges`)
          }
        } catch (err) {
          debug.error('Failed to load unread notifications:', err)
        }
        
        this.updateUnreadCount()
        
        this.setupBroadcastNotificationHandlers(userId)
        
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
    async loadFullNotificationList(userId: string) {
      if (this.fullListLoaded) {
        debug.log('Full notification list already loaded')
        return
      }
      
      try {
        this.isLoading = true
        debug.log('Loading full notification list...')
        await this.fetchNotifications(userId)
        this.fullListLoaded = true
        debug.log('Full notification list loaded')
      } catch (error) {
        debug.error('Failed to load full notification list:', error)
      } finally {
        this.isLoading = false
      }
    },

    async fetchNotifications(userId: string, limit = 50, offset = 0) {
      try {
        debug.log('Fetching notifications for user:', userId)
        
        const profileId = await this.getProfileId(userId)
        
        const data = await services.notifications.fetchNotifications(profileId, {
          limit,
          offset
        })

        debug.log(`Fetched ${data?.length || 0} notifications`)

        const visible = (data || []).filter((n: Notification) => !isFromHiddenUser(n))

        if (offset === 0) {
          this.notifications = visible
          this.loadedCount = (data || []).length
        } else {
          this.notifications.push(...visible)
          this.loadedCount += (data || []).length
        }
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
        
        try {
          debug.log('Falling back to direct notification fetch')
          await this._fetchNotificationsFallback(userId, limit, offset)
        } catch (fallbackError) {
          debug.error('Fallback fetch also failed:', fallbackError)
          if (import.meta.env.DEV) {
            this.createMockNotifications(userId)
          }
        }
        throw error
      }
    },

    /**
     * Direct table query, used when the notifications service throws.
     */
    async _fetchNotificationsFallback(userId: string, limit = 50, offset = 0) {
      const profileId = await this.getProfileId(userId)
      
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', profileId)
        .order('created_at', { ascending: false })
        .limit(limit)

      if (error) throw error

      const visible = (data || []).filter((n: Notification) => !isFromHiddenUser(n))

      if (offset === 0) {
        this.notifications = visible
        this.loadedCount = (data || []).length
      } else {
        this.notifications.push(...visible)
        this.loadedCount += (data || []).length
      }
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
          debug.log('Bulk read event received, marking all notifications as read locally')
          this.notifications.forEach(n => { n.is_read = true })
          this.updateUnreadCount()
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
          debug.log('UserEventChannel reconnected - gap-filling notifications')
          await this.fetchNotifications(profileId)
        })

        debug.log('Broadcast notification handlers registered')
      }

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
      if (!notificationContext.conversation_id && newNotification.type === 'dm') {
        try {
          const { useDMStore } = await import('./useDM')
          const dmStore = useDMStore()
          activeConversationId = dmStore.currentConversationId || undefined
        } catch { /* DM store may not be loaded */ }
      }

      const uiDecision = viewContextTracker.shouldShowNotificationUI(notificationContext, activeConversationId)

      if (!uiDecision.showToast && !uiDecision.showDesktop && !uiDecision.playSound) {
        newNotification.is_read = true
        this.notifications.unshift(newNotification)
        this._capNotifications()
        services.notifications.markAsRead(newNotification.id).catch(() => {})
        return
      }

      if (this.isQuietHours && newNotification.type !== 'server_update') {
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
      existing.is_read = isRead
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

        if (uiDecision.showDesktop && this.shouldShowDesktopNotification(notification.type)) {
          this.showDesktopNotification(notification, formatted)
        }

        if (uiDecision.playSound && this.shouldPlaySound(notification.type)) {
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

    async showDesktopNotification(notification: Notification, formatted?: any) {
      try {
        // Desktop notifications only while the tab is hidden; in-app toasts
        // cover the visible case.
        if (!document.hidden) {
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
          const groupKey =
            data.server_id || data.conversation_id || data.channel_id || notification.type || ''

          // MessagingStyle renders sender+message with no title line. When
          // the body is the recipient's own content being acted on, a bare
          // preview reads as if the actor wrote it; prefix the action.
          const contentAction: Record<string, string> = {
            reaction: 'Reacted to your message',
            activitypub_reaction: 'Reacted to your post',
            activitypub_favorite: 'Favorited your post',
            activitypub_reblog: 'Reblogged your post',
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
          await nativeNotify({
            title: formatted.title,
            sender,
            conversationTitle,
            message,
            avatarUrl: senderAvatar,
            largeIconUrl,
            groupKey,
          })
          return
        }

        if (typeof Notification === 'undefined') {
          return
        }

        if (Notification.permission !== 'granted') {
          return
        }

        // Per-context tags: a new notification from the same source replaces
        // the previous one instead of stacking (e.g. DMs in one conversation).
        const contextTag = notification.data?.conversation_id
          ? `harmony-${notification.type}-conv-${notification.data.conversation_id}`
          : notification.data?.channel_id
            ? `harmony-${notification.type}-ch-${notification.data.channel_id}`
            : `harmony-${notification.type}-${notification.id}`

        const notificationOptions = {
          body: formatted.message,
          icon: NotificationFormatter.getAvatarUrl(notification),
          badge: '/img/app_icon_badge.png',
          tag: contextTag,
          renotify: true,
          silent: false,
          data: {
            notificationId: notification.id,
            type: notification.type,
            url: this.getNotificationUrl(notification)
          }
        }

        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
          const registration = await navigator.serviceWorker.ready
          await registration.showNotification(formatted.title, {
            ...notificationOptions,
            requireInteraction: false
          })
          debug.log(`Desktop notification shown via SW for ${notification.type}`)
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
        if (!('serviceWorker' in navigator)) return
        
        const registration = await navigator.serviceWorker.ready
        const shown = await registration.getNotifications()
        
        for (const sysNotif of shown) {
          const matchesId = sysNotif.data?.notificationId === notification.id
          const matchesConversation = notification.data?.conversation_id &&
            sysNotif.tag?.includes(`conv-${notification.data.conversation_id}`)
          const matchesChannel = notification.data?.channel_id &&
            sysNotif.tag?.includes(`ch-${notification.data.channel_id}`)
          
          if (matchesId || matchesConversation || matchesChannel) {
            sysNotif.close()
            debug.log('Dismissed system notification synced from another device:', sysNotif.tag)
          }
        }
        
        if (typeof navigator !== 'undefined' && 'setAppBadge' in navigator) {
          const remaining = await registration.getNotifications()
          if (remaining.length > 0) {
            ;(navigator as any).setAppBadge(remaining.length)
          } else {
            ;(navigator as any).clearAppBadge()
          }
        }
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
      if (this.isQuietHours && type !== 'server_update') return
      
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
          notification.is_read = true
          this.updateUnreadCount()
        }

        await services.notifications.markAsRead(notificationId)
      } catch (error) {
        debug.error('Failed to mark notification as read:', error)
        
        if (notification) {
          notification.is_read = false
          this.updateUnreadCount()
        }
        throw error
      }
    },

    async markAsUnread(notificationId: string) {
      const notification = this.notifications.find(n => n.id === notificationId)
      
      try {
        if (notification) {
          notification.is_read = false
          this.updateUnreadCount()
        }

        await services.notifications.markAsUnread(notificationId)
      } catch (error) {
        debug.error('Failed to mark notification as unread:', error)
        
        if (notification) {
          notification.is_read = true
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
        this.updateUnreadCount()
        
        await services.notifications.deleteNotification(notificationId)
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
     * the store has not loaded are still persisted. The DB call is
     * fire-and-forget: failures are logged and local state is not reverted;
     * the next scroll into view retries.
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
        localToMark.forEach(n => { n.is_read = true })
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
        this.updateUnreadCount()

        await services.notifications.deleteAllNotifications(profileId)
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

        this.notifications.forEach(n => { n.is_read = true })
        this.updateUnreadCount()

        const { error } = await supabase
          .rpc('mark_all_notifications_read', { p_user_id: profileId })

        if (error) {
          revertOptimistic()
          throw error
        }

      } catch (error) {
        debug.error('Failed to mark all notifications as read:', error)
        this.showToast('server_update', 'Failed to mark notifications as read', 'Please try again', 3000)
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
    /**
     * Route path for a notification. Also used by the service worker's
     * notification-click handler.
     */
    getNotificationUrl(notification: Notification): string {
      try {
        const navData = NotificationFormatter.getNavigationData(notification)
        
        if (navData) {
          switch (navData.type) {
            case 'conversation': {
              let dmPath = `/dm/${navData.conversationId}`
              if (navData.messageId) {
                dmPath += `?messageId=${navData.messageId}`
              }
              return dmPath
            }

            case 'channel': {
              let path = `/chat/${navData.serverId}/${navData.channelId}`
              if (navData.messageId) {
                path += `?messageId=${navData.messageId}`
              }
              return path
            }
              
            case 'server':
              return `/server/${navData.serverId}`

            case 'activitypub_post':
              return `/post/${navData.postId}`

            case 'profile':
              return `/social/profile/${navData.handle}`

            default:
              return '/'
          }
        }
        return '/'
      } catch (error) {
        debug.error('Error getting notification URL:', error)
        return '/'
      }
    },

    handleNotificationClick(notification: Notification) {
      try {
        this.markAsRead(notification.id)
        supabase
          .from('notifications')
          .update({ is_clicked: true })
          .eq('id', notification.id)
          .then(({ error }) => {
            if (error) debug.warn('Failed to set is_clicked:', error)
          })
        
        const navData = NotificationFormatter.getNavigationData(notification)
        
        if (navData) {
          switch (navData.type) {
            case 'conversation': {
              let dmPath = `/dm/${navData.conversationId}`
              if (navData.messageId) {
                dmPath += `?messageId=${navData.messageId}`
              }
              router.push(dmPath)
              break
            }
              
            case 'channel': {
              let path = `/chat/${navData.serverId}/${navData.channelId}`
              if (navData.messageId) {
                path += `?messageId=${navData.messageId}`
              }
              router.push(path)
              break
            }
              
            case 'server':
              router.push(`/server/${navData.serverId}`)
              break

            case 'activitypub_post':
              router.push({
                name: 'PostDetail',
                params: { postId: navData.postId }
              })
              break

            case 'profile':
              router.push({ name: 'UserProfile', params: { handle: (navData.handle || '').replace(/^@/, '') } })
              break

            default:
              // Exhaustive narrowing collapses `navData.type` to `never` in
              // the default branch; cast through `any` to log it.
              debug.log('No navigation data for notification type:', (navData as any).type)
          }
        } else {
          // Fallback routing for notifications the formatter yielded no
          // navigation data for.
          debug.warn('No navigation data extracted for notification:', notification.type)
          
          if (notification.type.startsWith('activitypub_')) {
            router.push('/social/home')
          } else if (notification.type === 'dm') {
            const conversationId = notification.data?.conversation?.id || notification.data?.conversation_id
            if (conversationId) {
              router.push(`/dm/${conversationId}`)
            } else {
              router.push('/dm')
            }
          } else {
            debug.warn('Could not determine navigation for notification, going to home')
          }
        }
      } catch (error) {
        debug.error('Error handling notification click:', error)
      }
    },

    createMockNotifications(userId: string) {
      // Development-only. The mock shape carries legacy
      // `sender`/`message`/`conversation`/`title` fields absent from the
      // current `Notification`/`NotificationData` typings; cast through `any`.
      const mockNotifications: Notification[] = ([
        {
          id: '1',
          user_id: userId,
          type: 'mention',
          data: {
            sender: {
              user_id: 'dev-user-1',
              username: 'Developer',
              avatar_url: '/default_avatar.webp'
            },
            location: {
              server_id: 'test-server',
              server_name: 'Test Server',
              channel_id: 'test-channel',
              channel_name: 'general'
            },
            message: {
              id: 'test-message-1',
              content_preview: 'Check out this cool feature!',
            }
          },
          is_read: false,
          is_clicked: false,
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          title: ''
        },
        {
          id: '2',
          user_id: userId,
          type: 'dm',
          data: {
            sender: {
              user_id: 'dev-user-2',
              username: 'Friend',
              avatar_url: '/default_avatar.webp'
            },
            conversation: {
              id: 'test-conv'
            },
            message: {
              id: 'test-message-2',
              content_preview: 'Hey! How are you doing?',
            }
          },
          is_read: false,
          is_clicked: false,
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          title: ''
        }
      ] as any) as Notification[]

      this.notifications = mockNotifications
      this.updateUnreadCount()
      debug.log('Created mock notifications for development')
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

// eslint-disable-next-line unused-imports/no-unused-vars
function timeStringToMinutes(timeString: string): number {
  const [hours, minutes] = timeString.split(':').map(Number)
  return hours * 60 + minutes
}

function utcTimeStringToLocalMinutes(utcTimeString: string): number {
  const [h, m] = utcTimeString.split(':').map(Number)
  const now = new Date()
  const utcDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), h, m))
  return utcDate.getHours() * 60 + utcDate.getMinutes()
}