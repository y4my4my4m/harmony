/**
 * Composable to track and update user's current view context in ephemeral presence
 * This enables database-level notification suppression (Discord-like behavior)
 * Uses Supabase Realtime presence - completely ephemeral, no database table needed
 * 
 * Architecture:
 * - Frontend tracks view context in presence
 * - Database triggers read presence to suppress notifications for active contexts
 * - Session heartbeat syncs to DB for push notification smart delivery
 */

import { watch } from 'vue'
import { useRoute } from 'vue-router'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { viewContextTracker } from '@/services/ViewContextTracker'
import { sessionHeartbeat } from '@/services/SessionHeartbeat'

let viewContextChannel: ReturnType<typeof supabase.channel> | null = null
let currentUserId: string | null = null

/**
 * Get the view context presence channel (for use in other modules)
 */
export function getViewContextChannel() {
  return viewContextChannel
}

/**
 * Get current view context from presence state
 */
export function getCurrentViewContext() {
  return viewContextTracker.getCurrentContext()
}

/**
 * Update the user's current view context in ephemeral presence
 * Called when navigating to channels/DMs to suppress notifications
 */
export async function updateViewContext(
  viewType: 'server_channel' | 'dm' | 'activitypub_home' | 'settings' | 'home',
  serverId?: string,
  channelId?: string,
  conversationId?: string
): Promise<void> {
  try {
    // Initialize view context presence channel if needed
    if (!viewContextChannel) {
      const userId = (await supabase.auth.getUser()).data.user?.id
      if (!userId) return
      currentUserId = userId

      viewContextChannel = supabase.channel(`view-context:${userId}`)
        .on('presence', { event: 'sync' }, () => {
          debug.log('🔄 View context presence synced')
        })
        .subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            debug.log('✅ View context presence channel subscribed')
          }
        })
    }

    // Track current view context in ephemeral presence
    await viewContextChannel.track({
      view_type: viewType,
      server_id: serverId || null,
      channel_id: channelId || null,
      conversation_id: conversationId || null,
      updated_at: new Date().toISOString()
    })

    // Also update the local tracker for immediate client-side checks
    viewContextTracker.updateContext({
      view_type: viewType === 'activitypub_home' ? 'home' : viewType,
      server_id: serverId,
      channel_id: channelId,
      conversation_id: conversationId
    })

    // Update session heartbeat context for smart push notifications
    sessionHeartbeat.updateContext({
      serverId,
      channelId,
      conversationId
    })

    debug.log('✅ View context updated:', { viewType, serverId, channelId, conversationId })
  } catch (error) {
    debug.error('Error updating view context:', error)
  }
}

/**
 * Initialize session heartbeat for smart push notifications
 * Call this when user logs in
 */
export async function initializeSessionHeartbeat(userId: string): Promise<void> {
  await sessionHeartbeat.initialize(userId)
}

/**
 * Cleanup view context channel on logout
 */
export async function cleanupViewContext(): Promise<void> {
  if (viewContextChannel) {
    await supabase.removeChannel(viewContextChannel)
    viewContextChannel = null
    currentUserId = null
    viewContextTracker.reset()
  }
  
  // Stop session heartbeat
  await sessionHeartbeat.stop()
}

/**
 * Composable to automatically track view context based on route
 */
export function useViewContextTracking() {
  const route = useRoute()

  // ActivityPub route names (from router)
  const activityPubRoutes = [
    'Social', 'Monyverse', 'Explore', // Legacy routes
    'SocialHome', 'SocialLocal', 'SocialPublic', // Timeline routes
    'UserProfile', 'Followers', 'Following', // Profile routes
    'Lists', 'Notifications', 'Bookmarks', // Social feature routes
    'SocialTrending', 'SocialInstances', // Explore routes
    'PostView', 'PostDetail', 'ConversationThread' // Post routes
  ]

  // Watch for route changes and update view context in presence
  watch(
    () => [route.name, route.path, route.params.serverId, route.params.channelId, route.params.conversationId],
    ([routeName, routePath, serverId, channelId, conversationId]) => {
      const routeNameStr = routeName?.toString() || ''
      const routePathStr = routePath?.toString() || ''
      
      // Check for server channel
      if (routeNameStr === 'ChatChannel' && serverId && channelId) {
        updateViewContext('server_channel', serverId as string, channelId as string)
      } 
      // Check for DM conversation
      else if (routeNameStr === 'DMConversation' && conversationId) {
        updateViewContext('dm', undefined, undefined, conversationId as string)
      } 
      // Check for ActivityPub routes (by name or path)
      else if (activityPubRoutes.includes(routeNameStr) || routePathStr.startsWith('/social')) {
        updateViewContext('activitypub_home')
      } 
      // Default to home
      else {
        updateViewContext('home')
      }
    },
    { immediate: true }
  )
}

