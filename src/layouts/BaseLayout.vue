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
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import ServerSidebar from '@/components/ServerSidebar.vue'
import UserProfileComponent from '@/components/UserProfileComponent.vue'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useAuthStore } from '@/stores/auth'
import { useProfileStore } from '@/stores/useProfile'
import { useMobileGestures } from '@/composables/useMobileGestures'
import { useLayoutState } from '@/composables/useLayoutState'
import { routeAwareInitialization } from '@/services/RouteAwareInitialization'

// Stores and Router
const serverChannelStore = useServerChannelStore()
const authStore = useAuthStore()
const profileStore = useProfileStore()
const route = useRoute()

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

// ⚡ OPTIMIZED: Route-Aware App Initialization
// Only loads what's needed for the current route instead of everything
const initializeApp = async () => {
  try {
    // Wait for auth to be ready if session is null
    if (!authStore.session) {
      console.log('⏳ Waiting for authentication to initialize...')
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    const userId = authStore.session?.user?.id
    if (!userId) {
      console.log('👤 No user session found, app ready for login')
      isAppInitialized.value = true
      hasServersLoaded.value = true
      return
    }

    console.log('🚀 Initializing app for user:', userId)
    
    // 🎯 PHASE 1: Determine what to load based on current route
    const loadingStrategy = routeAwareInitialization.getLoadingStrategy(route)
    routeAwareInitialization.logStrategy(loadingStrategy)

    // 🎯 PHASE 2: Critical Path Loading (100ms) - Only essentials
    console.log('⚡ Phase 1: Critical path loading...')
    
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
    
    // ✅ PERFORMANCE FIX: Pass already-loaded profile to avoid duplicate database query
    await userData.initialize(
      userId, 
      userProfile.username || userProfile.display_name || 'Unknown',
      userProfile.avatar_url,
      userProfile // Pass the full profile to prevent duplicate loading
    )
    console.log('✅ User data system initialized')
    
    // Initialize server users store integration
    const { useServerUsersStore } = await import('@/stores/useServerUsers')
    const serverUsersStore = useServerUsersStore()
    serverUsersStore.initializeUserDataIntegration()
    
    // 🎯 PHASE 3: Content Loading (300ms) - Route-specific data
    console.log('📦 Phase 2: Content loading based on route...')
    
    // ✅ OPTIMIZED: Only load what's needed for current route
    await initializeRouteSpecificData(userId, loadingStrategy, userData)
    
    // 🎯 PHASE 4: Background Loading - Non-critical data
    console.log('🔄 Phase 3: Background loading...')
    setTimeout(() => {
      initializeBackgroundData(userId, loadingStrategy)
    }, 100) // Let UI render first

    hasServersLoaded.value = true
    isAppInitialized.value = true
    console.log('✅ App initialization complete - Route-optimized!')
    
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
      console.log('🏠 Loading server-channel route (chat, serverUsers, emojiCache, theme, reactions)...')
      
      // ✅ ROUTE-SPECIFIC STORES: Only load what's needed for chat
      const [emojiCache, { useChatStore }, { useReactionsStore }, { useThemeStore }] = await Promise.all([
        import('@/stores/useEmojiCache'),
        import('@/stores/useChat'),
        import('@/stores/useReactions'),
        import('@/stores/useTheme')
      ])
      
      // Initialize stores (serverUsers already loaded in Phase 1)
      const emojiCacheStore = emojiCache.useEmojiCacheStore()
      const chatStore = useChatStore()
      const reactionsStore = useReactionsStore()
      const themeStore = useThemeStore()
      
      console.log('✅ Chat route stores loaded: emojiCache, chat, reactions, theme')
      
      // ✅ Load current server presence only
      if (strategy.currentServerId) {
        const { getUserIdsForServer } = await import('@/services/usersService')
        const serverUserIds = await getUserIdsForServer(strategy.currentServerId)
        await userData.subscribeToContext(strategy.currentServerId, 'server', serverUserIds)
        console.log(`✅ Current server presence: ${strategy.currentServerId} (${serverUserIds.length} users)`)
      }
      
      // ✅ Load current server emojis only (others load in background)
      const allServerIds = serverChannelStore.servers.map(server => server.id)
      const otherServerIds = allServerIds.filter(id => id !== strategy.currentServerId)
      
      if (strategy.currentServerId) {
        await emojiCacheStore.initializeSelective(
          [strategy.currentServerId], // Priority: current server
          otherServerIds // Background: other servers
        )
        console.log(`✅ Current server emojis loaded: ${strategy.currentServerId}`)
        console.log(`🔄 Other server emojis loading in background: ${otherServerIds.length}`)
      }
    }
    
    else if (strategy.routeType === 'dm' || strategy.routeType === 'dm-list') {
      console.log('💬 Loading DM route (dm, emojiCache, theme, reactions)...')
      
      // ✅ ROUTE-SPECIFIC STORES: Only load what's needed for DMs
      const [emojiCache, { useDMStore }, { useReactionsStore }, { useThemeStore }] = await Promise.all([
        import('@/stores/useEmojiCache'),
        import('@/stores/useDM'),
        import('@/stores/useReactions'),
        import('@/stores/useTheme')
      ])
      
      // Initialize stores
      const emojiCacheStore = emojiCache.useEmojiCacheStore()
      const dmStore = useDMStore()
      const reactionsStore = useReactionsStore()
      const themeStore = useThemeStore()
      
      console.log('✅ DM route stores loaded: emojiCache, dm, reactions, theme')
      
      // Initialize minimal emoji support for DMs (they might use emojis too)
      const allServerIds = serverChannelStore.servers.map(server => server.id)
      if (allServerIds.length > 0) {
        const defaultServerId = serverChannelStore.currentServerId || allServerIds[0]
        await emojiCacheStore.initializeSelective([defaultServerId], [])
        console.log(`✅ Basic emoji support loaded for DMs`)
      }
      
      // Initialize DM functionality
      if (strategy.routeType === 'dm' && strategy.currentConversationId) {
        // Load specific conversation + DM list metadata
        await dmStore.initializeDMEnvironmentForDirectAccess(userId, strategy.currentConversationId)
        console.log(`✅ DM conversation loaded: ${strategy.currentConversationId}`)
      } else {
        // Load DM list metadata only (no message content)
        await dmStore.initializeDMEnvironment(userId, false, true) // false = forceRefresh, true = metadataOnly
        console.log('✅ DM list metadata loaded')
      }
      
      // OPTIMIZED: Only subscribe to DM presence for specific DM conversation routes
      // For dm-list, we'll load presence on-demand when conversations are hovered/opened
      if (strategy.routeType === 'dm' && strategy.currentConversationId) {
        const conversationUserIds = dmStore.conversations
          .map(conv => conv.user1 === userId ? conv.user2 : conv.user1)
          .filter(id => id !== userId)
        
        if (conversationUserIds.length > 0) {
          await userData.subscribeToDMPresence(conversationUserIds)
          console.log(`✅ DM presence subscribed: ${conversationUserIds.length} users`)
        }
      } else if (strategy.routeType === 'dm-list') {
        console.log('⚡ Skipping DM presence for dm-list route (loaded on-demand)')
      }
    }
    
    else if (strategy.routeType === 'social') {
      console.log('🌐 Loading social route (activitypub, emojiCache, theme, reactions)...')
      
      // ✅ ROUTE-SPECIFIC STORES: Only load what's needed for ActivityPub/Social
      const [emojiCache, { useActivityPubStore }, { useReactionsStore }, { useThemeStore }] = await Promise.all([
        import('@/stores/useEmojiCache'),
        import('@/stores/useActivityPub'),
        import('@/stores/useReactions'),
        import('@/stores/useTheme')
      ])
      
      // Initialize stores
      const emojiCacheStore = emojiCache.useEmojiCacheStore()
      const activityPubStore = useActivityPubStore()
      const reactionsStore = useReactionsStore()
      const themeStore = useThemeStore()
      
      console.log('✅ Social route stores loaded: emojiCache, activitypub, reactions, theme')
      
      // Initialize minimal emoji support for social features
      const allServerIds = serverChannelStore.servers.map(server => server.id)
      if (allServerIds.length > 0) {
        const defaultServerId = serverChannelStore.currentServerId || allServerIds[0]
        await emojiCacheStore.initializeSelective([defaultServerId], [])
        console.log(`✅ Basic emoji support loaded for social features`)
      }
    }
    
    // ✅ MINIMAL STORES: For unknown/other routes, load only essentials
    else if (strategy.routeType === 'other' && serverChannelStore.servers.length > 0) {
      console.log('🎭 Loading other route (emojiCache, theme, reactions - minimal set)...')
      
      // ✅ ROUTE-SPECIFIC STORES: Only load minimal essentials
      const [emojiCache, { useReactionsStore }, { useThemeStore }] = await Promise.all([
        import('@/stores/useEmojiCache'),
        import('@/stores/useReactions'),
        import('@/stores/useTheme')
      ])
      
      // Initialize stores
      const emojiCacheStore = emojiCache.useEmojiCacheStore()
      const reactionsStore = useReactionsStore()
      const themeStore = useThemeStore()
      
      console.log('✅ Other route stores loaded: emojiCache, reactions, theme (minimal)')
      
      // Load default server emojis since app always loads a default server
      const allServerIds = serverChannelStore.servers.map(server => server.id)
      const defaultServerId = serverChannelStore.currentServerId || allServerIds[0]
      const otherServerIds = allServerIds.filter(id => id !== defaultServerId)
      
      if (defaultServerId) {
        await emojiCacheStore.initializeSelective(
          [defaultServerId], // Priority: default server
          otherServerIds // Background: other servers
        )
        console.log(`✅ Default server emojis loaded: ${defaultServerId}`)
        console.log(`🔄 Other server emojis loading in background: ${otherServerIds.length}`)
      }
    }
    
  } catch (error) {
    console.error('❌ Failed to initialize route-specific data:', error)
  }
}

