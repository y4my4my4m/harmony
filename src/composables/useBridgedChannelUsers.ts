import { ref, watch, onScopeDispose, type MaybeRefOrGetter, toValue } from 'vue'
import {
  fetchBridgedChannelUsers,
  type BridgedChannelUser,
} from '@/services/bridgedChannelUsersService'

const PRESENCE_POLL_MS = 60_000

/**
 * Ephemeral bridged (Discord) members for a Harmony channel.
 * Shares cache with mention autocomplete — one fetch per channel per TTL.
 * Polls periodically while mounted so Discord presence stays reasonably fresh.
 */
export function useBridgedChannelUsers(channelId: MaybeRefOrGetter<string | null | undefined>) {
  const users = ref<BridgedChannelUser[]>([])
  const hasBridge = ref(false)
  const loaded = ref(false)
  const loading = ref(false)

  let pollTimer: ReturnType<typeof setInterval> | null = null

  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  const load = async (id: string, options: { background?: boolean } = {}) => {
    if (!options.background) {
      loading.value = true
      loaded.value = false
    }
    try {
      const result = await fetchBridgedChannelUsers(id, { force: options.background })
      users.value = result.users
      hasBridge.value = result.hasBridge
    } finally {
      if (!options.background) {
        loading.value = false
        loaded.value = true
      }
    }
  }

  watch(
    () => toValue(channelId),
    async (id) => {
      stopPolling()
      if (!id) {
        users.value = []
        hasBridge.value = false
        loaded.value = true
        return
      }

      await load(id)
      pollTimer = setInterval(() => {
        void load(id, { background: true })
      }, PRESENCE_POLL_MS)
    },
    { immediate: true },
  )

  onScopeDispose(stopPolling)

  return { users, hasBridge, loaded, loading }
}
