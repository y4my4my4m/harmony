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

let emojiDataLoadPromise: Promise<void> | null = null
let emojiDataLoadCompletedAt = 0

// Repeat loads are rate limited rather than latched off: one call site is inside a
// computed getter, which re-runs on every dependency change. Well under the store's
// 15 minute cache TTL, so an expired cache is still repaired on the next call.
const REPEAT_LOAD_COOLDOWN_MS = 30_000

/**
 * Ensure emoji data is loaded (unified pack + server emojis)
 * This is called by autocomplete and emoji picker to ensure data is available
 * Returns immediately, loads in background
 */
export async function ensureEmojiDataLoaded(): Promise<void> {
  if (emojiDataLoadPromise) {
    return emojiDataLoadPromise
  }

  if (emojiDataLoadCompletedAt && Date.now() - emojiDataLoadCompletedAt < REPEAT_LOAD_COOLDOWN_MS) {
    return Promise.resolve()
  }

  emojiDataLoadPromise = (async () => {
    // A call made before the server list loads has nothing to fetch and must
    // not start the cooldown.
    let loadedServers = false
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
          loadedServers = true
          debug.log('Emoji cache initialized')
        }
      } else {
        // Passing every server, not only the uncached ones, lets the store's own
        // freshness filter repair caches that expired after initialization.
        const allServerIds = serverChannelStore.servers.map(server => server.id)
        if (allServerIds.length > 0) {
          await emojiCacheStore.loadEmojisForServers(allServerIds)
          loadedServers = true
        }
      }
    } catch (error) {
      debug.warn('Failed to load emoji data:', error)
    } finally {
      if (loadedServers) emojiDataLoadCompletedAt = Date.now()
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

