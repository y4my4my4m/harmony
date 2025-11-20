/**
 * Composable to track and update user's current view context in ephemeral presence
 * This enables database-level notification suppression (Discord-like behavior)
 * Uses Supabase Realtime presence - completely ephemeral, no database table
 */

import { watch } from 'vue'
import { useRoute } from 'vue-router'
import { supabase } from '@/supabase'

let viewContextChannel: ReturnType<typeof supabase.channel> | null = null

/**
 * Get the view context presence channel (for use in other modules)
 */
export function getViewContextChannel() {
  return viewContextChannel
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

      viewContextChannel = supabase.channel(`view-context:${userId}`)
        .on('presence', { event: 'sync' }, () => {
          console.log('🔄 View context presence synced')
        })
        .subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            console.log('✅ View context presence channel subscribed')
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

    // Sync to database table so PostgreSQL functions can check it (for database-level notification suppression)
    const { error: syncError } = await supabase.rpc('sync_view_context_from_presence', {
      p_view_type: viewType,
      p_server_id: serverId || null,
      p_channel_id: channelId || null,
      p_conversation_id: conversationId || null
    })

    if (syncError) {
      console.error('Failed to sync view context to database:', syncError)
    } else {
      console.log('✅ View context updated in presence and synced to database:', { viewType, serverId, channelId, conversationId })
    }
  } catch (error) {
    console.error('Error updating view context:', error)
  }
}

/**
 * Composable to automatically track view context based on route
 */
export function useViewContextTracking() {
  const route = useRoute()

  // Watch for route changes and update view context in presence
  watch(
    () => [route.name, route.params.serverId, route.params.channelId, route.params.conversationId],
    ([routeName, serverId, channelId, conversationId]) => {
      if (routeName === 'ChatChannel' && serverId && channelId) {
        updateViewContext('server_channel', serverId as string, channelId as string)
      } else if (routeName === 'DMConversation' && conversationId) {
        updateViewContext('dm', undefined, undefined, conversationId as string)
      } else if (routeName?.toString().startsWith('Social')) {
        updateViewContext('activitypub_home')
      } else {
        updateViewContext('home')
      }
    },
    { immediate: true }
  )
}

