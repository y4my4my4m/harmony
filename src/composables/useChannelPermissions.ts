import { computed } from 'vue'
import { useServerPermissions } from '@/composables/useServerPermissions'

export function useChannelPermissions() {
  // Use the centralized server permissions composable that properly fetches from roleService
  const { 
    isCurrentUserServerOwner,
    channelPermissions,
    isLocalServer
  } = useServerPermissions()

  // Consistent permission model: owner bypass + isLocalServer check for all channel operations
  // One permission gates drag/create/move/delete so the operations stay coherent
  const hasManageChannelsPermission = computed(() => {
    // For federated servers, no local user can manage channels
    if (!isLocalServer.value) return false
    // For local servers, owner always has full access
    return isCurrentUserServerOwner.value || channelPermissions.value.canMoveChannels
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

  const getDragCursor = (itemType: 'channel' | 'category', isDragging = false) => {
    if (itemType === 'channel') {
      if (!canDragAndDrop.value) {
        return 'pointer'; // Allow selection even without drag permission
      }
      return isDragging ? 'grabbing' : 'grab';
    }
    
    if (itemType === 'category') {
      if (!canDragAndDrop.value) {
        return 'pointer'; // Allow selection even without drag permission
      }
      return isDragging ? 'grabbing' : 'grab';
    }
    
    return 'pointer';
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
    // Server-level permissions
    isServerOwner: isCurrentUserServerOwner,
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

    // Drag & Drop utilities
    getDragCursor,
    validateDragAndDrop,
  }
}