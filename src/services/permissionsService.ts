import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { roleService, Permission, type ServerRole } from './RoleService'

// Re-export Permission from RoleService for backwards compatibility
export { Permission as ServerPermission } from './RoleService'

export interface ServerSettings {
  id: string
  server_id: string
  default_role_id?: string
  invite_permissions: {
    who_can_create: 'everyone' | 'roles' | 'administrators'
    allowed_roles?: string[]
    default_expiration: number // minutes, 0 = never
    max_expiration: number // minutes, 0 = no limit
    allow_temporary: boolean
    max_uses_limit: number // 0 = no limit
  }
  moderation_settings?: {
    auto_mod_enabled: boolean
    spam_filter: boolean
    link_filter: boolean
  }
  created_at?: string
  updated_at?: string
}

export interface UserPermissions {
  userId: string
  serverId: string
  permissions: Permission[]
  roles: ServerRole[]
  isOwner: boolean
  isAdmin: boolean
}

/**
 * Get comprehensive user permissions for a server
 * Uses the new role-based permission system
 */
async function getUserPermissions(userId: string, serverId: string): Promise<UserPermissions> {
  try {
    const roles = await roleService.getUserRoles(userId, serverId)
    
    const permissionFlags = await roleService.getUserPermissions(userId, serverId)
    
    const { data: server, error: serverError } = await supabase
      .from('servers')
      .select('owner')
      .eq('id', serverId)
      .single()

    if (serverError) throw serverError

    const isOwner = server.owner === userId
    const isAdmin = isOwner || permissionFlags[Permission.ADMINISTRATOR] === true

    const permissions = Object.entries(permissionFlags)
      .filter(([_, value]) => value === true)
      .map(([key]) => key as Permission)

    return {
      userId,
      serverId,
      permissions,
      roles,
      isOwner,
      isAdmin
    }
  } catch (error) {
    debug.error('Error getting user permissions:', error)
    // BUGS.md H1: previously this returned SEND_MESSAGES + VIEW_CHANNEL on
    // error, which means a transient permission-RPC failure silently grants
    // every caller the ability to send/view. Fail closed instead: callers
    // that treat the return value as authoritative will deny rather than
    // permit. Server-side RLS remains the real enforcement boundary, but
    // client-side UI fail-open is itself a confusion-of-deputy risk.
    return {
      userId,
      serverId,
      permissions: [],
      roles: [],
      isOwner: false,
      isAdmin: false
    }
  }
}

/**
 * Check if user has a specific permission
 */
async function hasPermission(
  userId: string,
  serverId: string,
  permission: Permission,
  channelId?: string
): Promise<boolean> {
  return roleService.hasPermission(userId, serverId, permission, channelId)
}

/**
 * Check if user has all specified permissions
 */
async function hasPermissions(
  userId: string,
  serverId: string,
  permissions: Permission[],
  channelId?: string
): Promise<boolean> {
  return roleService.hasPermissions(userId, serverId, permissions, channelId)
}

/**
 * Get server settings
 */
async function getServerSettings(serverId: string): Promise<ServerSettings | null> {
  try {
    const { data, error } = await supabase
      .from('server_settings')
      .select('*')
      .eq('server_id', serverId)
      .single()

    if (error && error.code === 'PGRST116') {
      // No settings found, return defaults
      return null
    }

    if (error) throw error
    return data
  } catch (error) {
    debug.error('Error getting server settings:', error)
    return null
  }
}

/**
 * Update server settings
 */
async function updateServerSettings(serverId: string, settings: Partial<ServerSettings>): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('server_settings')
      .upsert({
        server_id: serverId,
        ...settings,
      }, {
        onConflict: 'server_id',
      })

    if (error) throw error
    return true
  } catch (error) {
    debug.error('Error updating server settings:', error)
    return false
  }
}

/**
 * Get default server settings
 */
function getDefaultServerSettings(serverId: string): ServerSettings {
  return {
    id: '',
    server_id: serverId,
    invite_permissions: {
      who_can_create: 'everyone',
      allowed_roles: [],
      default_expiration: 1440, // 24 hours
      max_expiration: 0, // no limit
      allow_temporary: true,
      max_uses_limit: 0 // no limit
    },
    moderation_settings: {
      auto_mod_enabled: false,
      spam_filter: false,
      link_filter: false,
    }
  }
}

/**
 * Check if user can create invites
 */
