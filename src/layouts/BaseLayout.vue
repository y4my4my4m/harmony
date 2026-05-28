<template>
  <!-- Loading Screen -->
  <div v-if="!isAppReady" class="loading-overlay">
    <div class="loading-spinner-container">
      <div class="loading-spinner"></div>
      <p>Loading Harmony...</p>
    </div>
  </div>
  
  <!-- Main Layout -->
  <div v-else class="base-layout" :class="{ 
    'sidebar-open': leftSidebarOpen, 
    'profile-open': rightSidebarOpen,
    'is-dragging': isDragging
  }">
    <!-- Mobile Overlay Backdrop -->
    <div 
      v-if="isMobile && (leftSidebarOpen || rightSidebarOpen || isDragging)" 
      class="mobile-overlay"
      :style="overlayStyle"
      @click="closeMobileSidebars"
    ></div>
    
    <!-- Edge Swipe Indicators -->
    <div v-if="isMobile && isAppReady" class="edge-indicators">
      <div class="edge-indicator left" :class="{ active: touchState.isEdgeSwipe && touchState.startX <= 30 }"></div>
      <div class="edge-indicator right" :class="{ active: touchState.isEdgeSwipe && touchState.startX >= windowWidth - 30 }"></div>
    </div>
    
    <!-- Server List Sidebar (Always Visible) -->
    <div 
      class="server-sidebar-container"
      :class="{ 'is-dragging': isDragging && dragDirection === 'left' }"
      :style="serverSidebarDragStyle"
    >
      <!-- TODO: fix for mobile -->

      <!-- Mobile Profile Component -->
      <div 
        v-if="isMobile"
        class="user-profile-section"
      >
        <Teleport :to="mobileProfileOpen ? '#app' : undefined" :disabled="!mobileProfileOpen">
          <div 
            :class="{ 'mobile-profile-overlay': mobileProfileOpen }"
            @click="mobileProfileOpen ? closeMobileSidebars() : null"
          >
            <UserProfileComponent 
              :toggle-mobile-profile="toggleMobileProfile" 
              @click.stop
            />
          </div>
        </Teleport>
      </div>
      <ServerSidebar
        :servers="servers"
        @showPublicServers="$emit('showPublicServers')"
        @switch-to-activitypub="$emit('switchToActivityPub')"
        @switch-to-chat="$emit('switchToChat')"
      />
    </div>
    
    <!-- Content Area with Nested Router View -->
    <div class="content-area">
      <RouterView 
        :left-sidebar-open="leftSidebarOpen"
        :right-sidebar-open="rightSidebarOpen"
        :is-mobile="isMobile"
        :voice-panel-open="voicePanelOpen"
        :is-d-m="isDMRoute"
        :is-dragging="isDragging"
        :drag-direction="dragDirection"
        :left-sidebar-drag-offset="leftSidebarDragOffset"
        :right-sidebar-drag-offset="rightSidebarDragOffset"
        @toggle-left-sidebar="toggleLeftSidebar"
        @toggle-right-sidebar="toggleRightSidebar"
        @showPublicServers="$emit('showPublicServers')"
      />
    </div>

    <!-- User Profile at Bottom (desktop only; mobile uses server rail above) -->
    <div v-if="!isMobile" class="user-profile-section">
      <UserProfileComponent />
    </div>
    
    <!-- Global Incoming Call Modal (ALWAYS rendered, shows based on prop) -->
    <IncomingCallModal
      :show="showGlobalIncomingCall"
      :caller-id="globalIncomingCallData?.callerId || ''"
      :caller-name="globalIncomingCallData?.callerName || 'Unknown'"
      :caller-avatar="globalIncomingCallData?.callerAvatar || '/default_avatar.webp'"
      :call-type="globalIncomingCallData?.callType || 'voice'"
      :conversation-id="globalIncomingCallData?.conversationId || ''"
      @accept="handleGlobalCallAccept"
      @decline="handleGlobalCallDecline"
    />
    
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { debug } from '@/utils/debug'
import { useRoute, useRouter } from 'vue-router'
import ServerSidebar from '@/components/ServerSidebar.vue'
import UserProfileComponent from '@/components/UserProfileComponent.vue'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useAuthStore } from '@/stores/auth'
import { useProfileStore } from '@/stores/useProfile'
import { useMobileGestures } from '@/composables/useMobileGestures'
import { useLayoutState } from '@/composables/useLayoutState'
import { useTimelineSwipe } from '@/composables/useTimelineSwipe'
import { routeAwareInitialization } from '@/services/RouteAwareInitialization'
import { supabase } from '@/supabase'
import { globalDMCallListener } from '@/services/GlobalDMCallListener'
import IncomingCallModal from '@/components/dm/IncomingCallModal.vue'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { dmCallSignaling } from '@/services/DMCallSignaling'
import { realtimeConnectionManager } from '@/services/RealtimeConnectionManager'

