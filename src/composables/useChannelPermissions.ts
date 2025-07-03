import { computed } from 'vue'
import { useServerPermissions, ServerPermission } from './useServerPermissions'

export function useChannelPermissions() {
  const { hasCurrentUserPermission, channelPermissions } = useServerPermissions()

  // Check if user can perform drag and drop operations
  const canDragAndDrop = computed(() => 
    hasCurrentUserPermission(ServerPermission.MANAGE_CHANNELS)
  )

  // Check if user can reorder channels within categories
  const canReorderChannels = computed(() => 
    channelPermissions.value.canReorderChannels
  )

  // Check if user can reorder categories
  const canReorderCategories = computed(() => 
    channelPermissions.value.canReorderCategories
  )

  // Check if user can move channels between categories
  const canMoveChannelsBetweenCategories = computed(() => 
    channelPermissions.value.canMoveChannels
  )

  // Check if user can create new channels
  const canCreateChannels = computed(() => 
    channelPermissions.value.canCreateChannels
  )

  // Check if user can delete channels
  const canDeleteChannels = computed(() => 
    channelPermissions.value.canDeleteChannels
  )

  // Check if user can edit channel properties
  const canEditChannels = computed(() => 
    channelPermissions.value.canEditChannels
  )

  // Check if user can create categories
  const canCreateCategories = computed(() => 
    channelPermissions.value.canCreateCategories
  )

  // Check if user can delete categories
  const canDeleteCategories = computed(() => 
    channelPermissions.value.canDeleteCategories
  )

  // Validate if a drag and drop operation is allowed
  const validateDragAndDrop = (
    dragType: 'channel' | 'category',
    dropType: 'channel' | 'category' | 'category-content'
  ): boolean => {
    if (!canDragAndDrop.value) return false

    // Channel reordering within same category
    if (dragType === 'channel' && dropType === 'channel') {
      return canReorderChannels.value
    }

    // Channel moving between categories
    if (dragType === 'channel' && dropType === 'category-content') {
      return canMoveChannelsBetweenCategories.value
    }

    // Category reordering
    if (dragType === 'category' && dropType === 'category') {
      return canReorderCategories.value
    }

    return false
  }

  // Get appropriate cursor style for drag operations
  const getDragCursor = (
    dragType: 'channel' | 'category',
    dropType?: 'channel' | 'category' | 'category-content'
  ): string => {
    if (!canDragAndDrop.value) return 'not-allowed'
    
    if (dropType && !validateDragAndDrop(dragType, dropType)) {
      return 'not-allowed'
    }

    return 'move'
  }

  // Check if user can perform any channel management actions
  const hasAnyChannelPermissions = computed(() => 
    canCreateChannels.value || 
    canDeleteChannels.value || 
    canEditChannels.value || 
    canDragAndDrop.value
  )

  // Check if user can perform any category management actions
  const hasAnyCategoryPermissions = computed(() => 
    canCreateCategories.value || 
    canDeleteCategories.value || 
    canDragAndDrop.value
  )

  return {
    // Drag and drop permissions
    canDragAndDrop,
    canReorderChannels,
    canReorderCategories,
    canMoveChannelsBetweenCategories,
    
    // CRUD permissions
    canCreateChannels,
    canDeleteChannels,
    canEditChannels,
    canCreateCategories,
    canDeleteCategories,
    
    // Helper functions
    validateDragAndDrop,
    getDragCursor,
    hasAnyChannelPermissions,
    hasAnyCategoryPermissions
  }
}