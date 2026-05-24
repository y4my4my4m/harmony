<template>
  <Transition name="run-on-login-banner">
    <div v-if="showBanner" class="run-on-login-banner">
      <div class="banner-content">
        <div class="banner-icon">
          <svg viewBox="0 0 24 24" width="28" height="28">
            <path fill="currentColor" d="M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z"/>
          </svg>
        </div>
        <div class="banner-text">
          <h3>Launch Harmony at sign in?</h3>
          <p>{{ browserLabel }} can start Harmony automatically when you log into your computer.</p>
        </div>
        <div class="banner-actions">
          <button class="banner-btn secondary" @click="dismiss">Not Now</button>
          <button class="banner-btn primary" @click="openInstructions">Show me how</button>
        </div>
        <button class="close-btn" aria-label="Close" @click="close">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
          </svg>
        </button>
      </div>
    </div>
  </Transition>

  <RunOnLoginInstructionsModal v-model="showModal" @enabled="handleEnabled" />
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { debug } from '@/utils/debug'
import { getChromiumBrowserLabel, isChromiumDesktop, isPWA } from '@/utils/pwaUtils'
import RunOnLoginInstructionsModal from '@/components/RunOnLoginInstructionsModal.vue'

const STORAGE_KEYS = {
  enabled: 'harmony-run-on-login-enabled',
  dismissed: 'harmony-run-on-login-prompt-dismissed',
  closed: 'harmony-run-on-login-prompt-closed',
} as const

const SNOOZE_DISMISS_MS = 7 * 24 * 60 * 60 * 1000
const SNOOZE_CLOSE_MS = 30 * 24 * 60 * 60 * 1000

const showBanner = ref(false)
const showModal = ref(false)
const browserLabel = ref(getChromiumBrowserLabel())

const userHasEnabled = (): boolean => {
  return localStorage.getItem(STORAGE_KEYS.enabled) === 'true'
}

const wasRecentlyDismissed = (): boolean => {
  const closedAt = localStorage.getItem(STORAGE_KEYS.closed)
  if (closedAt && Date.now() - parseInt(closedAt, 10) < SNOOZE_CLOSE_MS) {
    return true
  }
  const dismissedAt = localStorage.getItem(STORAGE_KEYS.dismissed)
  if (dismissedAt && Date.now() - parseInt(dismissedAt, 10) < SNOOZE_DISMISS_MS) {
    return true
  }
  return false
}

const shouldShowPrompt = (): boolean => {
  if (!isPWA()) {
    debug.log('🪟 Run-on-login prompt: not running as PWA, skipping')
    return false
  }
  if (!isChromiumDesktop()) {
    debug.log('🪟 Run-on-login prompt: not a Chromium-based desktop browser, skipping')
    return false
  }
  if (userHasEnabled()) {
    debug.log('🪟 Run-on-login prompt: user already marked as enabled')
    return false
  }
  if (wasRecentlyDismissed()) {
    debug.log('🪟 Run-on-login prompt: recently dismissed/closed')
    return false
  }
  return true
}

const openInstructions = () => {
  showBanner.value = false
  showModal.value = true
}

const dismiss = () => {
  showBanner.value = false
  localStorage.setItem(STORAGE_KEYS.dismissed, Date.now().toString())
  debug.log('🪟 Run-on-login prompt dismissed (7 days)')
}

const close = () => {
  showBanner.value = false
  localStorage.setItem(STORAGE_KEYS.closed, Date.now().toString())
  debug.log('🪟 Run-on-login prompt closed (30 days)')
}

const handleEnabled = () => {
  showBanner.value = false
  showModal.value = false
}

const handleAppInstalled = () => {
  // Just installed - wait a moment, then re-evaluate. The app is usually
  // re-opened in standalone mode shortly after install; if it isn't, the
  // mounted check on the next launch will catch it.
  setTimeout(() => {
    if (shouldShowPrompt()) {
      showBanner.value = true
    }
  }, 1500)
}

onMounted(() => {
  setTimeout(() => {
    if (shouldShowPrompt()) {
      showBanner.value = true
    }
  }, 4000)

  window.addEventListener('pwa-app-installed', handleAppInstalled)
})

onUnmounted(() => {
  window.removeEventListener('pwa-app-installed', handleAppInstalled)
})
</script>

<style scoped>
.run-on-login-banner {
  position: fixed;
  bottom: 20px;
  left: 20px;
  right: 20px;
  max-width: 500px;
  margin: 0 auto;
  background: linear-gradient(135deg, #5865f2, #4752c4);
  border-radius: 16px;
  box-shadow: 0 8px 32px rgba(88, 101, 242, 0.35);
  z-index: 9999;
  overflow: hidden;
}

@media (min-width: 768px) {
  .run-on-login-banner {
    left: auto;
    right: 20px;
    margin: 0;
  }
}

.banner-content {
  position: relative;
  padding: 16px 16px 16px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--text-primary, #fff);
}

.banner-icon {
  width: 48px;
  height: 48px;
  background: rgba(255, 255, 255, 0.18);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.banner-text {
  flex: 1;
  min-width: 0;
}

.banner-text h3 {
  margin: 0 0 4px;
  font-size: 16px;
  font-weight: 700;
}

.banner-text p {
  margin: 0;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.92);
  line-height: 1.4;
}

.banner-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.banner-btn {
  padding: 8px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.15s ease;
  border: none;
  white-space: nowrap;
}

.banner-btn.primary {
  background: #fff;
  color: #4752c4;
}

.banner-btn.primary:hover {
  background: #f3f4f6;
  transform: translateY(-1px);
}

.banner-btn.secondary {
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
}

.banner-btn.secondary:hover {
  background: rgba(255, 255, 255, 0.28);
}

.close-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 26px;
  height: 26px;
  border: none;
  background: rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.85);
  transition: background 0.15s ease;
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.25);
  color: #fff;
}

@media (max-width: 540px) {
  .run-on-login-banner {
    left: 12px;
    right: 12px;
    bottom: 12px;
  }

  .banner-content {
    flex-wrap: wrap;
    padding: 14px;
  }

  .banner-text {
    flex-basis: calc(100% - 60px);
  }

  .banner-actions {
    width: 100%;
    justify-content: flex-end;
    margin-top: 6px;
  }
}

.run-on-login-banner-enter-active,
.run-on-login-banner-leave-active {
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s ease;
}

.run-on-login-banner-enter-from,
.run-on-login-banner-leave-to {
  transform: translateY(120%);
  opacity: 0;
}
</style>