// Stores and Router
const serverChannelStore = useServerChannelStore()
const authStore = useAuthStore()
const profileStore = useProfileStore()
const voiceStore = useUnifiedVoiceChannelStore()
const route = useRoute()
const router = useRouter()

// Composables
const { touchState, handleTouchStart, handleTouchMove, handleTouchEnd } = useMobileGestures()
const { 
  leftSidebarOpen, 
  rightSidebarOpen, 
  isMobile, 
  voicePanelOpen,
  mobileProfileOpen,
  isDragging,
  dragDirection,
  leftSidebarDragOffset,
  rightSidebarDragOffset,
  serverSidebarDragStyle,
  SIDEBAR_WIDTH,
  toggleLeftSidebar,
  toggleRightSidebar,
  // eslint-disable-next-line unused-imports/no-unused-vars
  toggleVoicePanel,
  toggleMobileProfile,
  closeMobileSidebars,
  startDrag,
  updateDragOffset,
  endDragWithVelocity,
  cancelDrag
} = useLayoutState()

// Timeline swipe navigation for ActivityPub (used by global gesture handlers)
const {
  currentIndex: timelineIndex,
  navigateTo: timelineNavigateTo,
} = useTimelineSwipe({
  isMobile: () => isMobile.value,
  leftSidebarOpen: () => leftSidebarOpen.value,
  rightSidebarOpen: () => rightSidebarOpen.value,
  toggleLeftSidebar,
  toggleRightSidebar,
})

// Global call state (reactive references from the global listener)
const showGlobalIncomingCall = globalDMCallListener.showIncomingCallModal
const globalIncomingCallData = globalDMCallListener.incomingCall


// Emit events
// eslint-disable-next-line unused-imports/no-unused-vars
const emit = defineEmits<{
  showPublicServers: []
  switchToActivityPub: []
  switchToChat: []
}>()

// State - Initialize refs properly
const isAppInitialized = ref(false)
const hasServersLoaded = ref(false)

// Computed - Safely access ref values
const isAppReady = computed(() => {
  try {
    return isAppInitialized.value === true && hasServersLoaded.value === true
  } catch (error) {
    debug.error('Error accessing isAppInitialized or hasServersLoaded:', error)
    return false
  }
})

// Detect if we're on a DM route
const isDMRoute = computed(() => {
  return route.path.startsWith('/dm')
})
const servers = computed(() => serverChannelStore.servers)
const windowWidth = computed(() => typeof window !== 'undefined' ? window.innerWidth : 768)

// Dynamic overlay opacity during drag
const overlayStyle = computed(() => {
  if (!isDragging.value) return {}
  
  const offset = dragDirection.value === 'left' 
    ? leftSidebarDragOffset.value 
    : rightSidebarDragOffset.value
  const progress = offset / SIDEBAR_WIDTH
  
  return {
    opacity: progress * 0.6,
    transition: 'none'
  }
})

// Global call handlers
const handleGlobalCallAccept = async (acceptWithVideo: boolean) => {
  const incomingCall = globalDMCallListener.incomingCall.value
  if (!incomingCall) return

  if (!authStore.session?.user?.id) return

  // Optimistic UI: dismiss the incoming-call sheet immediately and let
  // the voice overlay (which already reacts to `voiceStore.isConnecting`)
  // show the joining state while the accept signal + LiveKit join run.
  // Without this the user sits on a frozen "Incoming call" UI for the
  // full server round-trip.
  globalDMCallListener.dismissIncomingCall()
  voiceStore.isOverlayVisible = true

  // BUGS.md Pattern A: `dmCallSignaling.acceptCall` / `declineCall` and the
  // signaling channel all key participants on PROFILE ids (every other site
  // uses `authContextService.getCurrentProfileId()`). Passing the auth UUID
  // here corrupts `activeCalls.participants` and breaks teardown.
  let currentUserId: string
  try {
    const { authContextService } = await import('@/services/AuthContextService')
    currentUserId = await authContextService.getCurrentProfileId()
  } catch (err) {
    debug.error('Failed to resolve profile id for call accept:', err)
    voiceStore.isOverlayVisible = false
    return
  }

  try {
    if (incomingCall.isFederated && incomingCall.callerFederatedId) {
      // Federated call: accept via ActivityPub and join remote LiveKit room
      debug.log('📞 [Federated] Accepting federated call from:', incomingCall.callerFederatedId)

      await dmCallSignaling.acceptFederatedCall(
        incomingCall.conversationId,
        currentUserId,
        incomingCall.callerFederatedId
      )

      // Navigate to the DM conversation
      await router.push(`/dm/${incomingCall.conversationId}`)

      // Join the caller's LiveKit room using the room name from the invite
      const roomName = incomingCall.roomName
      if (roomName) {
        const success = await voiceStore.joinVoiceChannel(roomName, 'dm')

        if (success) {
          if (acceptWithVideo) {
            await voiceStore.toggleVideo()
          }
          await new Promise(resolve => setTimeout(resolve, 100))
          debug.log('✅ [Federated] Joined federated call')
        } else {
          voiceStore.isOverlayVisible = false
        }
      } else {
        voiceStore.isOverlayVisible = false
        debug.error('❌ [Federated] No room name available for federated call')
      }
    } else {
      // Local call: use Supabase Realtime signaling
      await dmCallSignaling.acceptCall(incomingCall.conversationId, currentUserId)

      await router.push(`/dm/${incomingCall.conversationId}`)

      const dmChannelId = `dm-${incomingCall.conversationId}`
      const success = await voiceStore.joinVoiceChannel(dmChannelId, 'dm')

      if (success) {
        if (acceptWithVideo) {
          await voiceStore.toggleVideo()
        }
        await new Promise(resolve => setTimeout(resolve, 100))
        debug.log('✅ Joined call with maximized voice overlay')
      } else {
        voiceStore.isOverlayVisible = false
      }
    }
  } catch (error) {
    debug.error('Error accepting call:', error)
    voiceStore.isOverlayVisible = false
  }
}

