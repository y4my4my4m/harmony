/**
 * Route-Aware Initialization Service
 * 
 * Determines what data to load based on the current route to optimize performance.
 * Prevents loading unnecessary data (DMs when on server channels, all server data when on DMs).
 */

import type { RouteLocationNormalized } from 'vue-router'
import { debug } from '@/utils/debug'

export interface LoadingStrategy {
  shouldLoadDMs: boolean
  shouldLoadAllServerPresence: boolean
  shouldLoadAllServerEmojis: boolean
  shouldLoadNotificationsFull: boolean
  currentServerId?: string
  currentChannelId?: string
  currentConversationId?: string
  routeType: 'server-channel' | 'dm' | 'dm-list' | 'social' | 'settings' | 'other'
}

export class RouteAwareInitialization {
  private static instance: RouteAwareInitialization

  static getInstance(): RouteAwareInitialization {
    if (!this.instance) {
      this.instance = new RouteAwareInitialization()
    }
    return this.instance
  }

  /**
   * Determine loading strategy based on current route
   */
  getLoadingStrategy(route: RouteLocationNormalized): LoadingStrategy {
    const routeName = route.name as string
    const routePath = route.path

    debug.log('RouteAwareInitialization: Analyzing route', { name: routeName, path: routePath, params: route.params })

    // Server channel routes: /chat/{serverId}/{channelId}
    if (routeName === 'ChatChannel' || (routePath.startsWith('/chat/') && route.params.serverId && route.params.channelId)) {
      return {
        shouldLoadDMs: false, // ❌ Don't load DMs when viewing server channels
        shouldLoadAllServerPresence: false, // ❌ Only current server presence
        shouldLoadAllServerEmojis: false, // ❌ Only current server emojis
        shouldLoadNotificationsFull: false, // ❌ Only unread count initially
        currentServerId: route.params.serverId as string,
        currentChannelId: route.params.channelId as string,
        routeType: 'server-channel'
      }
    }

    // DM conversation routes: /dm/{conversationId}
    if (routeName === 'DMConversation' || (routePath.startsWith('/dm/') && route.params.conversationId)) {
      return {
        shouldLoadDMs: true, // ✅ Load that specific DM + DM list metadata
        shouldLoadAllServerPresence: false, // ❌ Don't load server presence when in DMs
        shouldLoadAllServerEmojis: false, // ❌ No server emojis needed for DMs
        shouldLoadNotificationsFull: false, // ❌ Only unread count initially
        currentConversationId: route.params.conversationId as string,
        routeType: 'dm'
      }
    }

    // DM list route: /dm (no specific conversation)
    if (routeName === 'DMHome' || routePath === '/dm') {
      return {
        shouldLoadDMs: true, // ✅ Load DM list metadata only (no message content)
        shouldLoadAllServerPresence: false, // ❌ Don't load server presence
        shouldLoadAllServerEmojis: false, // ❌ No server emojis needed
        shouldLoadNotificationsFull: false, // ❌ Only unread count initially
        routeType: 'dm-list'
      }
    }

    // ActivityPub/Social routes
    const socialRoutes = ['Social', 'SocialHome', 'SocialLocal', 'SocialPublic', 'Notifications', 'Bookmarks', 'UserProfile']
    if (socialRoutes.includes(routeName) || routePath.startsWith('/social/')) {
      return {
        shouldLoadDMs: false, // ❌ Don't load DMs in social context
        shouldLoadAllServerPresence: false, // ❌ Don't load server presence in social context
        shouldLoadAllServerEmojis: false, // ❌ Don't load server emojis in social context
        shouldLoadNotificationsFull: routeName === 'Notifications', // ✅ Full notifications only on notifications page
        routeType: 'social'
      }
    }

    // Settings / admin standalone routes - no chat/DM/presence context needed
    const settingsRoutes = ['UserSettings', 'ServerSettings', 'Admin', 'AdminDashboard']
    if (
      settingsRoutes.includes(routeName) ||
      routePath.startsWith('/settings') ||
      routePath.startsWith('/admin')
    ) {
      return {
        shouldLoadDMs: false,
        shouldLoadAllServerPresence: false,
        shouldLoadAllServerEmojis: false,
        shouldLoadNotificationsFull: false,
        routeType: 'settings'
      }
    }

    // Base chat route: /chat (no specific server/channel)
    if (routeName === 'Chat' || routePath === '/chat') {
      return {
        shouldLoadDMs: false, // ❌ Will redirect to specific server/channel
        shouldLoadAllServerPresence: false, // ❌ Wait for redirect to specific server
        shouldLoadAllServerEmojis: false, // ❌ Wait for redirect to specific server
        shouldLoadNotificationsFull: false, // ❌ Only unread count initially
        routeType: 'other'
      }
    }

    // Default/fallback strategy (conservative approach)
    debug.log('RouteAwareInitialization: Unknown route, using conservative loading strategy')
    return {
      shouldLoadDMs: false,
      shouldLoadAllServerPresence: false,
      shouldLoadAllServerEmojis: false,
      shouldLoadNotificationsFull: false,
      routeType: 'other'
    }
  }

