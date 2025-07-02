import { useServerUsersStore } from '@/stores/useServerUsers'
import type { UserStatus } from '@/types'

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