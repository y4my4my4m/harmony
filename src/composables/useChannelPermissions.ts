import { computed } from 'vue'
import { useServerPermissions } from '@/composables/useServerPermissions'

export function useChannelPermissions() {
  const {
    isCurrentUserServerOwner,
    channelPermissions,
    isLocalServer
  } = useServerPermissions()

  // One permission gates drag/create/move/delete/edit/category ops; federated servers have no local manager.
  const hasManageChannelsPermission = computed(() => {
    if (!isLocalServer.value) return false
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
        return 'pointer';
      }
      return isDragging ? 'grabbing' : 'grab';
    }

    if (itemType === 'category') {
      if (!canDragAndDrop.value) {
        return 'pointer';
      }
      return isDragging ? 'grabbing' : 'grab';
    }
    
    return 'pointer';
  }

  const validateDragAndDrop = (itemType: string, dropType: string) => {
    if (!canDragAndDrop.value) return false

    if (itemType === 'channel' && dropType === 'category') {
      return canMoveChannelsBetweenCategories.value
    }

    if (itemType === 'channel' && dropType === 'channel') {
      return canMoveChannels.value
    }
    
    return false
  }

  return {
    isServerOwner: isCurrentUserServerOwner,
    hasManageChannelsPermission,
    hasAnyChannelPermissions,
    canMoveChannels,
    canCreateChannels,
    canDeleteChannels,
    canEditChannels,
    canCreateCategories,
    canMoveChannelsBetweenCategories,
    canDragAndDrop,
    getDragCursor,
    validateDragAndDrop,
  }
}