const handleGlobalCallDecline = async () => {
  const incomingCall = globalDMCallListener.incomingCall.value
  if (!incomingCall) return

  if (!authStore.session?.user?.id) return

  // Same Pattern A fix as handleGlobalCallAccept.
  let currentUserId: string
  try {
    const { authContextService } = await import('@/services/AuthContextService')
    currentUserId = await authContextService.getCurrentProfileId()
  } catch (err) {
    debug.error('Failed to resolve profile id for call decline:', err)
    return
  }

  try {
    if (incomingCall.isFederated && incomingCall.callerFederatedId) {
      // Federated call: decline via ActivityPub
      await dmCallSignaling.declineFederatedCall(
        incomingCall.conversationId,
        currentUserId,
        incomingCall.callerFederatedId
      )
    } else {
      // Local call: decline via Supabase Realtime
      await dmCallSignaling.declineCall(incomingCall.conversationId, currentUserId)
    }
  } catch (error) {
    debug.error('Error declining call:', error)
  } finally {
    globalDMCallListener.dismissIncomingCall()
  }
}

// ---------------------------------------------------------------------------
// PWA cold-boot resilience
// ---------------------------------------------------------------------------
// When Chrome launches the PWA on OS boot, the network often isn't fully up
// yet. The initial `initializeApp()` call can succeed at auth (Supabase reads
// session from localStorage synchronously) but fail at the server-list fetch,
// leaving us authenticated with no servers loaded. Without these retry
// helpers, that state is sticky: the auth watcher only fires on null→set,
// so nothing ever re-triggers initialization. We retry on the most likely
// recovery signals (network coming back online, tab regaining focus) and as
// a one-shot fallback timer in case neither fires (navigator.onLine can be
// true the whole time even when individual requests fail).
let initInFlight = false
let initRetryTimer: ReturnType<typeof setTimeout> | null = null

const cancelInitRetryTimer = () => {
  if (initRetryTimer) {
    clearTimeout(initRetryTimer)
    initRetryTimer = null
  }
}

const retryInitializationIfNeeded = async (reason: string) => {
  if (initInFlight) return
  // Only retry when we're authenticated but the server-list fetch never
  // completed. This keeps us a no-op for the success path and the
  // genuinely-logged-out path.
  if (!authStore.session?.user?.id) return
  if (serverChannelStore.hasInitialized) return
  debug.log(`🔁 BaseLayout: retrying app initialization (${reason})`)
  await initializeApp()
}

const scheduleInitRetry = (reason: string) => {
  cancelInitRetryTimer()
  initRetryTimer = setTimeout(() => {
    initRetryTimer = null
    void retryInitializationIfNeeded(reason)
  }, 2000)
}

const handleOnlineRetry = () => {
  void retryInitializationIfNeeded('window.online')
}

const handleVisibilityRetry = () => {
  if (typeof document === 'undefined') return
  if (document.visibilityState === 'visible') {
    void retryInitializationIfNeeded('visibilitychange')
  }
}

