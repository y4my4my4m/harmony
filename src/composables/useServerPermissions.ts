import { computed, ref, watch, reactive } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useUserData } from '@/composables/useUserData'
import { authContextService } from '@/services/AuthContextService'
import { roleService, Permission, type ServerRole } from '@/services/RoleService'
import type { Server } from '@/types'
import { debug } from '@/utils/debug'

// Re-export Permission enum as ServerPermission for backwards compatibility
export { Permission as ServerPermission } from '@/services/RoleService'

export interface UserRoleInfo {
  id: string
  name: string
  permissions: Permission[]
  isOwner: boolean
  isModerator: boolean
  isAdmin: boolean
  color?: string
  position: number
  roles: ServerRole[]
}

// Cache for user permissions per server
const permissionsCache = reactive<Map<string, Record<Permission, boolean>>>(new Map())
const rolesCache = reactive<Map<string, ServerRole[]>>(new Map())
const loadingStates = reactive<Map<string, boolean>>(new Map())

export function useServerPermissions() {
  const authStore = useAuthStore()
  const serverChannelStore = useServerChannelStore()
  const { getCurrentUser } = useUserData()

  const currentUserId = computed(() => authStore.session?.user?.id || null)
  const fetchedProfileId = ref<string | null>(null)
  const isFetchingProfileId = ref(false)

  // OPTIMIZED: Use AuthContextService for cached profile ID lookup
  watch(currentUserId, async (authId) => {
    if (!authId) {
      fetchedProfileId.value = null
      return
    }
    if (getCurrentUser.value?.id === fetchedProfileId.value) return
    if (isFetchingProfileId.value) return
    isFetchingProfileId.value = true
    try {
      const context = await authContextService.getCurrentContext()
      if (context.isAuthenticated) {
        fetchedProfileId.value = context.profileId
      } else {
        fetchedProfileId.value = null
      }
    } catch (error) {
      debug.warn('Failed to get profile id from AuthContextService', error)
      fetchedProfileId.value = null
    } finally {
      isFetchingProfileId.value = false
    }
  }, { immediate: true })

  const currentProfileId = computed(() => getCurrentUser.value?.id || fetchedProfileId.value)
  const currentServer = computed(() => serverChannelStore.currentServer)

  // Get cache key for user+server
  const getCacheKey = (userId: string, serverId: string) => `${userId}-${serverId}`

  // Load permissions for a user in a server
  const loadPermissions = async (userId: string, serverId: string): Promise<Record<Permission, boolean>> => {
    const cacheKey = getCacheKey(userId, serverId)
    
    // Check cache first
    if (permissionsCache.has(cacheKey)) {
      return permissionsCache.get(cacheKey)!
    }

    // Check if already loading
    if (loadingStates.get(cacheKey)) {
      // Wait a bit and check cache again
      await new Promise(resolve => setTimeout(resolve, 100))
      if (permissionsCache.has(cacheKey)) {
        return permissionsCache.get(cacheKey)!
      }
    }

    loadingStates.set(cacheKey, true)

    try {
      const permissions = await roleService.getUserPermissions(userId, serverId)
      permissionsCache.set(cacheKey, permissions)
      return permissions
    } catch (error) {
      debug.error('Failed to load permissions:', error)
      return {} as Record<Permission, boolean>
    } finally {
      loadingStates.set(cacheKey, false)
    }
  }

  // Load roles for a user in a server
  const loadUserRoles = async (userId: string, serverId: string): Promise<ServerRole[]> => {
    const cacheKey = getCacheKey(userId, serverId)
    
    if (rolesCache.has(cacheKey)) {
      return rolesCache.get(cacheKey)!
    }

    try {
      const roles = await roleService.getUserRoles(userId, serverId)
      rolesCache.set(cacheKey, roles)
      return roles
    } catch (error) {
      debug.error('Failed to load user roles:', error)
      return []
    }
  }

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

  // Get user role info (combines owner status with database roles)
  const getUserRole = (serverId: string, profileId?: string): UserRoleInfo => {
    if (!profileId) {
      return {
        id: 'guest',
        name: 'Guest',
        permissions: [],
        isOwner: false,
        isModerator: false,
        isAdmin: false,
        position: -1,
        roles: []
      }
    }

    const isOwner = isServerOwner(serverId, profileId)
    const cacheKey = getCacheKey(profileId, serverId)
    const cachedRoles = rolesCache.get(cacheKey) || []
    const cachedPermissions = permissionsCache.get(cacheKey) || {}

    // If owner, return owner role
    if (isOwner) {
      return {
        id: 'owner',
        name: 'Owner',
        permissions: Object.values(Permission),
        isOwner: true,
        isModerator: true,
        isAdmin: true,
        color: '#f1c40f',
        position: 1000,
        roles: cachedRoles
      }
    }

    // Get highest role from cache
    const highestRole = cachedRoles[0]
    const isAdmin = cachedPermissions[Permission.ADMINISTRATOR] === true
    const isModerator = isAdmin || 
      cachedPermissions[Permission.KICK_MEMBERS] === true ||
      cachedPermissions[Permission.BAN_MEMBERS] === true ||
      cachedPermissions[Permission.MANAGE_MESSAGES] === true

    // Convert cached permissions to array
    const permissionsList = Object.entries(cachedPermissions)
      .filter(([_, value]) => value === true)
      .map(([key]) => key as Permission)

    return {
      id: highestRole?.id || 'member',
      name: highestRole?.name || 'Member',
      permissions: permissionsList,
      isOwner: false,
      isModerator,
      isAdmin,
      color: highestRole?.color,
      position: highestRole?.position || 0,
      roles: cachedRoles
    }
  }

  // Check if user has a specific permission (sync from cache)
  const hasPermission = (
    serverId: string, 
    profileId: string, 
    permission: Permission
  ): boolean => {
    const isOwner = isServerOwner(serverId, profileId)
    if (isOwner) return true

    const cacheKey = getCacheKey(profileId, serverId)
    const permissions = permissionsCache.get(cacheKey)
    
    if (!permissions) {
      // Trigger async load, return false for now
      loadPermissions(profileId, serverId)
      return false
    }

    return permissions[Permission.ADMINISTRATOR] === true || permissions[permission] === true
  }

  // Async version for accurate permission checking
  const hasPermissionAsync = async (
    serverId: string,
    profileId: string,
    permission: Permission,
    channelId?: string
  ): Promise<boolean> => {
    if (isServerOwner(serverId, profileId)) return true
    return roleService.hasPermission(profileId, serverId, permission, channelId)
  }

  // Check if current user has a specific permission
  const hasCurrentUserPermission = (permission: Permission): boolean => {
    if (!currentProfileId.value || !currentServer.value) return false
    return hasPermission(currentServer.value.id, currentProfileId.value, permission)
  }

  // Check if server is local (not federated)
  const isLocalServer = computed(() => {
    if (!currentServer.value) return false
    return currentServer.value.is_local_server !== false
  })

  // Server settings permissions (only for local servers)
  const canManageServer = computed(() => 
    isLocalServer.value && hasCurrentUserPermission(Permission.MANAGE_SERVER)
  )

  const canManageChannels = computed(() => 
    isLocalServer.value && hasCurrentUserPermission(Permission.MANAGE_CHANNELS)
  )

  const canManageEmojis = computed(() => 
    isLocalServer.value && hasCurrentUserPermission(Permission.MANAGE_EMOJIS)
  )

  const canManageRoles = computed(() =>
    isLocalServer.value && hasCurrentUserPermission(Permission.MANAGE_ROLES)
  )

  const canViewServerSettings = computed(() => {
    // Allow viewing settings but with read-only access for non-privileged users
    return true
  })

  // Check if user can perform destructive actions
  const canPerformDestructiveActions = computed(() => 
    isCurrentUserServerOwner.value || hasCurrentUserPermission(Permission.MANAGE_SERVER)
  )

  // Message moderation permissions
  const canManageMessages = computed(() =>
    hasCurrentUserPermission(Permission.MANAGE_MESSAGES)
  )

  const canPinMessages = computed(() =>
    hasCurrentUserPermission(Permission.PIN_MESSAGES) || hasCurrentUserPermission(Permission.MANAGE_MESSAGES)
  )

  const canCreateThreads = computed(() =>
    hasCurrentUserPermission(Permission.CREATE_PUBLIC_THREADS) || hasCurrentUserPermission(Permission.CREATE_PRIVATE_THREADS)
  )

  const canModerateMembers = computed(() =>
    hasCurrentUserPermission(Permission.KICK_MEMBERS) || 
    hasCurrentUserPermission(Permission.BAN_MEMBERS) ||
    hasCurrentUserPermission(Permission.TIMEOUT_MEMBERS)
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
    canDeleteServer: isCurrentUserServerOwner.value,
    canManageRoles: canManageRoles.value
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
    permission: Permission, 
    userId?: string
  ): boolean => {
    const targetProfileId = userId || currentProfileId.value
    if (!targetProfileId) return false
    return hasPermission(serverId, targetProfileId, permission)
  }

  // Initialize permissions for current user when server changes
  watch([currentProfileId, currentServer], async ([profileId, server]) => {
    if (!profileId || !server) return
    
    // Preload permissions and roles
    await Promise.all([
      loadPermissions(profileId, server.id),
      loadUserRoles(profileId, server.id)
    ])
  }, { immediate: true })

  // Clear cache for a server (call when roles change)
  const clearServerCache = (serverId: string) => {
    for (const key of permissionsCache.keys()) {
      if (key.endsWith(`-${serverId}`)) {
        permissionsCache.delete(key)
      }
    }
    for (const key of rolesCache.keys()) {
      if (key.endsWith(`-${serverId}`)) {
        rolesCache.delete(key)
      }
    }
    roleService.clearServerCache(serverId)
  }

  // Refresh permissions for current user
  const refreshPermissions = async () => {
    if (!currentProfileId.value || !currentServer.value) return
    
    const cacheKey = getCacheKey(currentProfileId.value, currentServer.value.id)
    permissionsCache.delete(cacheKey)
    rolesCache.delete(cacheKey)
    
    await Promise.all([
      loadPermissions(currentProfileId.value, currentServer.value.id),
      loadUserRoles(currentProfileId.value, currentServer.value.id)
    ])
  }

  // Get all roles for a server
  const getServerRoles = async (serverId: string): Promise<ServerRole[]> => {
    return roleService.getServerRoles(serverId)
  }

  return {
    // Permission checks
    hasPermission,
    hasPermissionAsync,
    hasCurrentUserPermission,
    checkServerPermission,
    
    // Owner checks
    isServerOwner,
    isCurrentUserServerOwner,
    
    // Role management
    getUserRole,
    getCurrentUserRole,
    getServerRoles,
    loadUserRoles,
    
    // Computed permissions
    canManageServer,
    canManageChannels,
    canManageEmojis,
    canManageRoles,
    canViewServerSettings,
    canPerformDestructiveActions,
    canManageMessages,
    canPinMessages,
    canCreateThreads,
    canModerateMembers,
    
    // Component-specific permissions
    serverSettingsPermissions,
    channelPermissions,
    
    // Cache management
    clearServerCache,
    refreshPermissions,
    
    // Enums and types
    Permission,
    // Backwards compatibility alias
    ServerPermission: Permission
  }
}
