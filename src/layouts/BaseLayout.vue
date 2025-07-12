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
      />
    </div>

    <!-- User Profile at Bottom -->
    <div class="user-profile-section">
      <UserProfileComponent />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { UserStatus } from '@/types'
import ServerSidebar from '@/components/ServerSidebar.vue'
import UserProfileComponent from '@/components/UserProfileComponent.vue'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useAuthStore } from '@/stores/auth'
import { useProfileStore } from '@/stores/useProfile'
import { useMobileGestures } from '@/composables/useMobileGestures'
import { useLayoutState } from '@/composables/useLayoutState'

// Stores
const serverChannelStore = useServerChannelStore()
const authStore = useAuthStore()
const profileStore = useProfileStore()

// Composables
const { touchState, handleTouchStart, handleTouchMove, handleTouchEnd } = useMobileGestures()
const { 
  leftSidebarOpen, 
  rightSidebarOpen, 
  isMobile, 
  voicePanelOpen,
  toggleLeftSidebar,
  toggleRightSidebar,
  toggleVoicePanel,
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

// Initialize app
const initializeApp = async () => {
  try {
    // Wait for auth to be ready if session is null
    if (!authStore.session) {
      console.log('⏳ Waiting for authentication to initialize...')
      // Wait a bit for auth store to initialize
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    const userId = authStore.session?.user?.id
    if (!userId) {
      console.log('👤 No user session found, app ready for login')
      isAppInitialized.value = true
      hasServersLoaded.value = true // Set to true so we don't show loading indefinitely
      return
    }

    console.log('🚀 Initializing app for user:', userId)

    // Initialize the user environment which includes server loading
    await serverChannelStore.initializeUserEnvironment(userId)
    
    // Initialize the user profile 
    await profileStore.fetchProfile(userId)
    
    // Initialize the user data system (replaces old fragmented system)
    try {
      const { useUserData } = await import('@/composables/useUserData')
      const userData = useUserData()
      
      const userProfile = profileStore.profile || {
        id: userId,
        username: authStore.session?.user?.user_metadata?.username || 'Unknown',
        display_name: authStore.session?.user?.user_metadata?.display_name,
        avatar_url: authStore.session?.user?.user_metadata?.avatar_url
        // Do NOT set status here - let userDataService load it from database
      }
      
      await userData.initialize(
        userId, 
        userProfile.username || userProfile.display_name || 'Unknown',
        userProfile.avatar_url
      )
      console.log('✅ User data system initialized')
    } catch (error) {
      console.error('❌ Failed to initialize user data system:', error)
    }
    
    hasServersLoaded.value = true
    isAppInitialized.value = true
    console.log('✅ App initialization complete')
  } catch (error) {
    console.error('Failed to initialize app:', error)
    isAppInitialized.value = true // Still show the app even if servers fail to load
    hasServersLoaded.value = true
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
    
    // Clean up user data service
    try {
      const { userDataService } = await import('@/services/userDataService')
      await userDataService.cleanup()
    } catch (error) {
      console.error('Failed to cleanup user data:', error)
    }
    
    isAppInitialized.value = false
    hasServersLoaded.value = false
  }
})

// Mobile touch handlers
onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('touchstart', handleTouchStart, { passive: true })
    window.addEventListener('touchmove', handleTouchMove, { passive: true })
    window.addEventListener('touchend', handleTouchEnd, { passive: true })
  }
  
  initializeApp()
})

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('touchstart', handleTouchStart)
    window.removeEventListener('touchmove', handleTouchMove)
    window.removeEventListener('touchend', handleTouchEnd)
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

.loading-spinner-container {
  text-align: center;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 2px solid var(--border-color);
  border-top: 2px solid var(--accent-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto 16px;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
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
  pointer-events: none;
  z-index: 300;
}

.edge-indicator {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 4px;
  height: 100px;
  background: var(--accent-primary);
  opacity: 0;
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
}
</style>