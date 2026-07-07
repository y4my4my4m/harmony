<template>
  <Transition name="install-banner">
    <div v-if="showBanner" class="pwa-install-banner">
      <div class="banner-content">
        <div class="banner-icon">
          <img src="/img/app_icon_square.webp" alt="Harmony" />
        </div>
        <div class="banner-text">
          <h3>Install Harmony</h3>
          <p>Get the full app experience with faster loading and offline access</p>
        </div>
        <div class="banner-actions">
          <button @click="dismissBanner" class="banner-btn secondary">
            Maybe Later
          </button>
          <button @click="installApp" class="banner-btn primary" :disabled="installing">
            <span v-if="installing">Installing...</span>
            <span v-else>Install</span>
          </button>
        </div>
        <button @click="closeBanner" class="close-btn" aria-label="Close">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
          </svg>
        </button>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { debug } from '@/utils/debug'
import { pwaManager } from '@/services/PWAManager'
import { canInstallPWA } from '@/utils/platform'
import {
  showInstallFailedToast,
  showInstallUnavailableToast,
} from '@/utils/pwaInstallToast'

const showBanner = ref(false)
const installing = ref(false)

const checkInstallAvailability = () => {
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

    const success = await pwaManager.showInstallPrompt()
    if (success) {
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
  // Remember dismissal for 7 days
  const dismissTime = Date.now()
  localStorage.setItem('harmony-install-banner-dismissed', dismissTime.toString())
}

const closeBanner = () => {
  showBanner.value = false
  // Remember dismissal for 30 days
  const dismissTime = Date.now()
  localStorage.setItem('harmony-install-banner-closed', dismissTime.toString())
}

const wasRecentlyDismissed = (): boolean => {
  const dismissedTime = localStorage.getItem('harmony-install-banner-dismissed')
  const closedTime = localStorage.getItem('harmony-install-banner-closed')
  
  if (closedTime) {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000)
    return parseInt(closedTime) > thirtyDaysAgo
  }
  
  if (dismissedTime) {
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000)
    return parseInt(dismissedTime) > sevenDaysAgo
  }
  
  return false
}

const handleInstallAvailable = () => {
  if (!wasRecentlyDismissed()) {
    showBanner.value = true
  }
}

const handleAppInstalled = () => {
  showBanner.value = false
}

onMounted(() => {
  // Installing a PWA only makes sense in a browser tab
  if (!canInstallPWA()) return

  setTimeout(checkInstallAvailability, 2000) // Delay to avoid interfering with app load

  window.addEventListener('pwa-install-available', handleInstallAvailable)
  window.addEventListener('pwa-app-installed', handleAppInstalled)
})

onUnmounted(() => {
  window.removeEventListener('pwa-install-available', handleInstallAvailable)
  window.removeEventListener('pwa-app-installed', handleAppInstalled)
})
</script>

<style scoped>
.pwa-install-banner {
  position: fixed;
  bottom: 20px;
  left: 20px;
  right: 20px;
  background: linear-gradient(135deg, #0EA5E9, #0284C7);
  border-radius: 16px;
  box-shadow: 
    0 8px 32px rgba(14, 165, 233, 0.3),
    0 4px 16px rgba(0, 0, 0, 0.2);
  z-index: 1000;
  max-width: 500px;
  margin: 0 auto;
}

@media (min-width: 768px) {
  .pwa-install-banner {
    left: auto;
    right: 20px;
    max-width: 400px;
  }
}

.banner-content {
  position: relative;
  padding: 20px;
  display: flex;
  align-items: center;
  gap: 16px;
  color: var(--text-primary);
  flex-direction: column;
}

.banner-icon {
  flex-shrink: 0;
}

.banner-icon img {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.banner-text {
  flex: 1;
  min-width: 0;
}

.banner-text h3 {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}

.banner-text p {
  margin: 0;
  font-size: 14px;
  color: rgba(255, 255, 255, 0.9);
  line-height: 1.4;
}

.banner-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

@media (min-width: 480px) {
  .banner-actions {
    flex-direction: row;
    gap: 12px;
  }
}

.banner-btn {
  padding: 10px 16px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  min-width: 100px;
  white-space: nowrap;
}

.banner-btn.primary {
  background: white;
  color: #0EA5E9;
}

.banner-btn.primary:hover:not(:disabled) {
  background: #f8f9fa;
  transform: translateY(-1px);
}

.banner-btn.primary:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.banner-btn.secondary {
  background: rgba(255, 255, 255, 0.2);
  color: var(--text-primary);
  border: 1px solid rgba(255, 255, 255, 0.3);
}

.banner-btn.secondary:hover {
  background: rgba(255, 255, 255, 0.3);
}

.close-btn {
  position: absolute;
  top: 12px;
  right: 12px;
  background: rgba(255, 255, 255, 0.2);
  border: none;
  border-radius: 6px;
  padding: 6px;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.3);
}

/* Animations */
.install-banner-enter-active,
.install-banner-leave-active {
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.install-banner-enter-from {
  opacity: 0;
  transform: translateY(100%) scale(0.9);
}

.install-banner-leave-to {
  opacity: 0;
  transform: translateY(100%) scale(0.9);
}

/* Mobile optimizations */
@media (max-width: 480px) {
  .pwa-install-banner {
    bottom: 10px;
    left: 10px;
    right: 10px;
  }
  
  .banner-content {
    padding: 16px;
    flex-direction: column;
    text-align: center;
    gap: 12px;
  }
  
  .banner-actions {
    width: 100%;
  }
  
  .banner-btn {
    flex: 1;
  }
}
</style>
