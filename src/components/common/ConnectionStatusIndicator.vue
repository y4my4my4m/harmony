<script setup lang="ts">
/**
 * ConnectionStatusIndicator
 * 
 * Shows real-time connection status with Discord/Slack-like UX.
 * Displays a toast-like notification when connection issues occur,
 * and a subtle indicator when reconnecting.
 */
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { realtimeConnectionManager, type ConnectionStatus } from '@/services/RealtimeConnectionManager'

// Props
interface Props {
  /** Show even when connected (for debugging) */
  showWhenConnected?: boolean
  /** Position of the indicator */
  position?: 'top' | 'bottom'
  /** Compact mode - just a dot */
  compact?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  showWhenConnected: false,
  position: 'bottom',
  compact: false
})

// State
const status = ref<ConnectionStatus>('disconnected')
const isVisible = ref(false)
const subscriptionCount = ref(0)
let unsubscribe: (() => void) | null = null
let hideTimeout: ReturnType<typeof setTimeout> | null = null

// Computed
const statusConfig = computed(() => {
  switch (status.value) {
    case 'connected':
      return {
        icon: '●',
        text: 'Connected',
        class: 'status-connected',
        emoji: '✅'
      }
    case 'connecting':
      return {
        icon: '◐',
        text: 'Connecting...',
        class: 'status-connecting',
        emoji: '🔄'
      }
    case 'reconnecting':
      return {
        icon: '◐',
        text: 'Reconnecting...',
        class: 'status-reconnecting',
        emoji: '🔄'
      }
    case 'error':
      return {
        icon: '●',
        text: 'Connection Error',
        class: 'status-error',
        emoji: '⚠️'
      }
    case 'disconnected':
    default:
      return {
        icon: '○',
        text: 'Disconnected',
        class: 'status-disconnected',
        emoji: '📡'
      }
  }
})

const shouldShow = computed(() => {
  if (props.showWhenConnected) return true
  return status.value !== 'connected'
})

// Methods
const handleStatusChange = (newStatus: ConnectionStatus) => {
  status.value = newStatus
  subscriptionCount.value = realtimeConnectionManager.getSubscriptionCount()
  
  // Clear any pending hide timeout
  if (hideTimeout) {
    clearTimeout(hideTimeout)
    hideTimeout = null
  }
  
  // Show indicator for non-connected states
  if (newStatus !== 'connected') {
    isVisible.value = true
  } else {
    // Hide after a delay when connected (to show "Connected" briefly)
    hideTimeout = setTimeout(() => {
      if (!props.showWhenConnected) {
        isVisible.value = false
      }
    }, 2000)
  }
}

const forceReconnect = () => {
  realtimeConnectionManager.forceGlobalReconnect()
}

// Lifecycle
onMounted(() => {
  // Get initial status
  status.value = realtimeConnectionManager.getStatus()
  subscriptionCount.value = realtimeConnectionManager.getSubscriptionCount()
  
  // Subscribe to status changes
  unsubscribe = realtimeConnectionManager.onStatusChange(handleStatusChange)
  
  // Show if not connected
  if (status.value !== 'connected') {
    isVisible.value = true
  }
})

onBeforeUnmount(() => {
  if (unsubscribe) {
    unsubscribe()
  }
  if (hideTimeout) {
    clearTimeout(hideTimeout)
  }
})
</script>

<template>
  <Transition name="slide-fade">
    <div 
      v-if="shouldShow || isVisible"
      class="connection-status-indicator"
      :class="[
        statusConfig.class,
        `position-${position}`,
        { compact }
      ]"
      @click="status === 'error' && forceReconnect()"
    >
      <!-- Compact mode: just a pulsing dot -->
      <template v-if="compact">
        <span class="status-dot" :class="{ pulse: status === 'reconnecting' || status === 'connecting' }">
          {{ statusConfig.icon }}
        </span>
      </template>
      
      <!-- Full mode: icon + text -->
      <template v-else>
        <span class="status-icon" :class="{ spin: status === 'reconnecting' || status === 'connecting' }">
          {{ statusConfig.emoji }}
        </span>
        <span class="status-text">{{ statusConfig.text }}</span>
        <span v-if="subscriptionCount > 0 && showWhenConnected" class="subscription-count">
          ({{ subscriptionCount }} channels)
        </span>
        <button 
          v-if="status === 'error'" 
          class="retry-button"
          @click.stop="forceReconnect"
        >
          Retry
        </button>
      </template>
    </div>
  </Transition>
</template>

<style scoped>
.connection-status-indicator {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 500;
  backdrop-filter: blur(10px);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
  transition: all 0.3s ease;
  cursor: default;
  user-select: none;
}

.position-top {
  top: 16px;
}

.position-bottom {
  bottom: 16px;
}

/* Compact mode */
.compact {
  padding: 6px 12px;
  border-radius: 50%;
  width: 24px;
  height: 24px;
  justify-content: center;
}

.compact .status-dot {
  font-size: 12px;
  line-height: 1;
}

/* Status colors */
.status-connected {
  background: rgba(46, 204, 113, 0.9);
  color: white;
}

.status-connecting,
.status-reconnecting {
  background: rgba(241, 196, 15, 0.9);
  color: #2c3e50;
}

.status-error {
  background: rgba(231, 76, 60, 0.9);
  color: white;
  cursor: pointer;
}

.status-error:hover {
  background: rgba(192, 57, 43, 0.95);
}

.status-disconnected {
  background: rgba(127, 140, 141, 0.9);
  color: white;
}

/* Icons */
.status-icon {
  font-size: 16px;
}

.status-icon.spin {
  animation: spin 1s linear infinite;
}

.status-dot.pulse {
  animation: pulse 1s ease-in-out infinite;
}

/* Retry button */
.retry-button {
  background: rgba(255, 255, 255, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.4);
  color: inherit;
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.retry-button:hover {
  background: rgba(255, 255, 255, 0.3);
}

.subscription-count {
  opacity: 0.7;
  font-size: 11px;
}

/* Animations */
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* Transitions */
.slide-fade-enter-active,
.slide-fade-leave-active {
  transition: all 0.3s ease;
}

.slide-fade-enter-from {
  opacity: 0;
  transform: translateX(-50%) translateY(-20px);
}

.slide-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-20px);
}

.position-bottom.slide-fade-enter-from,
.position-bottom.slide-fade-leave-to {
  transform: translateX(-50%) translateY(20px);
}

/* Dark mode support */
@media (prefers-color-scheme: dark) {
  .status-connecting,
  .status-reconnecting {
    background: rgba(241, 196, 15, 0.85);
    color: #1a1a2e;
  }
}
</style>