// ⚡ OPTIMIZED: Route-Aware App Initialization
// Only loads what's needed for the current route instead of everything
const initializeApp = async () => {
  if (initInFlight) {
    debug.log('⏭️ BaseLayout: initializeApp already running, skipping duplicate call')
    return
  }
  initInFlight = true
  cancelInitRetryTimer()
  try {
    // Auth is already initialized in main.ts before mount, so session should be ready
    // But add a small safety delay in case of race conditions
    if (!authStore.session) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    const userId = authStore.session?.user?.id
    if (!userId) {
      isAppInitialized.value = true
      hasServersLoaded.value = true
      return
    }
    
    // Wait for router to be ready so we get the correct route
    await router.isReady()
    
    // Determine what to load based on current route
    const loadingStrategy = routeAwareInitialization.getLoadingStrategy(route)
    
    // ✅ PERFORMANCE: Load minimum data needed to show UI, then mark as ready
    // This allows the UI to appear immediately while other data loads in background
    
    // Load user environment (servers list) - CRITICAL for navigation
    await serverChannelStore.initializeUserEnvironment(userId)
    
    // ✅ CRITICAL: Load profile FIRST, then initialize userData with full profile data
    // This ensures avatar, color, banner, and status are all available immediately
    await profileStore.fetchProfileByAuthUserId(userId).catch(err => {
      debug.warn('⚠️ Profile fetch failed:', err)
    })
    
    // Initialize userData with full profile data (or fallback to auth data if profile not found)
    const { useUserData } = await import('@/composables/useUserData')
    
    // Defensive check: ensure useUserData is a function
    if (typeof useUserData !== 'function') {
      debug.error('❌ useUserData is not a function:', typeof useUserData, useUserData)
      throw new Error(`useUserData is not a function, got: ${typeof useUserData}`)
    }
    
    const userData = useUserData()
    
    // Defensive check: ensure userData has initialize method
    if (!userData || typeof userData.initialize !== 'function') {
      debug.error('❌ userData.initialize is not a function:', typeof userData?.initialize, userData)
      throw new Error(`userData.initialize is not a function, got: ${typeof userData?.initialize}`)
    }
    
    // Use profile data if available, otherwise fallback to auth session data
    const userProfile = profileStore.profile || {
      id: userId,
      username: authStore.session?.user?.user_metadata?.username || authStore.session?.user?.email?.split('@')[0] || 'User',
      display_name: authStore.session?.user?.user_metadata?.display_name,
      avatar_url: authStore.session?.user?.user_metadata?.avatar_url,
      color: undefined,
      banner_url: undefined,
      status: undefined
    }
    
    // Initialize userData with full profile data (includes avatar, color, banner, status)
    // Double-check that initialize is still a function before calling
    if (typeof userData?.initialize !== 'function') {
      debug.error('❌ userData.initialize is not a function before call:', typeof userData?.initialize, userData)
      throw new Error(`userData.initialize is not a function before call, got: ${typeof userData?.initialize}`)
    }
    
    try {
      await userData.initialize(
        userId,
        userProfile.username || userProfile.display_name || 'User',
        userProfile.avatar_url,
        userProfile
      )
    } catch (err) {
      debug.warn('⚠️ UserData initialization failed:', err)
      // Don't throw - allow app to continue even if userData init fails
    }
    
    debug.log('✅ UserData initialized with profile data (avatar, color, banner, status should all be available)')
    
    // Mark app as ready NOW - userData is initialized with full profile data
    hasServersLoaded.value = true;
    isAppInitialized.value = true;
    
    // Continue loading other data in background (non-blocking)
    (async () => {
      try {
        // Verify userData is still valid before using it in background
        if (!userData || typeof userData !== 'object') {
          debug.error('❌ userData is invalid in background function:', typeof userData, userData)
          return
        }
        
        // Initialize server users store integration
        const { useServerUsersStore } = await import('@/stores/useServerUsers')
        const serverUsersStore = useServerUsersStore()
        serverUsersStore.initializeUserDataIntegration()
        
        // Step 3: Load route-specific data (needs userData)
        await initializeRouteSpecificData(userId, loadingStrategy, userData).catch(err => {
          debug.warn('⚠️ Background route data initialization failed:', err)
        })
      } catch (err) {
        debug.error('❌ Background initialization errors:', err)
      }
    })()
    
    // Attempt to reconnect to previous voice channel if user was in one (background)
    setTimeout(async () => {
      try {
        const { useUnifiedVoiceChannelStore } = await import('@/stores/unifiedVoiceChannel')
        const voiceStore = useUnifiedVoiceChannelStore()
        await voiceStore.reconnectToVoiceChannel()
      } catch (error) {
        debug.error('Failed to reconnect to voice channel:', error)
      }
    }, 500)
    
    // Background loading of non-critical data
    setTimeout(() => {
      initializeBackgroundData(userId, loadingStrategy)
    }, 100)
    
  } catch (error) {
    debug.error('❌ Failed to initialize app:', error)
    // PWA cold-boot race: when the OS launches the PWA before the network
    // is fully up, `initializeUserEnvironment` can throw and leave us with
    // a valid session but an empty server list. If we mark the app as
    // ready here, ChatLayout renders the false "join a server / create
    // a community" splash even though the user has servers. Instead,
    // keep the loading screen up and lean on the retry handlers below
    // (online / visibilitychange / one-shot timer) to re-attempt init
    // once the network is actually available. Only fall through to the
    // legacy "mark ready" behavior when there's no session to load for
    // (e.g. the user is genuinely logged out) so the router can take
    // over and send them to the login screen.
    if (authStore.session?.user?.id && !serverChannelStore.hasInitialized) {
      scheduleInitRetry('initial-failure')
      return
    }
    isAppInitialized.value = true
    hasServersLoaded.value = true
  } finally {
    initInFlight = false
  }
}

