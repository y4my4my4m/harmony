<template>
  <div v-if="showInstallPrompt" class="pwa-install-banner">
    <div class="install-content">
      <div class="install-icon">
        <img src="/img/app_icon_square.webp" alt="Harmony" class="app-icon">
      </div>
      <div class="install-text">
        <h4>Install Harmony</h4>
        <p>Get the full app experience with faster loading and offline access</p>
      </div>
      <div class="install-actions">
        <button @click="installApp" class="install-btn">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
          </svg>
          Install
        </button>
        <button @click="dismissPrompt" class="dismiss-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </div>
    </div>
  </div>

  <!-- Install Button for Settings -->
  <button 
    v-else-if="canShowInstallButton && !isInstalled" 
    @click="installApp"
    class="settings-install-btn"
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
    </svg>
    Install Harmony App
  </button>

  <!-- Share Button -->
  <button
    v-if="supportsShare"
    @click="shareApp"
    class="share-btn"
    :class="{ 'settings-btn': isInSettings }"
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/>
    </svg>
    Share Harmony
  </button>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { debug } from '@/utils/debug'
import { pwaManager } from '@/services/PWAManager'
import {
  showInstallFailedToast,
  showInstallUnavailableToast,
} from '@/utils/pwaInstallToast'

interface Props {
  variant?: 'banner' | 'button'
  isInSettings?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'banner',
  isInSettings: false
})

const showInstallPrompt = ref(false)
const isInstalled = ref(false)
const capabilities = ref(pwaManager.getCapabilities())

const canShowInstallButton = computed(() => 
  capabilities.value.canInstall && props.variant === 'button'
)

const supportsShare = computed(() => 
  capabilities.value.supportsShare
)

const installApp = async () => {
  if (!pwaManager.hasDeferredInstallPrompt()) {
    showInstallUnavailableToast()
    return
  }

  const success = await pwaManager.showInstallPrompt()
  if (success) {
    showInstallPrompt.value = false
  } else {
    showInstallFailedToast()
  }
}

const dismissPrompt = () => {
  showInstallPrompt.value = false
  localStorage.setItem('pwa-install-dismissed', Date.now().toString())
}

const shareApp = async () => {
  const success = await pwaManager.shareContent({
    title: 'Harmony - Secure Chat App',
    text: 'Check out Harmony, a secure and private chat application!',
    url: window.location.origin
  })
  
  if (!success) {
    // Fallback to clipboard
    try {
      await navigator.clipboard.writeText(window.location.origin)
      // You could show a toast here
      debug.log('App URL copied to clipboard')
    } catch (error) {
      debug.error('Failed to share or copy URL:', error)
    }
  }
}

const updateCapabilities = () => {
  capabilities.value = pwaManager.getCapabilities()
  isInstalled.value = capabilities.value.isInstalled
}

const handleInstallAvailable = () => {
  updateCapabilities()
  
  // Only show banner if not dismissed recently and in banner mode
  if (props.variant === 'banner') {
    const dismissed = localStorage.getItem('pwa-install-dismissed')
    const shouldShow = !dismissed || (Date.now() - parseInt(dismissed)) > (7 * 24 * 60 * 60 * 1000) // 7 days
    
    if (shouldShow && !isInstalled.value) {
      showInstallPrompt.value = true
    }
  }
}

const handleAppInstalled = () => {
  updateCapabilities()
  showInstallPrompt.value = false
}

onMounted(() => {
  updateCapabilities()
  
  // Listen for PWA events
  window.addEventListener('pwa-install-available', handleInstallAvailable)
  window.addEventListener('pwa-app-installed', handleAppInstalled)
  
  if (props.variant === 'banner' && capabilities.value.canInstall) {
    handleInstallAvailable()
  }
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
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  z-index: 1000;
  animation: slideUp 0.3s ease-out;
}

@keyframes slideUp {
  from {
    transform: translateY(100%);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.install-content {
  display: flex;
  align-items: center;
  padding: 16px;
  gap: 12px;
}

.install-icon .app-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.install-text {
  flex: 1;
  color: var(--text-primary);
}

.install-text h4 {
  margin: 0 0 4px 0;
  font-size: 16px;
  font-weight: 600;
}

.install-text p {
  margin: 0;
  font-size: 14px;
  opacity: 0.9;
  line-height: 1.3;
}

.install-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.install-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.2);
  color: var(--text-primary);
  border: none;
  border-radius: 8px;
  padding: 8px 16px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.install-btn:hover {
  background: rgba(255, 255, 255, 0.3);
  transform: translateY(-1px);
}

.dismiss-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
  border: none;
  border-radius: 6px;
  width: 32px;
  height: 32px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.dismiss-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

.settings-install-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  background: linear-gradient(135deg, #0EA5E9, #0284C7);
  color: var(--text-on-primary, #ffffff);
  border: none;
  border-radius: 8px;
  padding: 12px 16px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.settings-install-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(14, 165, 233, 0.3);
}

.share-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #4f545c;
  color: var(--text-secondary);
  border: none;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.share-btn:hover {
  background: var(--harmony-primary);
  color: var(--text-primary);
}

.share-btn.settings-btn {
  width: 100%;
  justify-content: center;
  padding: 12px 16px;
  margin-top: 8px;
  background: var(--background-quaternary);
  color: var(--text-on-primary, #ffffff);
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .pwa-install-banner {
    left: 12px;
    right: 12px;
    bottom: 12px;
  }
  
  .install-content {
    padding: 12px;
  }
  
  .install-text h4 {
    font-size: 15px;
  }
  
  .install-text p {
    font-size: 13px;
  }
}
</style>
