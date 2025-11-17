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
    'profile-open': rightSidebarOpen 
  }">
    <!-- Mobile Overlay Backdrop -->
    <div 
      v-if="isMobile && (leftSidebarOpen || rightSidebarOpen)" 
      class="mobile-overlay"
      @click="closeMobileSidebars"
    ></div>
    
    <!-- Edge Swipe Indicators -->
    <div v-if="isMobile && isAppReady" class="edge-indicators">
      <div class="edge-indicator left" :class="{ active: touchState.isEdgeSwipe && touchState.startX <= 25 }"></div>
      <div class="edge-indicator right" :class="{ active: touchState.isEdgeSwipe && touchState.startX >= windowWidth - 25 }"></div>
    </div>
    
    <!-- Server List Sidebar (Always Visible) -->
    <div class="server-sidebar-container">
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
        @toggle-left-sidebar="toggleLeftSidebar"
        @toggle-right-sidebar="toggleRightSidebar"
        @toggle-voice-panel="toggleVoicePanel"
        @showPublicServers="$emit('showPublicServers')"
      />
    </div>

    <!-- User Profile at Bottom -->
    <!-- TODO: fix for mobile -->
    <div v-if="!isMobile" class="user-profile-section">
      <UserProfileComponent />
    </div>
    
    <!-- Global Incoming Call Modal (ALWAYS rendered, shows based on prop) -->
    <IncomingCallModal
      :show="showGlobalIncomingCall"
      :caller-id="globalIncomingCallData?.callerId || ''"
      :caller-name="globalIncomingCallData?.callerName || 'Unknown'"
      :caller-avatar="globalIncomingCallData?.callerAvatar || '/default_avatar.png'"
      :call-type="globalIncomingCallData?.callType || 'voice'"
      :conversation-id="globalIncomingCallData?.conversationId || ''"
      @accept="handleGlobalCallAccept"
      @decline="handleGlobalCallDecline"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ServerSidebar from '@/components/ServerSidebar.vue'
import UserProfileComponent from '@/components/UserProfileComponent.vue'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useAuthStore } from '@/stores/auth'
import { useProfileStore } from '@/stores/useProfile'
import { useMobileGestures } from '@/composables/useMobileGestures'
import { useLayoutState } from '@/composables/useLayoutState'
import { routeAwareInitialization } from '@/services/RouteAwareInitialization'
import { supabase } from '@/supabase'
import { globalDMCallListener } from '@/services/GlobalDMCallListener'
import IncomingCallModal from '@/components/dm/IncomingCallModal.vue'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { dmCallSignaling } from '@/services/DMCallSignaling'
import { useDMStore } from '@/stores/useDM'

// Stores and Router
const serverChannelStore = useServerChannelStore()
const authStore = useAuthStore()
const profileStore = useProfileStore()
const dmStore = useDMStore()
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
  toggleLeftSidebar,
  toggleRightSidebar,
  toggleVoicePanel,
  toggleMobileProfile,
  closeMobileSidebars
} = useLayoutState()

// Global call state (reactive references from the global listener)
const showGlobalIncomingCall = globalDMCallListener.showIncomingCallModal
const globalIncomingCallData = globalDMCallListener.incomingCall


// Emit events
const emit = defineEmits<{
  showPublicServers: []
  switchToActivityPub: []
  switchToChat: []
}>()

// State
const isAppInitialized = ref(false)
const hasServersLoaded = ref(false)

// Computed
const isAppReady = computed(() => isAppInitialized.value && hasServersLoaded.value)
const servers = computed(() => serverChannelStore.servers)
const windowWidth = computed(() => typeof window !== 'undefined' ? window.innerWidth : 768)

// Global call handlers
const handleGlobalCallAccept = async (acceptWithVideo: boolean) => {
  const incomingCall = globalDMCallListener.incomingCall.value
  if (!incomingCall) return

  const currentUserId = authStore.session?.user?.id
  if (!currentUserId) return

  try {
    // Send accept signal
    await dmCallSignaling.acceptCall(incomingCall.conversationId, currentUserId)
    
    // Navigate to the DM conversation
    console.log('📞 Navigating to DM conversation:', incomingCall.conversationId)
    await router.push(`/dm/${incomingCall.conversationId}`)
    
    // Join the voice channel
    const dmChannelId = `dm-${incomingCall.conversationId}`
    const success = await voiceStore.joinVoiceChannel(dmChannelId, 'dm')
    
    if (success) {
      // Enable video if accepting with video
      if (acceptWithVideo) {
        await voiceStore.toggleVideo()
      }
      
      // Open voice overlay in MAXIMIZED mode (not dock)
      voiceStore.isOverlayVisible = true
      // Give it a moment to initialize, then ensure it's maximized
      await new Promise(resolve => setTimeout(resolve, 100))
      console.log('✅ Joined call with maximized voice overlay')
    }
  } catch (error) {
    console.error('Error accepting call:', error)
  } finally {
    globalDMCallListener.dismissIncomingCall()
  }
}