// 🎯 OPTIMIZED: Initialize only route-specific data and stores
const initializeRouteSpecificData = async (userId: string, strategy: any, userData: any) => {
  try {
    if (strategy.routeType === 'server-channel') {
      // Warm the chat-related stores in parallel; we only need the emoji cache
      // store instance directly below, the others register themselves.
      const [emojiCache] = await Promise.all([
        import('@/stores/useEmojiCache'),
        import('@/stores/useChat'),
        import('@/stores/useReactions'),
        import('@/stores/useTheme')
      ])

      const emojiCacheStore = emojiCache.useEmojiCacheStore()
      
      // Load current server presence only
      if (strategy.currentServerId) {
        const { getUserIdsForServer } = await import('@/services/usersService')
        const serverUserIds = await getUserIdsForServer(strategy.currentServerId)
        await userData.subscribeToContext(strategy.currentServerId, 'server', serverUserIds)
      }
      
      // Load current server emojis only (others load in background)
      const allServerIds = serverChannelStore.servers.map(server => server.id)
      const otherServerIds = allServerIds.filter(id => id !== strategy.currentServerId)
      
      if (strategy.currentServerId) {
        await emojiCacheStore.initializeSelective(
          [strategy.currentServerId],
          otherServerIds
        )
      }
    }
    
    else if (strategy.routeType === 'dm' || strategy.routeType === 'dm-list') {
      // Warm DM-related stores in parallel; only the cache and DM store
      // instances are used below.
      const [emojiCache, { useDMStore }] = await Promise.all([
        import('@/stores/useEmojiCache'),
        import('@/stores/useDM'),
        import('@/stores/useReactions'),
        import('@/stores/useTheme')
      ])

      const emojiCacheStore = emojiCache.useEmojiCacheStore()
      const dmStore = useDMStore()
      
      // Initialize minimal emoji support for DMs
      const allServerIds = serverChannelStore.servers.map(server => server.id)
      if (allServerIds.length > 0) {
        const defaultServerId = serverChannelStore.currentServerId || allServerIds[0]
        await emojiCacheStore.initializeSelective([defaultServerId], [])
      }
      
      // Initialize DM functionality
      if (strategy.routeType === 'dm' && strategy.currentConversationId) {
        await dmStore.initializeDMEnvironmentForDirectAccess(userId, strategy.currentConversationId)
      } else if (strategy.routeType === 'dm-list') {
        await dmStore.initializeDMEnvironment(userId, false, true, 'immediate')
      } else {
        await dmStore.initializeDMEnvironment(userId, false, false, 'partial')
      }
      
      // Subscribe to DM presence for specific conversations
      if (strategy.routeType === 'dm' && strategy.currentConversationId) {
        const conversationUserIds = dmStore.conversations
          .filter(conv => conv.type === 'direct' && conv.other_user)
          .map(conv => conv.other_user!.id)
          .filter(id => id !== userId)
        
        if (conversationUserIds.length > 0) {
          await userData.subscribeToDMPresence(conversationUserIds)
        }
      }
    }
    
    else if (strategy.routeType === 'social') {
      // Warm ActivityPub-related stores in parallel; only the cache and
      // ActivityPub store instances are used below.
      const [emojiCache, { useActivityPubStore }] = await Promise.all([
        import('@/stores/useEmojiCache'),
        import('@/stores/useActivityPub'),
        import('@/stores/useReactions'),
        import('@/stores/useTheme')
      ])

      const emojiCacheStore = emojiCache.useEmojiCacheStore()
      const activityPubStore = useActivityPubStore()
      
      // Load followed users for proper follow state
      await activityPubStore.loadFollowedUsers()
      
      // Initialize minimal emoji support for social features
      const allServerIds = serverChannelStore.servers.map(server => server.id)
      if (allServerIds.length > 0) {
        const defaultServerId = serverChannelStore.currentServerId || allServerIds[0]
        await emojiCacheStore.initializeSelective([defaultServerId], [])
      }
    }
    
    // MINIMAL STORES: For unknown/other routes, load only essentials
    else if (strategy.routeType === 'other' && serverChannelStore.servers.length > 0) {
      // Warm essential stores in parallel; only the cache is touched directly.
      const [emojiCache] = await Promise.all([
        import('@/stores/useEmojiCache'),
        import('@/stores/useReactions'),
        import('@/stores/useTheme')
      ])

      const emojiCacheStore = emojiCache.useEmojiCacheStore()
      
      // Load default server emojis
      const allServerIds = serverChannelStore.servers.map(server => server.id)
      const defaultServerId = serverChannelStore.currentServerId || allServerIds[0]
      const otherServerIds = allServerIds.filter(id => id !== defaultServerId)
      
      if (defaultServerId) {
        await emojiCacheStore.initializeSelective(
          [defaultServerId],
          otherServerIds
        )
      }
    }
    
    // BASELINE GLOBAL PRESENCE: Load users for cross-context online status
    // OPTIMIZED: For single DM views, only load current conversation participant(s)
    const baselineUserIds = new Set<string>()
    
    // For DM routes with a specific conversation, only load that conversation's participants initially
    const isSingleDMView = strategy.routeType === 'dm' && strategy.currentConversationId
    
    if (isSingleDMView) {
      // OPTIMIZED: Only load current conversation participant for single DM view
      try {
        const { data: participants } = await supabase
          .from('conversation_participants')
          .select('user_id')
          .eq('conversation_id', strategy.currentConversationId)
          .neq('user_id', userId)
          .is('left_at', null)
        
        if (participants) {
          participants.forEach(p => baselineUserIds.add(p.user_id))
        }
        
        // DEFER: Load other DM contacts in background (non-blocking)
        setTimeout(async () => {
          try {
            const { data: allParticipations } = await supabase
              .from('conversation_participants')
              .select('conversation_id')
              .eq('user_id', userId)
              .is('left_at', null)
              .limit(100)
            
            if (allParticipations && allParticipations.length > 0) {
              const conversationIds = allParticipations
                .map(p => p.conversation_id)
                .filter(id => id !== strategy.currentConversationId)
              
              if (conversationIds.length > 0) {
                const { data: otherParticipants } = await supabase
                  .from('conversation_participants')
                  .select('user_id')
                  .in('conversation_id', conversationIds)
                  .neq('user_id', userId)
                  .is('left_at', null)
                
                if (otherParticipants) {
                  const otherUserIds = otherParticipants.map(p => p.user_id)
                  await userData.ensureProfilesAvailable(otherUserIds)
                }
              }
            }
          } catch (error) {
            debug.warn('⚠️ Background DM contacts loading failed:', error)
          }
        }, 500) // Load other DM contacts after 500ms
      } catch (error) {
        debug.warn('⚠️ Failed to load current conversation participants:', error)
      }
    } else {
      // Not a single DM view - load all users normally
    await Promise.all([
      // Fetch server users
      (async () => {
        const { getUserIdsForServers } = await import('@/services/usersService')
        const allServers = serverChannelStore.servers
        const serverIds = allServers.map(s => s.id)
        try {
          const membersByServer = await getUserIdsForServers(serverIds)
          for (const [, userIds] of membersByServer) {
            userIds.forEach(id => baselineUserIds.add(id))
          }
        } catch (error) {
          debug.warn('⚠️ Failed to batch-load server members:', error)
        }
      })(),
      
        // Fetch DM contacts (only for non-DM routes or DM list view)
      (async () => {
          if (strategy.routeType !== 'dm') {
        try {
          const { data: participations } = await supabase
            .from('conversation_participants')
            .select('conversation_id')
            .eq('user_id', userId)
            .is('left_at', null)
            .limit(100)
          
          if (participations && participations.length > 0) {
            const conversationIds = participations.map(p => p.conversation_id)
            
            const { data: otherParticipants } = await supabase
              .from('conversation_participants')
              .select('user_id')
              .in('conversation_id', conversationIds)
              .neq('user_id', userId)
              .is('left_at', null)
            
            if (otherParticipants) {
              otherParticipants.forEach(p => baselineUserIds.add(p.user_id))
            }
          }
        } catch (error) {
          debug.warn('⚠️ Failed to load DM contacts for global presence:', error)
            }
        }
      })()
    ])
    }
    
    // Load baseline user data for global presence (minimal profile info)
    if (baselineUserIds.size > 0) {
      await userData.ensureProfilesAvailable(Array.from(baselineUserIds))
    }
    
  } catch (error) {
    debug.error('❌ Failed to initialize route-specific data:', error)
  }
}