async function canUserCreateInvites(userId: string, serverId: string): Promise<boolean> {
  try {
    const canCreate = await roleService.hasPermission(userId, serverId, Permission.CREATE_INVITE)
    if (canCreate) return true

    // Check server settings for additional rules
    const serverSettings = await getServerSettings(serverId)
    const userPerms = await getUserPermissions(userId, serverId)

    // Server owner and admins can always create invites
    if (userPerms.isOwner || userPerms.isAdmin) {
      return true
    }

    if (!serverSettings) {
      // Default: everyone can create invites
      return true
    }

    const invitePerms = serverSettings.invite_permissions

    switch (invitePerms.who_can_create) {
      case 'everyone':
        return true
      case 'administrators':
        return userPerms.isAdmin
      case 'roles':
        return invitePerms.allowed_roles?.some(roleId => 
          userPerms.roles.some(r => r.id === roleId)
        ) || false
      default:
        return false
    }
  } catch (error) {
    debug.error('Error checking invite permissions:', error)
    return false
  }
}

/**
 * Get invite constraints for a user
 */
async function getInviteConstraints(userId: string, serverId: string): Promise<{
  canCreate: boolean
  maxExpiration: number // minutes, 0 = no limit
  allowTemporary: boolean
  maxUses: number // 0 = no limit
  defaultExpiration: number
}> {
  try {
    const canCreate = await canUserCreateInvites(userId, serverId)
    
    if (!canCreate) {
      return {
        canCreate: false,
        maxExpiration: 0,
        allowTemporary: false,
        maxUses: 0,
        defaultExpiration: 0
      }
    }

    const [userPerms, serverSettings] = await Promise.all([
      getUserPermissions(userId, serverId),
      getServerSettings(serverId)
    ])

    const settings = serverSettings || getDefaultServerSettings(serverId)
    const invitePerms = settings.invite_permissions

    // Admins can bypass some restrictions
    const isAdmin = userPerms.isAdmin || userPerms.isOwner

    return {
      canCreate: true,
      maxExpiration: isAdmin ? 0 : invitePerms.max_expiration,
      allowTemporary: isAdmin ? true : invitePerms.allow_temporary,
      maxUses: isAdmin ? 0 : invitePerms.max_uses_limit,
      defaultExpiration: invitePerms.default_expiration
    }
  } catch (error) {
    debug.error('Error getting invite constraints:', error)
    return {
      canCreate: false,
      maxExpiration: 0,
      allowTemporary: false,
      maxUses: 0,
      defaultExpiration: 1440
    }
  }
}

/**
 * Check if user can manage messages (edit/delete others' messages, pin)
 */
async function canManageMessages(userId: string, serverId: string, channelId?: string): Promise<boolean> {
  return roleService.hasPermission(userId, serverId, Permission.MANAGE_MESSAGES, channelId)
}

/**
 * Check if user can pin messages
 */
async function canPinMessages(userId: string, serverId: string, channelId?: string): Promise<boolean> {
  // Check for PIN_MESSAGES or MANAGE_MESSAGES permission
  const [canPin, canManage] = await Promise.all([
    roleService.hasPermission(userId, serverId, Permission.PIN_MESSAGES, channelId),
    roleService.hasPermission(userId, serverId, Permission.MANAGE_MESSAGES, channelId),
  ])
  return canPin || canManage
}

/**
 * Check if user can create threads
 */
async function canCreateThreads(userId: string, serverId: string, channelId?: string): Promise<boolean> {
  const [canPublic, canPrivate] = await Promise.all([
    roleService.hasPermission(userId, serverId, Permission.CREATE_PUBLIC_THREADS, channelId),
    roleService.hasPermission(userId, serverId, Permission.CREATE_PRIVATE_THREADS, channelId),
  ])
  return canPublic || canPrivate
}

/**
 * Check if user can kick/ban members
 */
async function canModerateMembers(userId: string, serverId: string): Promise<boolean> {
  const [canKick, canBan, canTimeout] = await Promise.all([
    roleService.hasPermission(userId, serverId, Permission.KICK_MEMBERS),
    roleService.hasPermission(userId, serverId, Permission.BAN_MEMBERS),
    roleService.hasPermission(userId, serverId, Permission.TIMEOUT_MEMBERS),
  ])
  return canKick || canBan || canTimeout
}

export {
  getUserPermissions,
  hasPermission,
  hasPermissions,
  getServerSettings,
  updateServerSettings,
  getDefaultServerSettings,
  canUserCreateInvites,
  getInviteConstraints,
  canManageMessages,
  canPinMessages,
  canCreateThreads,
  canModerateMembers
}
