<template>
  <!-- Conditional Layout Rendering -->
  <AuthLayout v-if="isAuthRoute" />
  
  <BaseLayout
    v-else
    @showPublicServers="handleShowPublicServers"
    @switchToActivityPub="handleSwitchToActivityPub"
    @switchToChat="handleSwitchToChat"
  />
  
  <NotificationToast />
  
  <!-- Persistent Voice Connection (only when authenticated) -->
  <PersistentVoiceConnection v-if="!isAuthRoute" />
  
  <!-- PWA Components -->
  <PWAInstallBanner />
  <PWAUpdateNotification />
  
  <!-- Push Notification Prompt (only for authenticated PWA users) -->
  <PushNotificationPrompt v-if="!isAuthRoute" />
  
  <!-- Global Modals (only when authenticated) -->
  <PublicServers 
    v-if="showPublicServers && !isAuthRoute"
    :force-refresh="shouldForceRefreshPublicServers"
    @close="handleClosePublicServers"
  />
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { debug } from '@/utils/debug'
import { useRouter, useRoute } from 'vue-router'
import BaseLayout from '@/layouts/BaseLayout.vue'
import AuthLayout from '@/layouts/AuthLayout.vue'
import NotificationToast from '@/components/NotificationToast.vue'
import PersistentVoiceConnection from '@/components/PersistentVoiceConnection.vue'
import PWAInstallBanner from '@/components/PWAInstallBanner.vue'
import PWAUpdateNotification from '@/components/PWAUpdateNotification.vue'
import PushNotificationPrompt from '@/components/PushNotificationPrompt.vue'
import PublicServers from '@/components/PublicServers.vue'
import { onMounted } from 'vue'
import { hapticManager } from '@/utils/hapticFeedback'
import { initializeAppSettings } from '@/services/AppInitService'

const router = useRouter()
const route = useRoute()

// Auth route detection
const isAuthRoute = computed(() => {
  const authRoutes = ['/login', '/register', '/reset-password', '/new-profile', '/404-public']
  return authRoutes.includes(route.path) || route.name === 'NotFoundPublic'
})

// Global modal state
const showPublicServers = ref(false)
const shouldForceRefreshPublicServers = ref(false)

// Event handlers
const handleShowPublicServers = () => {
  showPublicServers.value = true
  shouldForceRefreshPublicServers.value = true
}

const handleClosePublicServers = () => {
  showPublicServers.value = false
  shouldForceRefreshPublicServers.value = false
}

const handleSwitchToActivityPub = () => {
  router.push({ name: 'Social', params: { timeline: 'home' } })
}

const handleSwitchToChat = () => {
  router.push({ name: 'Chat' })
}

// Initialize haptic feedback for the app
onMounted(() => {
  // Initialize app settings in background (non-blocking)
  // This loads theme/language settings but doesn't block rendering
  initializeAppSettings().catch(err => {
    debug.error('❌ Failed to initialize app settings:', err)
  })
  
  // Add haptic feedback to common interactive elements
  const addHapticToElements = (selector: string, pattern: string = 'light') => {
    document.addEventListener('click', (e) => {
      const element = (e.target as HTMLElement).closest(selector)
      if (element && hapticManager.enabled) {
        hapticManager.trigger({ pattern: pattern as any })
      }
    })
  }

  // Add haptic feedback to buttons and interactive elements
  addHapticToElements('button', 'light')
  addHapticToElements('.interactive-element', 'light')
  addHapticToElements('a[href]', 'selection')
  addHapticToElements('.card-interactive', 'medium')
  
  // Initialize status lifecycle debugger in development
  if (import.meta.env.DEV) {
    import('@/services/StatusLifecycleDebugger').then(({ statusDebugger }) => {
      statusDebugger.startDebugging()
      debug.log('🔍 Status lifecycle debugger started. Type showHelp() for available commands.')
    })
  }
})
</script>

<style>
  @font-face {
    font-family: 'gg sans';
    font-style: normal;
    font-weight: 300;
    src: local('gg sans Normal Regular'), url('/assets/fonts/gg_sans_Regular.woff') format('woff');
  }
  
  @font-face {
    font-family: 'gg sans';
    font-style: normal;
    font-weight: 400;
    src: local('gg sans Medium Regular'), url('/assets/fonts/gg_sans_Medium.woff') format('woff');
  }

  @font-face {
    font-family: 'gg sans';
    font-style: normal;
    font-weight: 700;
    src: local('gg sans SemiBold Regular'), url('/assets/fonts/gg_sans_Semibold.woff') format('woff');
  }
  @font-face {
    font-family: 'gg sans';
    font-style: normal;
    font-weight: 900;
    src: local('gg sans Bold'), url('/assets/fonts/gg_sans_Bold.woff') format('woff');
  }
  
  /* Global styles */
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    font-family: 'gg sans', Arial, sans-serif;
    font-weight:100!important;
  }

  #app {
    width: 100%;
    height: 100%;
  }
</style>
