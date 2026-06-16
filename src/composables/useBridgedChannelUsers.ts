import { ref, watch, type MaybeRefOrGetter, toValue } from 'vue'
import {
  fetchBridgedChannelUsers,
  type BridgedChannelUser,
} from '@/services/bridgedChannelUsersService'

/**
 * Ephemeral bridged (Discord) members for a Harmony channel.
 * Shares cache with mention autocomplete — one fetch per channel per TTL.
 */
export function useBridgedChannelUsers(channelId: MaybeRefOrGetter<string | null | undefined>) {
  const users = ref<BridgedChannelUser[]>([])
  const hasBridge = ref(false)
  const loaded = ref(false)
  const loading = ref(false)

  watch(
    () => toValue(channelId),
    async (id) => {
      if (!id) {
        users.value = []
        hasBridge.value = false
        loaded.value = true
        return
      }

      loading.value = true
      loaded.value = false
      try {
        const result = await fetchBridgedChannelUsers(id)
        users.value = result.users
        hasBridge.value = result.hasBridge
      } finally {
        loading.value = false
        loaded.value = true
      }
    },
    { immediate: true },
  )

  return { users, hasBridge, loaded, loading }
}