const handleGlobalCallDecline = async () => {
  const incomingCall = globalDMCallListener.incomingCall.value
  if (!incomingCall) return

  const currentUserId = authStore.session?.user?.id
  if (!currentUserId) return

  try {
    // Send decline signal
    await dmCallSignaling.declineCall(incomingCall.conversationId, currentUserId)
  } catch (error) {
    console.error('Error declining call:', error)
  } finally {
    globalDMCallListener.dismissIncomingCall()
  }
}

// ⚡ OPTIMIZED: Route-Aware App Initialization
// Only loads what's needed for the current route instead of everything
const initializeApp = async () => {
  try {
    // Wait for auth to be ready if session is null
    if (!authStore.session) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    const userId = authStore.session?.user?.id
    if (!userId) {
      isAppInitialized.value = true
      hasServersLoaded.value = true
      return
    }
    
    // Determine what to load based on current route
    const loadingStrategy = routeAwareInitialization.getLoadingStrategy(route)
    
    // Always load user environment (servers list) and profile - needed for navigation
    await serverChannelStore.initializeUserEnvironment(userId)
    await profileStore.fetchProfileByAuthUserId(userId)
    
    // Initialize core user data system
    const { useUserData } = await import('@/composables/useUserData')
    const userData = useUserData()
    
    const userProfile = profileStore.profile || {
      id: userId,
      username: authStore.session?.user?.user_metadata?.username || 'Unknown',
      display_name: authStore.session?.user?.user_metadata?.display_name,
      avatar_url: authStore.session?.user?.user_metadata?.avatar_url
    }
    
    // Pass already-loaded profile to avoid duplicate database query
    await userData.initialize(
      userId, 
      userProfile.username || userProfile.display_name || 'Unknown',
      userProfile.avatar_url,
      userProfile
    )
    
    // Initialize server users store integration
    const { useServerUsersStore } = await import('@/stores/useServerUsers')
    const serverUsersStore = useServerUsersStore()
    serverUsersStore.initializeUserDataIntegration()
    
    // Load route-specific data
    await initializeRouteSpecificData(userId, loadingStrategy, userData)
    
    // Ensure global presence is active regardless of current view
    await userData.refreshGlobalPresence()
    
    // Background loading of non-critical data
    setTimeout(() => {
      initializeBackgroundData(userId, loadingStrategy)
    }, 100)

    hasServersLoaded.value = true
    isAppInitialized.value = true
    
  } catch (error) {
    console.error('❌ Failed to initialize app:', error)
    isAppInitialized.value = true
    hasServersLoaded.value = true
  }
}

// 🎯 OPTIMIZED: Initialize only route-specific data and stores
const initializeRouteSpecificData = async (userId: string, strategy: any, userData: any) => {
  try {
    if (strategy.routeType === 'server-channel') {
      // Load stores needed for chat
      const [emojiCache, { useChatStore }, { useReactionsStore }, { useThemeStore }] = await Promise.all([
        import('@/stores/useEmojiCache'),
        import('@/stores/useChat'),
        import('@/stores/useReactions'),
        import('@/stores/useTheme')
      ])
      
      const emojiCacheStore = emojiCache.useEmojiCacheStore()
      const chatStore = useChatStore()
      const reactionsStore = useReactionsStore()
      const themeStore = useThemeStore()
      
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
      // Load stores needed for DMs
      const [emojiCache, { useDMStore }, { useReactionsStore }, { useThemeStore }] = await Promise.all([
        import('@/stores/useEmojiCache'),
        import('@/stores/useDM'),
        import('@/stores/useReactions'),
        import('@/stores/useTheme')
      ])
      
      const emojiCacheStore = emojiCache.useEmojiCacheStore()
      const dmStore = useDMStore()
      const reactionsStore = useReactionsStore()
      const themeStore = useThemeStore()
      
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
      // Load stores needed for ActivityPub/Social
      const [emojiCache, { useActivityPubStore }, { useReactionsStore }, { useThemeStore }] = await Promise.all([
        import('@/stores/useEmojiCache'),
        import('@/stores/useActivityPub'),
        import('@/stores/useReactions'),
        import('@/stores/useTheme')
      ])
      
      const emojiCacheStore = emojiCache.useEmojiCacheStore()
      const activityPubStore = useActivityPubStore()
      const reactionsStore = useReactionsStore()
      const themeStore = useThemeStore()
      
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
      // Load minimal essentials
      const [emojiCache, { useReactionsStore }, { useThemeStore }] = await Promise.all([
        import('@/stores/useEmojiCache'),
        import('@/stores/useReactions'),
        import('@/stores/useTheme')
      ])
      
      const emojiCacheStore = emojiCache.useEmojiCacheStore()
      const reactionsStore = useReactionsStore()
      const themeStore = useThemeStore()
      
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
    
    // BASELINE GLOBAL PRESENCE: Load users for cross-context online status in parallel
    const baselineUserIds = new Set<string>()
    
    // Parallelize server users and DM contacts fetching
    await Promise.all([
      // Fetch server users
      (async () => {
        const { getUserIdsForServer } = await import('@/services/usersService')
        const allServers = serverChannelStore.servers
        
        await Promise.all(allServers.map(async (server) => {
          try {
            const serverUserIds = await getUserIdsForServer(server.id)
            serverUserIds.forEach(id => baselineUserIds.add(id))
          } catch (error) {
            console.warn(`⚠️ Failed to load users for server ${server.id}:`, error)
          }
        }))
      })(),
      
      // Fetch DM contacts
      (async () => {
        try {
          // Get DM contacts using conversation_participants table
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
          console.warn('⚠️ Failed to load DM contacts for global presence:', error)
        }
      })()
    ])
    
    // Load baseline user data for global presence (minimal profile info)
    if (baselineUserIds.size > 0) {
      await userData.ensureProfilesAvailable(Array.from(baselineUserIds))
    }
    
  } catch (error) {
    console.error('❌ Failed to initialize route-specific data:', error)
  }
}

// Background loading of non-critical data
const initializeBackgroundData = async (userId: string, strategy: any) => {
  try {
    // Load only notification count initially (not full list)
    const { useNotificationStore } = await import('@/stores/useNotification')
    const notificationStore = useNotificationStore()
    await notificationStore.initializeUnreadCountOnly(userId)
    
    // Move activity tracking to background
    const { useUserData } = await import('@/composables/useUserData')
    const userData = useUserData()
    await userData.initializeBackgroundFeatures()
  } catch (error) {
    console.error('❌ Background loading failed:', error)
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
      console.log('✅ Global presence cleanup completed')
    } catch (error) {
      console.error('Failed to cleanup user data:', error)
    }
    
    // ✅ PERFORMANCE FIX: Cleanup state persistence
    try {
      const { statePersistence } = await import('@/services/StatePersistence')
      await statePersistence.cleanup()
      console.log('✅ State persistence cleanup completed')
    } catch (error) {
      console.error('Failed to cleanup state persistence:', error)
    }
    
    // Cleanup global call listener
    globalDMCallListener.cleanup()
    
    isAppInitialized.value = false
    hasServersLoaded.value = false
  }
})

