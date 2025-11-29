/**
 * useRealtimeStatus Composable
 * 
 * Provides reactive access to realtime connection status across the app.
 * Use this composable when you need to react to connection changes in your components.
 * 
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { useRealtimeStatus } from '@/composables/useRealtimeStatus'
 * 
 * const { status, isConnected, isReconnecting, forceReconnect } = useRealtimeStatus()
 * </script>
 * 
 * <template>
 *   <div v-if="!isConnected">
 *     <span v-if="isReconnecting">Reconnecting...</span>
 *     <button @click="forceReconnect">Retry</button>
 *   </div>
 * </template>
 * ```
 */

import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { realtimeConnectionManager, type ConnectionStatus } from '@/services/RealtimeConnectionManager'

export function useRealtimeStatus() {
  // Reactive state
  const status = ref<ConnectionStatus>('disconnected')
  const subscriptionCount = ref(0)
  
  // Cleanup function
  let unsubscribe: (() => void) | null = null

  // Computed properties
  const isConnected = computed(() => status.value === 'connected')
  const isConnecting = computed(() => status.value === 'connecting')
  const isReconnecting = computed(() => status.value === 'reconnecting')
  const isError = computed(() => status.value === 'error')
  const isDisconnected = computed(() => status.value === 'disconnected')
  
  // Human-readable status text
  const statusText = computed(() => {
    switch (status.value) {
      case 'connected': return 'Connected'
      case 'connecting': return 'Connecting...'
      case 'reconnecting': return 'Reconnecting...'
      case 'error': return 'Connection Error'
      case 'disconnected': return 'Disconnected'
      default: return 'Unknown'
    }
  })

  // Methods
  const forceReconnect = () => {
    realtimeConnectionManager.forceGlobalReconnect()
  }

  const getDebugInfo = () => {
    return realtimeConnectionManager.getDebugInfo()
  }

  const getSubscriptionStatus = (channelName: string) => {
    return realtimeConnectionManager.getSubscriptionStatus(channelName)
  }

  // Status change handler
  const handleStatusChange = (newStatus: ConnectionStatus) => {
    status.value = newStatus
    subscriptionCount.value = realtimeConnectionManager.getSubscriptionCount()
  }

  // Lifecycle
  onMounted(() => {
    // Get initial status
    status.value = realtimeConnectionManager.getStatus()
    subscriptionCount.value = realtimeConnectionManager.getSubscriptionCount()
    
    // Subscribe to status changes
    unsubscribe = realtimeConnectionManager.onStatusChange(handleStatusChange)
  })

  onBeforeUnmount(() => {
    if (unsubscribe) {
      unsubscribe()
    }
  })

  return {
    // State
    status,
    subscriptionCount,
    
    // Computed
    isConnected,
    isConnecting,
    isReconnecting,
    isError,
    isDisconnected,
    statusText,
    
    // Methods
    forceReconnect,
    getDebugInfo,
    getSubscriptionStatus
  }
}

