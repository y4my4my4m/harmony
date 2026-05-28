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
  <OfflineBanner />

  <!-- Global encryption-fallback prompt. Replaces `window.confirm` in the
       channel / DM / thread send paths so the dialog matches the rest of
       the app's UI and isn't a native browser alert. -->
  <EncryptionFallbackModal />
  
  <!-- Persistent Voice Connection (only when authenticated) -->
  <PersistentVoiceConnection v-if="!isAuthRoute" />
  
  <!-- PWA Components -->
  <PWAInstallBanner />
  <PWAUpdateNotification />
  
  <!-- Push Notification Prompt (only for authenticated PWA users) -->
  <PushNotificationPrompt v-if="!isAuthRoute" />

  <!-- Suggest "Start app when you sign in" for installed PWAs on Chromium desktop -->
  <RunOnLoginPrompt v-if="!isAuthRoute" />
  
  <!-- Global Announcements Popup -->
  <AnnouncementPopup v-if="!isAuthRoute" />
  
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
import OfflineBanner from '@/components/OfflineBanner.vue'
import EncryptionFallbackModal from '@/components/EncryptionFallbackModal.vue'
import PersistentVoiceConnection from '@/components/PersistentVoiceConnection.vue'
import PWAInstallBanner from '@/components/PWAInstallBanner.vue'
import PWAUpdateNotification from '@/components/PWAUpdateNotification.vue'
import PushNotificationPrompt from '@/components/PushNotificationPrompt.vue'
import RunOnLoginPrompt from '@/components/RunOnLoginPrompt.vue'
import PublicServers from '@/components/PublicServers.vue'
import AnnouncementPopup from '@/components/announcements/AnnouncementPopup.vue'
import { onMounted } from 'vue'
import { hapticManager } from '@/utils/hapticFeedback'
import { initializeAppSettings } from '@/services/AppInitService'

const router = useRouter()
const route = useRoute()

// Auth route detection
const isAuthRoute = computed(() => {
  const authRoutes = ['/login', '/register', '/reset-password', '/new-profile', '/404-public', '/logout']
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
  /* Figtree – self-hosted variable font (OFL-1.1) */
  @font-face {
    font-family: 'Figtree';
    font-style: normal;
    font-weight: 300 900;
    font-display: swap;
    src: url('/assets/fonts/Figtree-latin.woff2') format('woff2');
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }
  @font-face {
    font-family: 'Figtree';
    font-style: normal;
    font-weight: 300 900;
    font-display: swap;
    src: url('/assets/fonts/Figtree-latin-ext.woff2') format('woff2');
    unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
  }

  /* NoRe Sans Pixel Pro v2 — original pixel-style Latin webfont by @y4my4m.
     Fonts are lazy-loaded via `font-display: swap`, so users on the default
     "system" font don't pay any download cost for these. */
  @font-face {
    font-family: 'NoRe Sans Pixel Pro';
    font-style: normal;
    font-weight: 400;
    font-display: swap;
    src: url('/assets/fonts/nore-sans-pixel-pro-v2/fonts/NoReSansPixelPro-Regular.woff2') format('woff2'),
         url('/assets/fonts/nore-sans-pixel-pro-v2/fonts/NoReSansPixelPro-Regular.ttf') format('truetype');
  }
  @font-face {
    font-family: 'NoRe Sans Pixel Pro';
    font-style: normal;
    font-weight: 700;
    font-display: swap;
    src: url('/assets/fonts/nore-sans-pixel-pro-v2/fonts/NoReSansPixelPro-Bold.woff2') format('woff2'),
         url('/assets/fonts/nore-sans-pixel-pro-v2/fonts/NoReSansPixelPro-Bold.ttf') format('truetype');
  }
  @font-face {
    font-family: 'NoRe Sans Pixel Pro';
    font-style: normal;
    font-weight: 900;
    font-display: swap;
    src: url('/assets/fonts/nore-sans-pixel-pro-v2/fonts/NoReSansPixelPro-Black.woff2') format('woff2'),
         url('/assets/fonts/nore-sans-pixel-pro-v2/fonts/NoReSansPixelPro-Black.ttf') format('truetype');
  }
  @font-face {
    font-family: 'NoRe Sans Pixel Pro';
    font-style: italic;
    font-weight: 400;
    font-display: swap;
    src: url('/assets/fonts/nore-sans-pixel-pro-v2/fonts/NoReSansPixelPro-Italic.woff2') format('woff2'),
         url('/assets/fonts/nore-sans-pixel-pro-v2/fonts/NoReSansPixelPro-Italic.ttf') format('truetype');
  }
  @font-face {
    font-family: 'NoRe Sans Pixel Pro';
    font-style: italic;
    font-weight: 700;
    font-display: swap;
    src: url('/assets/fonts/nore-sans-pixel-pro-v2/fonts/NoReSansPixelPro-BoldItalic.woff2') format('woff2'),
         url('/assets/fonts/nore-sans-pixel-pro-v2/fonts/NoReSansPixelPro-BoldItalic.ttf') format('truetype');
  }
  @font-face {
    font-family: 'NoRe Sans Pixel Pro';
    font-style: italic;
    font-weight: 900;
    font-display: swap;
    src: url('/assets/fonts/nore-sans-pixel-pro-v2/fonts/NoReSansPixelPro-BlackItalic.woff2') format('woff2'),
         url('/assets/fonts/nore-sans-pixel-pro-v2/fonts/NoReSansPixelPro-BlackItalic.ttf') format('truetype');
  }

  /* Global styles. font-family deliberately reads `--font-family` so the
     Appearance settings font picker can swap the whole UI typeface live. */
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    font-family: var(--font-family);
  }

  #app {
    width: 100%;
    height: 100%;
  }
</style>