// Background loading of non-critical data
const initializeBackgroundData = async (userId: string, _strategy: any) => {
  try {
    // Register global conversation broadcast handlers (new conversations + metadata updates)
    const { useDMStore } = await import('@/stores/useDM')
    const dmStore = useDMStore()
    await dmStore.registerGlobalBroadcastHandlers(userId)

    // Load only notification count initially (not full list)
    const { useNotificationStore } = await import('@/stores/useNotification')
    const notificationStore = useNotificationStore()
    await notificationStore.initializeUnreadCountOnly(userId)
    
    // Move activity tracking to background
    const { useUserData } = await import('@/composables/useUserData')
    const userData = useUserData()
    await userData.initializeBackgroundFeatures()
    
    // Initialize session heartbeat for smart push notifications (Discord-like behavior)
    const { initializeSessionHeartbeat } = await import('@/composables/useViewContext')
    await initializeSessionHeartbeat(userId)
    
    // Initialize typing indicator service
    const typingService = await import('@/services/TypingIndicatorService')
    await typingService.typingIndicatorService.initialize()
  } catch (error) {
    debug.error('❌ Background loading failed:', error)
  }
}



// Initialize global call listener when user logs in
watch(() => authStore.session?.user?.id, async (userId) => {
  if (userId && !globalDMCallListener.isInitialized()) {
    await globalDMCallListener.initialize(userId)
  }
}, { immediate: true })

