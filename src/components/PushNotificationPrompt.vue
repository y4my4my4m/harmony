<template>
  <Transition name="push-banner">
    <div v-if="showBanner" class="push-notification-banner">
      <div class="banner-content">
        <div class="banner-icon">
          <svg viewBox="0 0 24 24" width="32" height="32">
            <path fill="currentColor" d="M21,19V20H3V19L5,17V11C5,7.9 7.03,5.17 10,4.29C10,4.19 10,4.1 10,4A2,2 0 0,1 12,2A2,2 0 0,1 14,4C14,4.1 14,4.19 14,4.29C16.97,5.17 19,7.9 19,11V17L21,19M14,21A2,2 0 0,1 12,23A2,2 0 0,1 10,21"/>
          </svg>
        </div>
        <div class="banner-text">
          <h3>Enable Push Notifications</h3>
          <p>Get notified of new messages even when Harmony is closed</p>
        </div>
        <div class="banner-actions">
          <button @click="dismissBanner" class="banner-btn secondary">
            Not Now
          </button>
          <button @click="enablePush" class="banner-btn primary" :disabled="enabling">
            <span v-if="enabling">Enabling...</span>
            <span v-else>Enable</span>
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
import { ref, onMounted } from 'vue'
import { debug } from '@/utils/debug'
import { usePushNotifications } from '@/composables/usePushNotifications'
import { isPWA, isMobileUserAgent } from '@/utils/pwaUtils'

const showBanner = ref(false)
const enabling = ref(false)

const {
  isSupported,
  isSubscribed,
  permission,
  subscribe,
  initialize
} = usePushNotifications()

/**
 * Check if prompt was recently dismissed
 */
const wasRecentlyDismissed = (): boolean => {
  const dismissedTime = localStorage.getItem('harmony-push-prompt-dismissed')
  const closedTime = localStorage.getItem('harmony-push-prompt-closed')
  
  // If closed with X, wait 30 days
  if (closedTime) {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000)
    if (parseInt(closedTime) > thirtyDaysAgo) return true
  }
  
  // If clicked "Not Now", wait 7 days
  if (dismissedTime) {
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000)
    if (parseInt(dismissedTime) > sevenDaysAgo) return true
  }
  
  return false
}

/**
 * Check if user has already enabled or explicitly disabled push
 */
const hasUserDecided = (): boolean => {
  // If they've subscribed, they've decided
  if (isSubscribed.value) return true
  
  // If permission is denied, they've decided (in browser settings)
  if (permission.value === 'denied') return true
  
  // Check if they explicitly disabled in our settings
  const disabled = localStorage.getItem('harmony-push-disabled')
  if (disabled === 'true') return true
  
  return false
}

/**
 * Determine if we should show the prompt
 */
const shouldShowPrompt = (): boolean => {
  // Must be supported
  if (!isSupported.value) {
    debug.log('🔔 Push prompt: Not supported')
    return false
  }
  
  // Must be a PWA (installed app)
  if (!isPWA()) {
    debug.log('🔔 Push prompt: Not a PWA, skipping')
    return false
  }
  
  // User hasn't already decided
  if (hasUserDecided()) {
    debug.log('🔔 Push prompt: User already decided')
    return false
  }
  
  // Not recently dismissed
  if (wasRecentlyDismissed()) {
    debug.log('🔔 Push prompt: Recently dismissed')
    return false
  }
  
  debug.log('🔔 Push prompt: Should show!', { isPWA: isPWA(), isMobile: isMobileUserAgent() })
  return true
}

const enablePush = async () => {
  enabling.value = true
  
  try {
    const result = await subscribe()
    
    if (result.success) {
      showBanner.value = false
      debug.log('✅ Push notifications enabled from prompt')
    } else {
      debug.error('Failed to enable push:', result.error)
      // If permission denied, don't show again
      if (permission.value === 'denied') {
        closeBanner()
      }
    }
  } catch (error) {
    debug.error('Error enabling push:', error)
  } finally {
    enabling.value = false
  }
}

const dismissBanner = () => {
  showBanner.value = false
  // Remember dismissal for 7 days
  localStorage.setItem('harmony-push-prompt-dismissed', Date.now().toString())
  debug.log('🔔 Push prompt dismissed (7 days)')
}

const closeBanner = () => {
  showBanner.value = false
  // Remember close for 30 days
  localStorage.setItem('harmony-push-prompt-closed', Date.now().toString())
  debug.log('🔔 Push prompt closed (30 days)')
}

onMounted(async () => {
  // Only initialize push system if PWA (to avoid unnecessary VAPID fetch)
  if (isPWA()) {
    await initialize()
  }
  
  // Wait a bit after app load to not overwhelm user
  setTimeout(() => {
    if (shouldShowPrompt()) {
      showBanner.value = true
    }
  }, 3000) // 3 second delay
})
</script>

<style scoped>
.push-notification-banner {
  position: fixed;
  bottom: 20px;
  left: 20px;
  right: 20px;
  max-width: 500px;
  margin: 0 auto;
  background: linear-gradient(135deg, #0EA5E9, #0284C7);
  border-radius: 16px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  z-index: 10000;
  overflow: hidden;
}

.banner-content {
  display: flex;
  align-items: center;
  padding: 16px;
  gap: 12px;
  position: relative;
}

.banner-icon {
  width: 48px;
  height: 48px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.banner-icon svg {
  color: var(--text-primary);
}

.banner-text {
  flex: 1;
  min-width: 0;
}

.banner-text h3 {
  margin: 0 0 4px 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.banner-text p {
  margin: 0;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.85);
  line-height: 1.4;
}

.banner-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.banner-btn {
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  border: none;
}

.banner-btn.primary {
  background: white;
  color: #0EA5E9;
}

.banner-btn.primary:hover:not(:disabled) {
  background: #f0f0f0;
  transform: translateY(-1px);
}

.banner-btn.primary:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.banner-btn.secondary {
  background: rgba(255, 255, 255, 0.15);
  color: var(--text-primary);
}

.banner-btn.secondary:hover {
  background: rgba(255, 255, 255, 0.25);
}

.close-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 28px;
  height: 28px;
  border: none;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.7);
  transition: all 0.2s ease;
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.2);
  color: var(--text-primary);
}

/* Mobile adjustments */
@media (max-width: 480px) {
  .push-notification-banner {
    left: 12px;
    right: 12px;
    bottom: 12px;
  }
  
  .banner-content {
    flex-wrap: wrap;
    padding: 14px;
  }
  
  .banner-icon {
    width: 40px;
    height: 40px;
  }
  
  .banner-text {
    flex-basis: calc(100% - 60px);
  }
  
  .banner-text h3 {
    font-size: 15px;
  }
  
  .banner-text p {
    font-size: 12px;
  }
  
  .banner-actions {
    width: 100%;
    justify-content: flex-end;
    margin-top: 8px;
  }
}

/* Transitions */
.push-banner-enter-active,
.push-banner-leave-active {
  transition: all 0.3s ease;
}

.push-banner-enter-from {
  transform: translateY(100%);
  opacity: 0;
}

.push-banner-leave-to {
  transform: translateY(100%);
  opacity: 0;
}
</style>