// 🔄 OPTIMIZED: Background loading of non-critical data
const initializeBackgroundData = async (userId: string, strategy: any) => {
  try {
    console.log('🔄 Background loading: notification count...')
    
    // ✅ Load only notification count initially (not full list)
    const { useNotificationStore } = await import('@/stores/useNotification')
    const notificationStore = useNotificationStore()
    await notificationStore.initializeUnreadCountOnly(userId)
    
    // ✅ PERFORMANCE FIX: Move activity tracking to background
    console.log('🎯 Starting activity tracking...')
    const { useUserData } = await import('@/composables/useUserData')
    const userData = useUserData()
    await userData.initializeBackgroundFeatures()
    console.log('✅ Activity tracking started')
    
    console.log('✅ Background loading complete')
  } catch (error) {
    console.error('❌ Background loading failed:', error)
  }
}



// Watch for auth changes to reinitialize
watch(() => authStore.session, async (newSession, oldSession) => {
  // If user just logged in (had no session, now has one)
  if (!oldSession && newSession) {
    console.log('🔄 User logged in, reinitializing app')
    await initializeApp()
  }
  // If user logged out (had session, now doesn't)
  else if (oldSession && !newSession) {
    console.log('👋 User logged out, cleaning up presence and resetting app state')
    
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
    
    isAppInitialized.value = false
    hasServersLoaded.value = false
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