// Watch for auth changes to reinitialize
watch(() => authStore.session, async (newSession, oldSession) => {
  // If user just logged in (had no session, now has one)
  if (!oldSession && newSession) {
    await initializeApp()
  }
  // If user logged out (had session, now doesn't)
  else if (oldSession && !newSession) {
    
    // Clean up user data service and all presence subscriptions
    try {
      const { userDataService } = await import('@/services/userDataService')
      await userDataService.cleanup()
      debug.log('✅ Global presence cleanup completed')
    } catch (error) {
      debug.error('Failed to cleanup user data:', error)
    }
    
    // ✅ PERFORMANCE FIX: Cleanup state persistence
    try {
      const { statePersistence } = await import('@/services/StatePersistence')
      await statePersistence.cleanup()
      debug.log('✅ State persistence cleanup completed')
    } catch (error) {
      debug.error('Failed to cleanup state persistence:', error)
    }
    
    // Cleanup session heartbeat (stops push notification tracking)
    try {
      const { cleanupViewContext } = await import('@/composables/useViewContext')
      await cleanupViewContext()
      
      // Cleanup typing indicator service
      const typingService = await import('@/services/TypingIndicatorService')
      await typingService.typingIndicatorService.cleanup()
      debug.log('✅ Session heartbeat cleanup completed')
    } catch (error) {
      debug.error('Failed to cleanup session heartbeat:', error)
    }
    
    // Cleanup global call listener
    globalDMCallListener.cleanup()
    
    isAppInitialized.value = false
    hasServersLoaded.value = false
  }
})

// 🔥 CRITICAL FIX: Watch for route changes and refresh global presence
// This ensures users remain visible globally when navigating between different contexts
// Debounced to prevent excessive calls during rapid navigation
let presenceRefreshTimeout: ReturnType<typeof setTimeout> | null = null
const PRESENCE_REFRESH_DEBOUNCE_MS = 500

watch(() => route.name, async (newRouteName, oldRouteName) => {
  if (newRouteName !== oldRouteName && isAppInitialized.value && authStore.session?.user?.id) {
    // Clear any pending refresh
    if (presenceRefreshTimeout) {
      clearTimeout(presenceRefreshTimeout)
    }
    
    // Debounce presence refresh to prevent excessive calls during rapid navigation
    presenceRefreshTimeout = setTimeout(async () => {
      try {
        const { useUserData } = await import('@/composables/useUserData')
        const userData = useUserData()
        await userData.refreshGlobalPresence()
      } catch (error) {
        debug.error('Failed to refresh global presence:', error)
      }
    }, PRESENCE_REFRESH_DEBOUNCE_MS)
  }
})

// Track previous route type to detect cross-context navigation
let previousRouteType: string | null = null

// Route-aware store initialization when navigating between different contexts
// e.g., from /chat to /dm, from /social to /dm, etc.
watch(() => route.path, async (newPath) => {
  if (!isAppInitialized.value || !authStore.session?.user?.id) return
  
  const userId = authStore.session.user.id
  const newStrategy = routeAwareInitialization.getLoadingStrategy(route)
  
  // Skip if same route type (already initialized)
  if (previousRouteType === newStrategy.routeType) return
  
  debug.log('🔄 Route context changed:', { from: previousRouteType, to: newStrategy.routeType, path: newPath })
  previousRouteType = newStrategy.routeType
  
  // Initialize stores for the new route context
  if (newStrategy.routeType === 'dm' || newStrategy.routeType === 'dm-list') {
    try {
      const { useDMStore } = await import('@/stores/useDM')
      const dmStore = useDMStore()
      
      // Check if DM store needs initialization
      if (dmStore.conversations.length === 0) {
        debug.log('📬 Initializing DM store for navigation to:', newPath)
        
        if (newStrategy.routeType === 'dm' && newStrategy.currentConversationId) {
          await dmStore.initializeDMEnvironmentForDirectAccess(userId, newStrategy.currentConversationId)
        } else {
          await dmStore.initializeDMEnvironment(userId, false, true, 'immediate')
        }
      }
    } catch (error) {
      debug.error('Failed to initialize DM store on navigation:', error)
    }
  }
})

// ===== NATIVE MOBILE GESTURE HANDLERS =====

const wrappedTouchStart = (event: TouchEvent) => {
  handleTouchStart(event, isMobile.value)
}

const wrappedTouchMove = (event: TouchEvent) => {
  const hasOpenSidebars = leftSidebarOpen.value || rightSidebarOpen.value
  const isActivityPubTimeline = route.path.startsWith('/social') && timelineIndex.value >= 0

  handleTouchMove(event, isMobile.value, hasOpenSidebars, {
    onSwipeRight: () => {},
    onSwipeLeft: () => {},
    onDragStart: (direction) => {
      if (isActivityPubTimeline && !hasOpenSidebars) return
      debug.log('📱 Drag started:', direction)
      startDrag(direction)
    },
    onDragMove: (deltaX, direction) => {
      if (isActivityPubTimeline && !hasOpenSidebars) return
      updateDragOffset(deltaX, direction)
    }
  })
}

