<template>
  <Transition name="install-banner">
    <aside v-if="showBanner" class="pwa-install-banner" :aria-label="t('pwa.installTitle')">
      <img class="banner-icon" src="/img/app_icon_square.webp" alt="" width="36" height="36" />
      <div class="banner-text">
        <p class="banner-title">{{ t('pwa.installTitle') }}</p>
        <p class="banner-description">{{ t('pwa.installDescription') }}</p>
      </div>
      <button type="button" class="banner-install" :disabled="installing" @click="installApp">
        {{ installing ? t('pwa.installing') : t('pwa.install') }}
      </button>
      <button type="button" class="banner-close" :aria-label="t('pwa.dismiss')" @click="dismissBanner">
        <Icon name="x" :size="16" />
      </button>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { debug } from '@/utils/debug'
import { pwaManager } from '@/services/PWAManager'
import { canInstallPWA } from '@/utils/platform'
import {
  showInstallFailedToast,
  showInstallUnavailableToast,
} from '@/utils/pwaInstallToast'
import Icon from '@/components/common/Icon.vue'

const DISMISSED_KEY = 'harmony-install-banner-closed'
const LEGACY_DISMISSED_KEY = 'harmony-install-banner-dismissed'
const DISMISS_MS = 30 * 24 * 60 * 60 * 1000
const LEGACY_DISMISS_MS = 7 * 24 * 60 * 60 * 1000
// Delay after mount; the first paint after sign-in belongs to the app.
const SHOW_DELAY_MS = 2000

const { t } = useI18n()
const showBanner = ref(false)
const installing = ref(false)
let showTimer: ReturnType<typeof setTimeout> | null = null

const wasRecentlyDismissed = (): boolean => {
  const now = Date.now()
  const closed = Number(localStorage.getItem(DISMISSED_KEY) || 0)
  const legacy = Number(localStorage.getItem(LEGACY_DISMISSED_KEY) || 0)
  return now - closed < DISMISS_MS || now - legacy < LEGACY_DISMISS_MS
}

const maybeShow = () => {
  const capabilities = pwaManager.getCapabilities()
  if (capabilities.canInstall && !capabilities.isInstalled && !wasRecentlyDismissed()) {
    showBanner.value = true
  }
}

const installApp = async () => {
  installing.value = true
  try {
    if (!pwaManager.hasDeferredInstallPrompt()) {
      showInstallUnavailableToast()
      return
    }
    if (await pwaManager.showInstallPrompt()) {
      showBanner.value = false
      localStorage.setItem('harmony-pwa-installed', 'true')
    } else {
      showInstallFailedToast()
    }
  } catch (error) {
    debug.error('Failed to install app:', error)
    showInstallUnavailableToast()
  } finally {
    installing.value = false
  }
}

const dismissBanner = () => {
  showBanner.value = false
  localStorage.setItem(DISMISSED_KEY, String(Date.now()))
}

const handleAppInstalled = () => {
  showBanner.value = false
}

onMounted(() => {
  if (!canInstallPWA()) return
  showTimer = setTimeout(maybeShow, SHOW_DELAY_MS)
  window.addEventListener('pwa-install-available', maybeShow)
  window.addEventListener('pwa-app-installed', handleAppInstalled)
})

onUnmounted(() => {
  if (showTimer) clearTimeout(showTimer)
  window.removeEventListener('pwa-install-available', maybeShow)
  window.removeEventListener('pwa-app-installed', handleAppInstalled)
})
</script>

<style scoped>
/* One row above the composer's band: the chat composer occupies the bottom
   80px on desktop and 64px on mobile, and its send controls sit at the right
   edge. */
.pwa-install-banner {
  position: fixed;
  right: var(--space-5);
  bottom: 88px;
  z-index: var(--z-fixed);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: min(360px, calc(100vw - 2 * var(--space-3)));
  box-sizing: border-box;
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  background: var(--background-floating);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-large);
  color: var(--text-primary);
}

.banner-icon {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  flex-shrink: 0;
}

.banner-text {
  flex: 1;
  min-width: 0;
}

.banner-title {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}

.banner-description {
  margin: 0;
  font-size: var(--font-size-xs);
  line-height: var(--line-height-tight);
  color: var(--text-secondary);
}

.banner-install {
  flex-shrink: 0;
  min-height: 36px;
  padding: 0 var(--space-4);
  border: none;
  border-radius: var(--radius-md);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.banner-install:hover:not(:disabled) {
  background: var(--harmony-primary-hover);
}

.banner-install:disabled {
  opacity: 0.7;
  cursor: progress;
}

.banner-close {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.banner-close:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.install-banner-enter-active,
.install-banner-leave-active {
  transition: opacity var(--transition-slow), transform var(--transition-slow);
}

.install-banner-enter-from,
.install-banner-leave-to {
  opacity: 0;
  transform: translateY(16px);
}

@media (max-width: 768px) {
  .pwa-install-banner {
    right: var(--space-3);
    bottom: calc(env(safe-area-inset-bottom, 0px) + 72px);
    left: var(--space-3);
    width: auto;
  }
}
</style>
