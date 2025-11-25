import { computed, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useUserData } from '@/composables/useUserData'
import { supabase } from '@/supabase'
import type { Server } from '@/types'

export enum ServerPermission {
  MANAGE_SERVER = 'MANAGE_SERVER',
  MANAGE_CHANNELS = 'MANAGE_CHANNELS',
  MANAGE_EMOJIS = 'MANAGE_EMOJIS',
  MANAGE_ROLES = 'MANAGE_ROLES',
  VIEW_AUDIT_LOG = 'VIEW_AUDIT_LOG',
  KICK_MEMBERS = 'KICK_MEMBERS',
  BAN_MEMBERS = 'BAN_MEMBERS',
  CREATE_INVITE = 'CREATE_INVITE',
  MANAGE_MESSAGES = 'MANAGE_MESSAGES',
  MODERATE_MEMBERS = 'MODERATE_MEMBERS'
}

export interface UserRole {
  id: string
  name: string
  permissions: ServerPermission[]
  isOwner: boolean
  isModerator: boolean
  isAdmin: boolean
  color?: string
  position: number
}

export function useServerPermissions() {
  const authStore = useAuthStore()
  const serverChannelStore = useServerChannelStore()
  const { getCurrentUser } = useUserData()

  const currentUserId = computed(() => authStore.session?.user?.id || null)
  const fetchedProfileId = ref<string | null>(null)
  const isFetchingProfileId = ref(false)

  watch(currentUserId, async (authId) => {
    if (!authId) {
      fetchedProfileId.value = null
      return
    }
    if (getCurrentUser.value?.id === fetchedProfileId.value) return
    if (isFetchingProfileId.value) return
    isFetchingProfileId.value = true
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id')
        .eq('auth_user_id', authId)
        .maybeSingle()
      if (error) {
        console.warn('Failed to load profile id for auth user', error)
      }
      fetchedProfileId.value = data?.id || null
    } finally {
      isFetchingProfileId.value = false
    }
  }, { immediate: true })

  const currentProfileId = computed(() => getCurrentUser.value?.id || fetchedProfileId.value)
  const currentServer = computed(() => serverChannelStore.currentServer)

  // Check if user is the server owner
  const isServerOwner = (serverId: string, profileId?: string): boolean => {
    if (!profileId) return false
    const server = serverChannelStore.servers.find(s => s.id === serverId)
    return server?.owner === profileId
  }

  // Check if current user is the server owner
  const isCurrentUserServerOwner = computed(() => {
    if (!currentProfileId.value || !currentServer.value) return false
    return isServerOwner(currentServer.value.id, currentProfileId.value)
  })

  // For now, we'll use a simple role system based on server ownership
  // This can be extended to use a proper roles table in the future
  const getUserRole = (serverId: string, profileId?: string): UserRole => {
    const isOwner = isServerOwner(serverId, profileId)
    
    if (isOwner) {
      return {
        id: 'owner',
        name: 'Owner',
        permissions: Object.values(ServerPermission),
        isOwner: true,
        isModerator: true,
        isAdmin: true,
        color: '#f1c40f',
        position: 1000
      }
    }

    // TODO: In the future, fetch actual roles from database
    // For now, all non-owners are regular members
    return {
      id: 'member',
      name: 'Member',
      permissions: [ServerPermission.CREATE_INVITE],
      isOwner: false,
      isModerator: false,
      isAdmin: false,
      position: 0
    }
  }

  // Check if user has a specific permission
  const hasPermission = (
    serverId: string, 
    profileId: string, 
    permission: ServerPermission
  ): boolean => {
    const role = getUserRole(serverId, profileId)
    return role.permissions.includes(permission)
  }

  // Check if current user has a specific permission
  const hasCurrentUserPermission = (permission: ServerPermission): boolean => {
    if (!currentProfileId.value || !currentServer.value) return false
    return hasPermission(currentServer.value.id, currentProfileId.value, permission)
  }

  // Server settings permissions
  const canManageServer = computed(() => 
    hasCurrentUserPermission(ServerPermission.MANAGE_SERVER)
  )

  const canManageChannels = computed(() => 
    hasCurrentUserPermission(ServerPermission.MANAGE_CHANNELS)
  )

  const canManageEmojis = computed(() => 
    hasCurrentUserPermission(ServerPermission.MANAGE_EMOJIS)
  )

  const canViewServerSettings = computed(() => {
    // Allow viewing settings but with read-only access for non-privileged users
    return true
  })

  // Check if user can perform destructive actions
  const canPerformDestructiveActions = computed(() => 
    isCurrentUserServerOwner.value || hasCurrentUserPermission(ServerPermission.MANAGE_SERVER)
  )

  // Specific permission checks for UI components
  const serverSettingsPermissions = computed(() => ({
    canEditBasicInfo: canManageServer.value,
    canChangeServerName: canManageServer.value,
    canChangeServerDescription: canManageServer.value,
    canChangeServerIcon: canManageServer.value,
    canChangePrivacySettings: canManageServer.value,
    canUploadEmojis: canManageEmojis.value,
    canDeleteEmojis: canManageEmojis.value,
    canManageCrossServerEmojis: canManageServer.value,
    canViewSettings: canViewServerSettings.value,
    canSaveChanges: canManageServer.value,
    canDeleteServer: isCurrentUserServerOwner.value
  }))

  const channelPermissions = computed(() => ({
    canCreateChannels: canManageChannels.value,
    canDeleteChannels: canManageChannels.value,
    canEditChannels: canManageChannels.value,
    canMoveChannels: canManageChannels.value,
    canCreateCategories: canManageChannels.value,
    canDeleteCategories: canManageChannels.value,
    canReorderChannels: canManageChannels.value,
    canReorderCategories: canManageChannels.value
  }))

  // Get user's display role for UI
  const getCurrentUserRole = computed(() => {
    if (!currentProfileId.value || !currentServer.value) return null
    return getUserRole(currentServer.value.id, currentProfileId.value)
  })

  // Helper to check permissions for any server
  const checkServerPermission = (
    serverId: string, 
    permission: ServerPermission, 
    userId?: string
  ): boolean => {
    const targetProfileId = userId || currentProfileId.value
    if (!targetProfileId) return false
    return hasPermission(serverId, targetProfileId, permission)
  }

  return {
    // Permission checks
    hasPermission,
    hasCurrentUserPermission,
    checkServerPermission,
    
    // Owner checks
    isServerOwner,
    isCurrentUserServerOwner,
    
    // Role management
    getUserRole,
    getCurrentUserRole,
    
    // Computed permissions
    canManageServer,
    canManageChannels,
    canManageEmojis,
    canViewServerSettings,
    canPerformDestructiveActions,
    
    // Component-specific permissions
    serverSettingsPermissions,
    channelPermissions,
    
    // Enums and types
    ServerPermission
  }
}