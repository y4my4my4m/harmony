import { useServerUsersStore } from '@/stores/useServerUsers'
import type { UserStatus, Channel } from '@/types'

export function useUserProfile() {
  const serverUsersStore = useServerUsersStore()

  const getUserAvatar = (userId: string) => {
    return serverUsersStore.userProfiles[userId]?.avatar_url || '/default_avatar.png'
  }

  const getUserDisplayName = (userId: string) => {
    return serverUsersStore.userProfiles[userId]?.display_name || 'Unknown User'
  }

  const getUserColor = (userId: string) => {
    return serverUsersStore.userProfiles[userId]?.color || '#ffffff'
  }

  const getUserStatus = (userId: string) => {
    return serverUsersStore.userProfiles[userId]?.status || 0
  }

  const getUserStatusClass = (status: UserStatus) => {
    switch (status) {
      case 1: // Online
        return 'status-online'
      case 2: // Away
        return 'status-away'
      case 3: // Busy
        return 'status-busy'
      case 0: // Offline
      default:
        return 'status-offline'
    }
  }

  const getUserStatusText = (status: UserStatus) => {
    switch (status) {
      case 1: // Online
        return 'Online'
      case 2: // Away
        return 'Away'
      case 3: // Busy
        return 'Do Not Disturb'
      case 0: // Offline
      default:
        return 'Offline'
    }
  }

  return {
    getUserAvatar,
    getUserDisplayName,
    getUserColor,
    getUserStatus,
    getUserStatusClass,
    getUserStatusText
  }
}

export function useChannelSelection() {
  const getDefaultChannel = (channels: Channel[], categories: any[], categoryChannels: Record<string, Channel[]>) => {
    // Priority order for channel selection:
    // 1. First text channel in first category
    // 2. First orphan text channel 
    // 3. Any first channel as fallback

    // Try to find first text channel in first category
    if (categories && categories.length > 0) {
      for (const category of categories) {
        const categoryChannelList = categoryChannels[category.id] || []
        const firstTextChannel = categoryChannelList.find(ch => ch.type === 0) // Text channel
        if (firstTextChannel) {
          return firstTextChannel.id
        }
      }
    }

    // Try to find first orphan text channel
    const orphanChannels = channels.filter(channel => !channel.category)
    const firstOrphanTextChannel = orphanChannels.find(ch => ch.type === 0)
    if (firstOrphanTextChannel) {
      return firstOrphanTextChannel.id
    }

    // Fallback to any first available channel
    const firstChannel = channels.find(ch => ch.type === 0) || channels[0]
    return firstChannel?.id || null
  }

  return {
    getDefaultChannel
  }
}