const wrappedTouchEnd = (event: TouchEvent) => {
  const isActivityPub = route.path.startsWith('/social')
  const isOnTimeline = isActivityPub && timelineIndex.value >= 0

  handleTouchEnd(event, isMobile.value, {
    onSwipeRight: () => {
      if (isDragging.value) return
      if (isOnTimeline) {
        timelineNavigateTo('right')
      } else if (!isActivityPub) {
        debug.log('🔄 Quick swipe right, opening left sidebar')
        toggleLeftSidebar()
      } else {
        toggleLeftSidebar()
      }
    },
    onSwipeLeft: () => {
      if (isDragging.value) return
      if (isOnTimeline) {
        timelineNavigateTo('left')
      } else if (!isActivityPub) {
        debug.log('🔄 Quick swipe left, opening right sidebar')
        toggleRightSidebar()
      } else {
        toggleRightSidebar()
      }
    },
    onDragEnd: (velocity, direction) => {
      if (isOnTimeline && !leftSidebarOpen.value && !rightSidebarOpen.value) {
        // velocity is positive when finger moved right, negative when left
        const swipeDirection = velocity > 0 ? 'right' : 'left'
        timelineNavigateTo(swipeDirection)
        cancelDrag()
        return
      }
      debug.log('📱 Drag ended:', { velocity, direction })
      endDragWithVelocity(velocity, direction)
    }
  })
}

// Mobile touch handlers
onMounted(() => {
  // Initialize RealtimeConnectionManager for reliable websocket connections
  realtimeConnectionManager.initialize()
  
  if (typeof window !== 'undefined') {
    window.addEventListener('touchstart', wrappedTouchStart, { passive: true })
    window.addEventListener('touchmove', wrappedTouchMove, { passive: false }) // Changed to false to allow preventDefault
    window.addEventListener('touchend', wrappedTouchEnd, { passive: true })
    // PWA cold-boot recovery: retry app initialization when the network
    // comes back online or when the user brings the tab back into focus.
    // These are no-ops in the normal success path.
    window.addEventListener('online', handleOnlineRetry)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityRetry)
  }
  
  initializeApp()
})

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('touchstart', wrappedTouchStart)
    window.removeEventListener('touchmove', wrappedTouchMove)
    window.removeEventListener('touchend', wrappedTouchEnd)
    window.removeEventListener('online', handleOnlineRetry)
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityRetry)
  }
  cancelInitRetryTimer()
  
  // Cleanup global call listener
  globalDMCallListener.cleanup()
  
  // Cleanup realtime connection manager
  realtimeConnectionManager.cleanup()
})
</script>

<style scoped>
.loading-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--background-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.base-layout {
  width: 100%;
  height: 100vh;
  display: flex;
  background: var(--background-primary);
  position: relative;
  overflow: hidden;
}

.mobile-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 199;
  backdrop-filter: blur(4px);
  transition: opacity 0.3s cubic-bezier(0.32, 0.72, 0, 1);
}

/* Disable transition during drag */
.base-layout.is-dragging .mobile-overlay {
  transition: none;
}

.edge-indicators {
  position: fixed;
  top: 0;
  bottom: 0;
  width: 100%;
  height: 100vh;
  pointer-events: none;
  z-index: 300;
}

.edge-indicator {
  position: absolute;
  width: 4px;
  height: 100vh;
  background: var(--harmony-primary);
  opacity: 0;
  transition: opacity 0.15s ease;
}

.edge-indicator.left {
  left: 0;
  border-radius: 0 4px 4px 0;
}

.edge-indicator.right {
  right: 0;
  border-radius: 4px 0 0 4px;
}

.edge-indicator.active {
  opacity: 0.6;
}

.server-sidebar-container {
  width: 72px;
  flex-shrink: 0;
  background: var(--background-tertiary);
  z-index: 100;
  padding-top: 26px;
  will-change: transform;
}

.content-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.user-profile-section {
  position: absolute;
  left: 10px;
  bottom: 10px;
  width: 72px;
  z-index: 101;
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .base-layout.sidebar-open .server-sidebar-container {
    transform: translateX(0);
  }
  
  .server-sidebar-container {
    position: fixed;
    top: 0;
    left: 0;
    height: 100vh;
    z-index: 200;
    transform: translateX(-100%);
    padding-top: 0;
    /* Native-feeling spring animation on release */
    transition: transform 0.35s cubic-bezier(0.32, 0.72, 0, 1);
  }

  /* Disable transition during active drag */
  .server-sidebar-container.is-dragging {
    transition: none !important;
  }

  .mobile-profile-overlay {
    position: fixed;
    bottom: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.3);
    z-index: 9999;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding-bottom: 10px;
    box-sizing: border-box;
  }
  .user-profile-section {
    position: absolute;
    left: 6px;
    bottom: 10px;
    width: 64px;
    z-index: 101;
    margin: 0 auto;
    display: flex;
    justify-content: center;
    align-items: center;
  }
}
</style>
