import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

export enum ServerPermission {
  ADMINISTRATOR = 'administrator',
  MANAGE_SERVER = 'manage_server',
  MANAGE_CHANNELS = 'manage_channels',
  MANAGE_ROLES = 'manage_roles',
  CREATE_INVITES = 'create_invites',
  MANAGE_INVITES = 'manage_invites',
  KICK_MEMBERS = 'kick_members',
  BAN_MEMBERS = 'ban_members',
  MODERATE_MESSAGES = 'moderate_messages',
  SEND_MESSAGES = 'send_messages',
  USE_VOICE = 'use_voice',
  MUTE_MEMBERS = 'mute_members',
  DEAFEN_MEMBERS = 'deafen_members'
}

export interface ServerSettings {
  id: string
  server_id: string
  invite_permissions: {
    who_can_create: 'everyone' | 'roles' | 'administrators'
    allowed_roles?: string[]
    default_expiration: number // minutes, 0 = never
    max_expiration: number // minutes, 0 = no limit
    allow_temporary: boolean
    max_uses_limit: number // 0 = no limit
  }
  created_at?: string
  updated_at?: string
}

export interface UserPermissions {
  userId: string
  serverId: string
  permissions: ServerPermission[]
  roles: string[]
  isOwner: boolean
  isAdmin: boolean
}

async function getUserPermissions(userId: string, serverId: string): Promise<UserPermissions> {
  try {
    // Get user's roles and direct permissions
    const { data: userServer, error: userServerError } = await supabase
      .from('user_servers')
      .select(`
        *,
        roles:server_roles(*)
      `)
      .eq('user_id', userId)
      .eq('server_id', serverId)
      .single()

    if (userServerError) throw userServerError

    // Get server owner
    const { data: server, error: serverError } = await supabase
      .from('servers')
      .select('created_by')
      .eq('id', serverId)
      .single()

    if (serverError) throw serverError

    const isOwner = server.created_by === userId
    const roles = userServer.roles || []
    
    // Collect all permissions from roles
    let permissions: ServerPermission[] = []
    
    if (isOwner) {
      // Server owner has all permissions
      permissions = Object.values(ServerPermission)
    } else {
      // Collect permissions from roles
      roles.forEach((role: any) => {
        if (role.permissions) {
          permissions = [...permissions, ...role.permissions]
        }
      })
      
      // Remove duplicates
      permissions = [...new Set(permissions)]
    }

    const isAdmin = isOwner || permissions.includes(ServerPermission.ADMINISTRATOR)

    return {
      userId,
      serverId,
      permissions,
      roles: roles.map((r: any) => r.id),
      isOwner,
      isAdmin
    }
  } catch (error) {
    debug.error('Error getting user permissions:', error)
    return {
      userId,
      serverId,
      permissions: [ServerPermission.SEND_MESSAGES], // Default basic permission
      roles: [],
      isOwner: false,
      isAdmin: false
    }
  }
}

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

async function updateServerSettings(serverId: string, settings: Partial<ServerSettings>): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('server_settings')
      .upsert({
        server_id: serverId,
        ...settings,
      })

    if (error) throw error
    return true
  } catch (error) {
    debug.error('Error updating server settings:', error)
    return false
  }
}

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
  }
}

async function canUserCreateInvites(userId: string, serverId: string): Promise<boolean> {
  try {
    //  PLACEHOLDER until we create userpermissions and server roles and server settings tables
    return true;
    /// TODO: Implement proper permission checks
    const [userPermissions, serverSettings] = await Promise.all([
      getUserPermissions(userId, serverId),
      getServerSettings(serverId)
    ])

    // Server owner and admins can always create invites
    if (userPermissions.isOwner || userPermissions.isAdmin) {
      return true
    }

    // Check if user has explicit create invites permission
    if (userPermissions.permissions.includes(ServerPermission.CREATE_INVITES)) {
      return true
    }

    // Use default settings if no custom settings exist
    const settings = serverSettings || getDefaultServerSettings(serverId)
    const invitePerms = settings.invite_permissions

    switch (invitePerms.who_can_create) {
      case 'everyone':
        return true
      case 'administrators':
        return userPermissions.isAdmin
      case 'roles':
        return invitePerms.allowed_roles?.some(roleId => 
          userPermissions.roles.includes(roleId)
        ) || false
      default:
        return false
    }
  } catch (error) {
    debug.error('Error checking invite permissions:', error)
    return false
  }
}

async function getInviteConstraints(userId: string, serverId: string): Promise<{
  canCreate: boolean
  maxExpiration: number // minutes, 0 = no limit
  allowTemporary: boolean
  maxUses: number // 0 = no limit
  defaultExpiration: number
}> {
  try {

    //  PLACEHOLDER until we create userpermissions and server roles and server settings tables
  
    return {
      canCreate: true,
      maxExpiration: 0,
      allowTemporary: true,
      maxUses: 0,
      defaultExpiration: 1440
    }
    /// TODO: Implement proper permission checks
    const [userPermissions, serverSettings] = await Promise.all([
      getUserPermissions(userId, serverId),
      getServerSettings(serverId)
    ])

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

    const settings = serverSettings || getDefaultServerSettings(serverId)
    const invitePerms = settings.invite_permissions

    // Admins can bypass some restrictions
    const isAdmin = userPermissions.isAdmin || userPermissions.isOwner

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

export {
  getUserPermissions,
  getServerSettings,
  updateServerSettings,
  getDefaultServerSettings,
  canUserCreateInvites,
  getInviteConstraints,
  type UserPermissions
}