// 🔥 CRITICAL FIX: Watch for route changes and refresh global presence
// This ensures users remain visible globally when navigating between different contexts
watch(() => route.name, async (newRouteName, oldRouteName) => {
  if (newRouteName !== oldRouteName && isAppInitialized.value && authStore.session?.user?.id) {
    console.log(`🌐 Route changed from ${String(oldRouteName)} to ${String(newRouteName)} - refreshing global presence`)
    try {
      const { useUserData } = await import('@/composables/useUserData')
      const userData = useUserData()
      await userData.refreshGlobalPresence()
      console.log('✅ Global presence refreshed on route change - user remains visible across contexts')
    } catch (error) {
      console.error('Failed to refresh global presence on route change:', error)
    }
  }
})

// Touch event wrappers that provide the required parameters
const wrappedTouchStart = (event: TouchEvent) => {
  handleTouchStart(event, isMobile.value)
}

const wrappedTouchMove = (event: TouchEvent) => {
  const hasOpenSidebars = leftSidebarOpen.value || rightSidebarOpen.value
  handleTouchMove(event, isMobile.value, hasOpenSidebars)
}

const wrappedTouchEnd = (event: TouchEvent) => {
  handleTouchEnd(event, isMobile.value, {
    onSwipeRight: () => {
      console.log('🔄 Edge swipe right detected, opening left sidebar')
      toggleLeftSidebar()
    },
    onSwipeLeft: () => {
      console.log('🔄 Edge swipe left detected, opening right sidebar')
      toggleRightSidebar()
    }
  })
}

// Mobile touch handlers
onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('touchstart', wrappedTouchStart, { passive: true })
    window.addEventListener('touchmove', wrappedTouchMove, { passive: false }) // Changed to false to allow preventDefault
    window.addEventListener('touchend', wrappedTouchEnd, { passive: true })
  }
  
  initializeApp()
})

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('touchstart', wrappedTouchStart)
    window.removeEventListener('touchmove', wrappedTouchMove)
    window.removeEventListener('touchend', wrappedTouchEnd)
  }
  
  // Cleanup global call listener
  globalDMCallListener.cleanup()
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
  opacity: 0.25;
  transition: opacity 0.3s ease;
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
  opacity: 0.8;
}

.server-sidebar-container {
  width: 72px;
  flex-shrink: 0;
  background: var(--background-tertiary);
  z-index: 100;
  padding-top: 26px;
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
    transition: transform 0.3s ease;
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
    align-items: center;
    justify-content: center;
  }
  .mobile-profile-overlay .user-profile-section {
    width: 100%;
    height: auto;
    padding: 10px;
    left: 0px;
    flex-direction: row;
    justify-content: space-between;
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