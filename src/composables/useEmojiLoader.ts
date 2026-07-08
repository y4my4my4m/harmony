/**
 * Centralized emoji loading composable
 * Ensures emoji data (unified pack + server emojis) is loaded for autocomplete and picker
 * Loads in background, non-blocking
 */
import { ref } from 'vue'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useUnifiedEmoji } from '@/services/unifiedEmojiService'
import { debug } from '@/utils/debug'

let emojiDataLoadInitiated = false
let emojiDataLoadPromise: Promise<void> | null = null

/**
 * Ensure emoji data is loaded (unified pack + server emojis)
 * This is called by autocomplete and emoji picker to ensure data is available
 * Returns immediately, loads in background
 */
export async function ensureEmojiDataLoaded(): Promise<void> {
  // If already initiated, return the existing promise
  if (emojiDataLoadPromise) {
    return emojiDataLoadPromise
  }
  
  if (emojiDataLoadInitiated) {
    return Promise.resolve()
  }
  
  emojiDataLoadInitiated = true
  
  emojiDataLoadPromise = (async () => {
    try {
      const emojiCacheStore = useEmojiCacheStore()
      const serverChannelStore = useServerChannelStore()
      const { isLoaded: unifiedLoaded, reload: loadUnifiedEmojiData } = useUnifiedEmoji()
      
      if (!unifiedLoaded.value) {
        await loadUnifiedEmojiData()
        debug.log('Unified emoji data loaded')
      }
      
      if (!emojiCacheStore.isInitialized) {
        const allServerIds = serverChannelStore.servers.map(server => server.id)
        if (allServerIds.length > 0) {
          const currentServerId = serverChannelStore.currentServerId || allServerIds[0]
          const otherServerIds = allServerIds.filter(id => id !== currentServerId)
          
          await emojiCacheStore.initializeSelective(
            currentServerId ? [currentServerId] : [],
            otherServerIds
          )
          debug.log('Emoji cache initialized')
        }
      } else {
        // Already initialized, but ensure all servers are loaded
        const allServerIds = serverChannelStore.servers.map(server => server.id)
        const loadedServerIds = Array.from(emojiCacheStore.serverCaches.keys())
        const missingServerIds = allServerIds.filter(id => !loadedServerIds.includes(id))
        
        if (missingServerIds.length > 0) {
          await emojiCacheStore.loadEmojisForServers(missingServerIds)
          debug.log(`Loaded emojis for ${missingServerIds.length} additional servers`)
        }
      }
    } catch (error) {
      debug.warn('Failed to load emoji data:', error)
    } finally {
      // Reset promise after completion so it can be called again if needed
      emojiDataLoadPromise = null
    }
  })()
  
  return emojiDataLoadPromise
}

/**
 * Trigger emoji data loading in background (non-blocking)
 * Use this when you want to preload emojis but don't need to wait
 */
export function triggerEmojiDataLoad(): void {
  setTimeout(() => {
    ensureEmojiDataLoaded().catch(err => {
      debug.warn('Background emoji load failed:', err)
    })
  }, 500)
}

/**
 * Composable that provides emoji loading state and functions
 */
export function useEmojiLoader() {
  const emojiCacheStore = useEmojiCacheStore()
  const { isLoaded: unifiedLoaded, isLoading: unifiedLoading } = useUnifiedEmoji()
  
  const isEmojiDataReady = ref(false)
  
  const checkEmojiDataReady = () => {
    isEmojiDataReady.value = unifiedLoaded.value && emojiCacheStore.isInitialized
  }
  
  // Watch for changes
  const updateReadyState = () => {
    checkEmojiDataReady()
  }
  
  return {
    isEmojiDataReady,
    unifiedLoaded,
    unifiedLoading,
    emojiCacheInitialized: emojiCacheStore.isInitialized,
    ensureEmojiDataLoaded,
    triggerEmojiDataLoad,
    checkEmojiDataReady,
    updateReadyState
  }
}

