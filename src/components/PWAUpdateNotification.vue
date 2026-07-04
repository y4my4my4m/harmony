<template>
  <Transition name="update-notification">
    <div v-if="showUpdate" class="pwa-update-notification">
      <div class="update-content">
        <div class="update-icon">
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path fill="currentColor" d="M12,18A6,6 0 0,1 6,12C6,11 6.25,10.03 6.7,9.2L5.24,7.74C4.46,8.97 4,10.43 4,12A8,8 0 0,0 12,20V23L16,19L12,15M12,4V1L8,5L12,9V6A6,6 0 0,1 18,12C18,13 17.75,13.97 17.3,14.8L18.76,16.26C19.54,15.03 20,13.57 20,12A8,8 0 0,0 12,4Z"/>
          </svg>
        </div>
        <div class="update-text">
          <h3>Update Available</h3>
          <p>A new version of Harmony is ready to install</p>
        </div>
        <div class="update-actions">
          <button @click="dismissUpdate" class="update-btn secondary">
            Later
          </button>
          <button @click="installUpdate" class="update-btn primary" :disabled="updating">
            <span v-if="updating">Updating...</span>
            <span v-else>Update Now</span>
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { debug } from '@/utils/debug'
import { isPWA } from '@/utils/pwaUtils'

const showUpdate = ref(false)
const updating = ref(false)
let updateWaiting: ServiceWorker | null = null

const handleServiceWorkerUpdate = (event: any) => {
  debug.log('🔔 Service Worker update event received:', event.detail)
  
  // Only show update notification for PWA users
  // Regular browser users will get updates on next page load anyway
  if (!isPWA()) {
    debug.log('📱 Not a PWA, skipping update notification (will auto-update on reload)')
    return
  }
  
  if (event.detail?.newWorker) {
    updateWaiting = event.detail.newWorker
  } else if (event.detail?.registration?.waiting) {
    updateWaiting = event.detail.registration.waiting
  } else if (event.target?.waiting) {
    updateWaiting = event.target.waiting
  }
  
  if (updateWaiting) {
    debug.log('✅ Waiting service worker found, showing update notification')
    showUpdate.value = true
  } else {
    debug.warn('⚠️ No waiting service worker in event')
  }
}

const installUpdate = async () => {
  updating.value = true
  
  try {
    const registration = await navigator.serviceWorker.getRegistration()
    const waitingSW = registration?.waiting || updateWaiting
    
    if (!waitingSW) {
      debug.warn('No waiting service worker found, forcing reload')
      window.location.reload()
      return
    }
    
    // Set up the controller change listener BEFORE sending skip waiting
    const controllerChangePromise = new Promise<void>((resolve) => {
      const handleControllerChange = () => {
        debug.log('✅ Service Worker: Controller changed, reloading...')
        navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange)
        resolve()
      }
      navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange)
    })
    
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        debug.warn('⏰ Service Worker: Controller change timeout, forcing reload')
        resolve()
      }, 3000) // 3 second timeout
    })
    
    // Tell the waiting service worker to skip waiting
    debug.log('📤 Sending SKIP_WAITING to service worker...')
    waitingSW.postMessage({ type: 'SKIP_WAITING' })
    
    await Promise.race([controllerChangePromise, timeoutPromise])
    
    // Small delay to ensure SW is fully active
    await new Promise(resolve => setTimeout(resolve, 100))
    
    debug.log('🔄 Reloading page...')
    window.location.reload()
  } catch (error) {
    debug.error('Failed to update app:', error)
    // Force reload anyway on error
    debug.log('⚠️ Error during update, forcing reload...')
    window.location.reload()
  }
}

const dismissUpdate = () => {
  showUpdate.value = false
  sessionStorage.setItem('harmony-update-dismissed', 'true')
}

onMounted(() => {
  // Listen for service worker update events
  window.addEventListener('sw-update-available', handleServiceWorkerUpdate)
  
  // Check for existing waiting service worker (only for PWA)
  if ('serviceWorker' in navigator && isPWA()) {
    navigator.serviceWorker.getRegistration().then(registration => {
      if (registration?.waiting) {
        updateWaiting = registration.waiting
        const dismissed = sessionStorage.getItem('harmony-update-dismissed')
        if (!dismissed) {
          debug.log('📱 PWA has waiting service worker, showing update notification')
          showUpdate.value = true
        }
      }
    })
  }
})

onUnmounted(() => {
  window.removeEventListener('sw-update-available', handleServiceWorkerUpdate)
})
</script>

<style scoped>
.pwa-update-notification {
  position: fixed;
  top: 20px;
  left: 20px;
  right: 20px;
  background: linear-gradient(135deg, #00d4aa, #00b894);
  border-radius: 12px;
  box-shadow: 
    0 8px 32px rgba(0, 212, 170, 0.3),
    0 4px 16px rgba(0, 0, 0, 0.2);
  z-index: 1001;
  max-width: 500px;
  margin: 0 auto;
}

@media (min-width: 768px) {
  .pwa-update-notification {
    left: auto;
    right: 20px;
    max-width: 400px;
  }
}

.update-content {
  padding: 16px 20px;
  display: flex;
  align-items: center;
  gap: 16px;
  color: var(--text-primary);
}

.update-icon {
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 10px;
  padding: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.update-text {
  flex: 1;
  min-width: 0;
}

.update-text h3 {
  margin: 0 0 4px;
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
}

.update-text p {
  margin: 0;
  font-size: 14px;
  color: rgba(255, 255, 255, 0.9);
  line-height: 1.4;
}

.update-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.update-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.update-btn.primary {
  background: white;
  color: #00b894;
}

.update-btn.primary:hover:not(:disabled) {
  background: #f8f9fa;
  transform: translateY(-1px);
}

.update-btn.primary:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.update-btn.secondary {
  background: rgba(255, 255, 255, 0.2);
  color: var(--text-primary);
  border: 1px solid rgba(255, 255, 255, 0.3);
}

.update-btn.secondary:hover {
  background: rgba(255, 255, 255, 0.3);
}

/* Animations */
.update-notification-enter-active,
.update-notification-leave-active {
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.update-notification-enter-from {
  opacity: 0;
  transform: translateY(-100%) scale(0.9);
}

.update-notification-leave-to {
  opacity: 0;
  transform: translateY(-100%) scale(0.9);
}

/* Mobile optimizations */
@media (max-width: 480px) {
  .pwa-update-notification {
    top: 10px;
    left: 10px;
    right: 10px;
  }
  
  .update-content {
    padding: 14px 16px;
    flex-direction: column;
    text-align: center;
    gap: 12px;
  }
  
  .update-actions {
    width: 100%;
  }
  
  .update-btn {
    flex: 1;
  }
}
</style>
