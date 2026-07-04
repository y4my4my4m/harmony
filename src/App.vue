<template>
  <!-- Native client: choose which Harmony instance to talk to (mandatory on
       first run of a packaged build, reopenable from the login screen). -->
  <InstancePicker v-if="showInstancePicker" @close="showInstancePicker = false" />
  <button
    v-if="isAuthRoute && storedInstanceName && !showInstancePicker"
    class="instance-switch-badge"
    @click="showInstancePicker = true"
  >
    Instance: {{ storedInstanceName }} — change
  </button>

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

  <!-- Single app-wide confirm dialog host. Any component can call
       `useConfirmDialog().confirm({...})` without mounting its own modal. -->
  <UnifiedConfirmationModal
    :model-value="confirmDialogVisible"
    :title="confirmDialogTitle"
    :message="confirmDialogMessage"
    :confirm-button-text="confirmDialogConfirmText"
    :danger-action="confirmDialogDanger"
    @update:model-value="(v: boolean) => { if (!v) handleClose() }"
    @confirm="handleConfirm"
    @cancel="handleClose"
  />

  <!-- Discord-style "new login - was this you?" device-approval prompt. Gentle,
       non-blocking, and skippable; never a mandatory verification wall. -->
  <DeviceApprovalPrompt v-if="!isAuthRoute" />
  
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

  <!-- Floating live theme editor (Discord-style side panel over the app) -->
  <ThemeCustomizerPanel v-if="!isAuthRoute" />
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
import DeviceApprovalPrompt from '@/components/encryption/DeviceApprovalPrompt.vue'
import PersistentVoiceConnection from '@/components/PersistentVoiceConnection.vue'
import PWAInstallBanner from '@/components/PWAInstallBanner.vue'
import PWAUpdateNotification from '@/components/PWAUpdateNotification.vue'
import PushNotificationPrompt from '@/components/PushNotificationPrompt.vue'
import RunOnLoginPrompt from '@/components/RunOnLoginPrompt.vue'
import PublicServers from '@/components/PublicServers.vue'
import AnnouncementPopup from '@/components/announcements/AnnouncementPopup.vue'
import ThemeCustomizerPanel from '@/components/settings/user/ThemeCustomizerPanel.vue'
import UnifiedConfirmationModal from '@/components/shared/UnifiedConfirmationModal.vue'
import InstancePicker from '@/components/InstancePicker.vue'
import { needsInstanceSelection, getStoredInstance } from '@/services/instanceConfig'
import { useConfirmDialog } from '@/composables/useConfirmDialog'

const showInstancePicker = ref(needsInstanceSelection())
const storedInstanceName = computed(() => getStoredInstance()?.name ?? null)

const {
  confirmDialogVisible,
  confirmDialogTitle,
  confirmDialogMessage,
  confirmDialogConfirmText,
  confirmDialogDanger,
  handleConfirm,
  handleClose,
} = useConfirmDialog()
import { onMounted, onUnmounted } from 'vue'
import { hapticManager } from '@/utils/hapticFeedback'
import { initializeAppSettings } from '@/services/AppInitService'

let hapticClickHandler: ((e: Event) => void) | null = null
let identityChangedHandler: ((e: Event) => void) | null = null

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

onMounted(() => {
  // Initialize app settings in background (non-blocking)
  // This loads theme/language settings but doesn't block rendering
  initializeAppSettings().catch(err => {
    debug.error('❌ Failed to initialize app settings:', err)
  })
  
  // Haptic feedback for interactive elements: ONE delegated listener that
  // resolves the strongest matching pattern. The previous version stacked four
  // document-level click listeners per mount and never removed them (H44) -
  // remounts kept piling handlers on, and a single tap could fire several
  // haptic triggers.
  const hapticSelectors: Array<{ selector: string; pattern: string }> = [
    { selector: '.card-interactive', pattern: 'medium' },
    { selector: 'a[href]', pattern: 'selection' },
    { selector: 'button', pattern: 'light' },
    { selector: '.interactive-element', pattern: 'light' },
  ]
  hapticClickHandler = (e: Event) => {
    if (!hapticManager.enabled) return
    const target = e.target as HTMLElement
    for (const { selector, pattern } of hapticSelectors) {
      if (target.closest(selector)) {
        hapticManager.trigger({ pattern: pattern as any })
        return
      }
    }
  }
  document.addEventListener('click', hapticClickHandler)
  
  if (import.meta.env.DEV) {
    import('@/services/StatusLifecycleDebugger').then(({ statusDebugger }) => {
      statusDebugger.startDebugging()
      debug.log('🔍 Status lifecycle debugger started. Type showHelp() for available commands.')
    })
  }

  // Gentle, non-blocking notice when a contact's encryption identity changes
  // (TOFU). We deliberately do NOT show a blocking verification modal - just a
  // dismissible toast, framed in plain language for non-technical users.
  identityChangedHandler = (e: Event) => {
    handleIdentityChanged(e as CustomEvent).catch(err =>
      debug.warn('⚠️ Failed to surface identity-change notice:', err),
    )
  }
  window.addEventListener('harmony-identity-changed', identityChangedHandler)
})

onUnmounted(() => {
  if (hapticClickHandler) {
    document.removeEventListener('click', hapticClickHandler)
    hapticClickHandler = null
  }
  if (identityChangedHandler) {
    window.removeEventListener('harmony-identity-changed', identityChangedHandler)
    identityChangedHandler = null
  }
})

async function handleIdentityChanged(e: CustomEvent) {
  const detail = (e?.detail || {}) as { userId?: string }
  const userId = detail.userId
  if (!userId) return

  const [{ useNotificationStore }, { userDataService }] = await Promise.all([
    import('@/stores/useNotification'),
    import('@/services/userDataService'),
  ])

  let name = 'A contact'
  let avatar: string | undefined
  try {
    const profile = await userDataService.fetchUserProfile(userId)
    name = profile?.displayName || profile?.username || name
    avatar = profile?.avatar_url || profile?.avatar || undefined
  } catch { /* fall back to generic copy */ }

  const notifications = useNotificationStore()
  notifications.showToast(
    'server_update',
    'Security identity changed',
    `${name}'s encryption keys changed. This is normal if they reinstalled the app or signed in on a new device.`,
    8000,
    avatar,
    undefined,
    undefined,
    userId,
  )
}
</script>

<style>
  /* Figtree - self-hosted variable font (OFL-1.1) */
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

  /* NoRe Sans Pixel Pro v2 - original pixel-style Latin webfont by @y4my4m.
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

  .instance-switch-badge {
    position: fixed;
    bottom: 12px;
    right: 12px;
    z-index: 9999;
    padding: 6px 12px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    background: rgba(20, 20, 30, 0.75);
    color: rgba(255, 255, 255, 0.75);
    font-size: 0.8rem;
    cursor: pointer;
  }

  .instance-switch-badge:hover {
    color: white;
    border-color: rgba(255, 255, 255, 0.35);
  }
</style>