  /**
   * Get what data should be loaded in Phase 1 (Critical Path - first 100ms)
   */
  getCriticalPathData(strategy: LoadingStrategy): string[] {
    const criticalData = [
      'auth-context',
      'theme-store',
      'basic-ui-framework'
    ]

    if (strategy.routeType === 'server-channel') {
      criticalData.push('current-server-resolution', 'current-channel-resolution')
    } else if (strategy.routeType === 'dm') {
      criticalData.push('dm-conversation-resolution')
    }

    return criticalData
  }

  /**
   * Get what data should be loaded in Phase 2 (Content Loading - 100-300ms)
   */
  getContentLoadingData(strategy: LoadingStrategy): string[] {
    const contentData: string[] = []

    if (strategy.routeType === 'server-channel') {
      contentData.push(
        'current-channel-messages',
        'current-server-users',
        'current-server-emojis',
        'current-server-presence'
      )
    } else if (strategy.routeType === 'dm') {
      contentData.push(
        'dm-conversation-messages',
        'dm-conversation-participants',
        'dm-list-metadata'
      )
    } else if (strategy.routeType === 'dm-list') {
      contentData.push('dm-list-metadata')
    }

    return contentData
  }

  /**
   * Get what data should be loaded in Phase 3 (Background Loading - after UI is interactive)
   */
  getBackgroundLoadingData(_strategy: LoadingStrategy): string[] {
    return [
      'notification-unread-count',
      'other-servers-metadata'
    ]
  }

  /**
   * Get what data should be loaded on-demand only
   */
  getOnDemandData(strategy: LoadingStrategy): string[] {
    const onDemandData: string[] = []

    if (strategy.routeType !== 'dm' && strategy.routeType !== 'dm-list') {
      onDemandData.push('dm-conversations-metadata', 'dm-conversation-content')
    }

    if (strategy.routeType !== 'server-channel') {
      onDemandData.push('other-servers-presence', 'other-servers-emojis')
    }

    onDemandData.push('full-notification-list', 'user-activity-tracking')

    return onDemandData
  }

  /**
   * Log the loading strategy for debugging
   */
  logStrategy(strategy: LoadingStrategy): void {
    debug.log('Loading Strategy:', {
      routeType: strategy.routeType,
      currentServerId: strategy.currentServerId,
      currentChannelId: strategy.currentChannelId,
      currentConversationId: strategy.currentConversationId,
      shouldLoadDMs: strategy.shouldLoadDMs,
      shouldLoadAllServerPresence: strategy.shouldLoadAllServerPresence,
      shouldLoadAllServerEmojis: strategy.shouldLoadAllServerEmojis,
      shouldLoadNotificationsFull: strategy.shouldLoadNotificationsFull
    })

    debug.log('Critical Path:', this.getCriticalPathData(strategy))
    debug.log('Content Loading:', this.getContentLoadingData(strategy))
    debug.log('Background Loading:', this.getBackgroundLoadingData(strategy))
    debug.log('On-Demand Only:', this.getOnDemandData(strategy))
  }
}

export const routeAwareInitialization = RouteAwareInitialization.getInstance()