import { ref, watch, onScopeDispose, type MaybeRefOrGetter, toValue } from 'vue'
import {
  fetchBridgedChannelUsers,
  type BridgedChannelUser,
} from '@/services/bridgedChannelUsersService'

const PRESENCE_POLL_MS = 60_000

/**
 * Ephemeral bridged (Discord / Matrix) members for a Harmony channel.
 * Shares cache with mention autocomplete - one fetch per channel per TTL.
 * Polls periodically while mounted so Discord presence stays reasonably fresh.
 */
export function useBridgedChannelUsers(channelId: MaybeRefOrGetter<string | null | undefined>) {
  const users = ref<BridgedChannelUser[]>([])
  const hasBridge = ref(false)
  const loaded = ref(false)
  const loading = ref(false)

  let revision = 0
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  const load = async (id: string, options: { background?: boolean } = {}) => {
    const request = revision
    if (!options.background) {
      loading.value = true
      loaded.value = false
    }
    try {
      const result = await fetchBridgedChannelUsers(id, { force: options.background })
      if (request !== revision) return
      users.value = result.users
      hasBridge.value = result.hasBridge
    } finally {
      if (request === revision && !options.background) {
        loading.value = false
        loaded.value = true
      }
    }
  }

  watch(
    () => toValue(channelId),
    async (id) => {
      const request = ++revision
      stopPolling()
      users.value = []
      hasBridge.value = false
      loading.value = false
      if (!id) {
        loaded.value = true
        return
      }

      await load(id)
      if (request !== revision) return
      pollTimer = setInterval(() => {
        void load(id, { background: true })
      }, PRESENCE_POLL_MS)
    },
    { immediate: true },
  )

  onScopeDispose(() => { revision++; stopPolling() })

  return { users, hasBridge, loaded, loading }
}
