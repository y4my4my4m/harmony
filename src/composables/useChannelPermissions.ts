import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useServerUsersStore } from '@/stores/useServerUsers'
import { useServerChannelStore } from '@/stores/useServerChannel'

export function useChannelPermissions() {
  const authStore = useAuthStore()
  const serverUsersStore = useServerUsersStore()
  const serverChannelStore = useServerChannelStore()

  const currentUserId = computed(() => authStore.session?.user?.id)
  const currentServerId = computed(() => serverChannelStore.currentServerId)
  
  const userRoles = computed(() => {
    if (!currentUserId.value || !currentServerId.value) return []
    const userProfile = serverUsersStore.userProfiles[currentUserId.value]
    return userProfile?.roles || []
  })

  const isServerOwner = computed(() => {
    if (!currentUserId.value || !currentServerId.value) return false
    const server = serverChannelStore.currentServer
    return server?.owner === currentUserId.value
  })

  const hasAdminRole = computed(() => {
    return userRoles.value.some(role => role.permissions?.includes('administrator'))
  })

  const hasManageChannelsPermission = computed(() => {
    return isServerOwner.value || 
           hasAdminRole.value || 
           userRoles.value.some(role => role.permissions?.includes('manage_channels'))
  })

  const canMoveChannels = computed(() => {
    return hasManageChannelsPermission.value
  })

  const canCreateChannels = computed(() => {
    return hasManageChannelsPermission.value
  })

  const canDeleteChannels = computed(() => {
    return hasManageChannelsPermission.value
  })

  const canEditChannels = computed(() => {
    return hasManageChannelsPermission.value
  })

  const canCreateCategories = computed(() => {
    return hasManageChannelsPermission.value
  })

  const canMoveChannelsBetweenCategories = computed(() => {
    return hasManageChannelsPermission.value
  })

  const canDragAndDrop = computed(() => {
    return hasManageChannelsPermission.value
  })

  const hasAnyChannelPermissions = computed(() => {
    return hasManageChannelsPermission.value
  })

  const canViewChannel = (channelId: string) => {
    // Basic implementation - can be extended with channel-specific permissions
    return true
  }

  const canAccessChannel = (channelId: string) => {
    // Basic implementation - can be extended with channel-specific permissions
    return true
  }

  const getDragCursor = (itemType: string) => {
    if (!canDragAndDrop.value) return 'not-allowed'
    return itemType === 'channel' ? 'move' : 'grab'
  }

  const validateDragAndDrop = (itemType: string, dropType: string) => {
    if (!canDragAndDrop.value) return false
    
    // Allow channel to category moves
    if (itemType === 'channel' && dropType === 'category') {
      return canMoveChannelsBetweenCategories.value
    }
    
    // Allow channel reordering within same category
    if (itemType === 'channel' && dropType === 'channel') {
      return canMoveChannels.value
    }
    
    return false
  }

  return {
    // User info
    currentUserId,
    currentServerId,
    userRoles,
    
    // Server-level permissions
    isServerOwner,
    hasAdminRole,
    hasManageChannelsPermission,
    hasAnyChannelPermissions,
    
    // Channel permissions
    canMoveChannels,
    canCreateChannels,
    canDeleteChannels,
    canEditChannels,
    canCreateCategories,
    canMoveChannelsBetweenCategories,
    canDragAndDrop,
    canViewChannel,
    canAccessChannel,
    
    // Drag & Drop utilities
    getDragCursor,
    validateDragAndDrop,
  }
}