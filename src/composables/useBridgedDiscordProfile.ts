import { ref } from 'vue'
import type { BridgedChannelUser } from '@/services/bridgedChannelUsersService'
import {
  discordMetadataToBridgedUser,
  findBridgedUserInCache,
} from '@/services/bridgedChannelUsersService'

const show = ref(false)
const profileUser = ref<BridgedChannelUser | null>(null)

export function useBridgedDiscordProfile() {
  function open(user: BridgedChannelUser) {
    profileUser.value = user
    show.value = true
  }

  function close() {
    show.value = false
    profileUser.value = null
  }

  function openFromDiscordMetadata(
    meta: {
      id: string
      username: string
      display_name?: string
      avatar_url?: string
    },
    channelId?: string | null,
  ) {
    const cached = channelId ? findBridgedUserInCache(channelId, meta.id) : null
    open(cached ?? discordMetadataToBridgedUser(meta))
  }

  return {
    show,
    profileUser,
    open,
    openFromDiscordMetadata,
    close,
  }
}
