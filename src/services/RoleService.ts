import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

// =============================================
// Permission Definitions (Discord-style)
// =============================================

export enum Permission {
  // General Permissions
  ADMINISTRATOR = 'ADMINISTRATOR',
  VIEW_CHANNEL = 'VIEW_CHANNEL',
  MANAGE_CHANNELS = 'MANAGE_CHANNELS',
  MANAGE_ROLES = 'MANAGE_ROLES',
  MANAGE_EMOJIS = 'MANAGE_EMOJIS',
  VIEW_AUDIT_LOG = 'VIEW_AUDIT_LOG',
  MANAGE_WEBHOOKS = 'MANAGE_WEBHOOKS',
  MANAGE_SERVER = 'MANAGE_SERVER',

  // Membership Permissions
  CREATE_INVITE = 'CREATE_INVITE',
  KICK_MEMBERS = 'KICK_MEMBERS',
  BAN_MEMBERS = 'BAN_MEMBERS',
  TIMEOUT_MEMBERS = 'TIMEOUT_MEMBERS',

  // Text Channel Permissions
  SEND_MESSAGES = 'SEND_MESSAGES',
  SEND_MESSAGES_IN_THREADS = 'SEND_MESSAGES_IN_THREADS',
  CREATE_PUBLIC_THREADS = 'CREATE_PUBLIC_THREADS',
  CREATE_PRIVATE_THREADS = 'CREATE_PRIVATE_THREADS',
  EMBED_LINKS = 'EMBED_LINKS',
  ATTACH_FILES = 'ATTACH_FILES',
  ADD_REACTIONS = 'ADD_REACTIONS',
  USE_EXTERNAL_EMOJIS = 'USE_EXTERNAL_EMOJIS',
  MENTION_EVERYONE = 'MENTION_EVERYONE',
  MANAGE_MESSAGES = 'MANAGE_MESSAGES',
  READ_MESSAGE_HISTORY = 'READ_MESSAGE_HISTORY',
  PIN_MESSAGES = 'PIN_MESSAGES',

  // Voice Channel Permissions
  CONNECT = 'CONNECT',
  SPEAK = 'SPEAK',
  STREAM = 'STREAM',
  MUTE_MEMBERS = 'MUTE_MEMBERS',
  DEAFEN_MEMBERS = 'DEAFEN_MEMBERS',
  MOVE_MEMBERS = 'MOVE_MEMBERS',
}

// Permission categories for UI grouping
export const PERMISSION_CATEGORIES = {
  general: {
    name: 'General Server Permissions',
    permissions: [
      Permission.VIEW_CHANNEL,
      Permission.MANAGE_CHANNELS,
      Permission.MANAGE_ROLES,
      Permission.MANAGE_EMOJIS,
      Permission.VIEW_AUDIT_LOG,
      Permission.MANAGE_WEBHOOKS,
      Permission.MANAGE_SERVER,
    ],
  },
  membership: {
    name: 'Membership Permissions',
    permissions: [
      Permission.CREATE_INVITE,
      Permission.KICK_MEMBERS,
      Permission.BAN_MEMBERS,
      Permission.TIMEOUT_MEMBERS,
    ],
  },
  text: {
    name: 'Text Channel Permissions',
    permissions: [
      Permission.SEND_MESSAGES,
      Permission.SEND_MESSAGES_IN_THREADS,
      Permission.CREATE_PUBLIC_THREADS,
      Permission.CREATE_PRIVATE_THREADS,
      Permission.EMBED_LINKS,
      Permission.ATTACH_FILES,
      Permission.ADD_REACTIONS,
      Permission.USE_EXTERNAL_EMOJIS,
      Permission.MENTION_EVERYONE,
      Permission.MANAGE_MESSAGES,
      Permission.READ_MESSAGE_HISTORY,
      Permission.PIN_MESSAGES,
    ],
  },
  voice: {
    name: 'Voice Channel Permissions',
    permissions: [
      Permission.CONNECT,
      Permission.SPEAK,
      Permission.STREAM,
      Permission.MUTE_MEMBERS,
      Permission.DEAFEN_MEMBERS,
      Permission.MOVE_MEMBERS,
    ],
  },
  dangerous: {
    name: 'Dangerous Permissions',
    permissions: [Permission.ADMINISTRATOR],
  },
} as const

// =============================================
// Permission Bit Mapping (for bigint storage)
// =============================================

// Each permission maps to a specific bit position in the bigint
export const PERMISSION_BITS: Record<Permission, number> = {
  // General Permissions (bits 0-7)
  [Permission.ADMINISTRATOR]: 0,
  [Permission.VIEW_CHANNEL]: 1,
  [Permission.MANAGE_CHANNELS]: 2,
  [Permission.MANAGE_ROLES]: 3,
  [Permission.MANAGE_EMOJIS]: 4,
  [Permission.VIEW_AUDIT_LOG]: 5,
  [Permission.MANAGE_WEBHOOKS]: 6,
  [Permission.MANAGE_SERVER]: 7,

  // Membership Permissions (bits 8-11)
  [Permission.CREATE_INVITE]: 8,
  [Permission.KICK_MEMBERS]: 9,
  [Permission.BAN_MEMBERS]: 10,
  [Permission.TIMEOUT_MEMBERS]: 11,

  // Text Channel Permissions (bits 12-23)
  [Permission.SEND_MESSAGES]: 12,
  [Permission.SEND_MESSAGES_IN_THREADS]: 13,
  [Permission.CREATE_PUBLIC_THREADS]: 14,
  [Permission.CREATE_PRIVATE_THREADS]: 15,
  [Permission.EMBED_LINKS]: 16,
  [Permission.ATTACH_FILES]: 17,
  [Permission.ADD_REACTIONS]: 18,
  [Permission.USE_EXTERNAL_EMOJIS]: 19,
  [Permission.MENTION_EVERYONE]: 20,
  [Permission.MANAGE_MESSAGES]: 21,
  [Permission.READ_MESSAGE_HISTORY]: 22,
  [Permission.PIN_MESSAGES]: 23,

  // Voice Channel Permissions (bits 24-29)
  [Permission.CONNECT]: 24,
  [Permission.SPEAK]: 25,
  [Permission.STREAM]: 26,
  [Permission.MUTE_MEMBERS]: 27,
  [Permission.DEAFEN_MEMBERS]: 28,
  [Permission.MOVE_MEMBERS]: 29,
}

/**
 * Convert permissions object to bigint bitmask for database storage
 */
export function permissionsToBitmask(permissions: Record<Permission, boolean> | Partial<Record<Permission, boolean>>): bigint {
  let bitmask = BigInt(0)
  
  for (const [permission, enabled] of Object.entries(permissions)) {
    if (enabled && permission in PERMISSION_BITS) {
      const bit = PERMISSION_BITS[permission as Permission]
      bitmask |= BigInt(1) << BigInt(bit)
    }
  }
  
  return bitmask
}

/**
 * Convert bigint bitmask from database to permissions object
 */
export function bitmaskToPermissions(bitmask: bigint | number | string): Record<Permission, boolean> {
  const permissions: Record<Permission, boolean> = {} as Record<Permission, boolean>
  const mask = BigInt(bitmask || 0)

  for (const [permission, bit] of Object.entries(PERMISSION_BITS)) {
    permissions[permission as Permission] = (mask & (BigInt(1) << BigInt(bit))) !== BigInt(0)
  }

  return permissions
}

// Permission descriptions for UI
export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  [Permission.ADMINISTRATOR]: 'Members with this permission have every permission and can bypass channel-specific permissions.',
  [Permission.VIEW_CHANNEL]: 'Allows members to view channels and see their content.',
  [Permission.MANAGE_CHANNELS]: 'Allows members to create, edit, and delete channels.',
  [Permission.MANAGE_ROLES]: 'Allows members to create, edit, and delete roles lower than their highest role.',
  [Permission.MANAGE_EMOJIS]: 'Allows members to add, edit, and remove custom emojis.',
  [Permission.VIEW_AUDIT_LOG]: 'Allows members to view the server audit log.',
  [Permission.MANAGE_WEBHOOKS]: 'Allows members to create, edit, and delete webhooks.',
  [Permission.MANAGE_SERVER]: 'Allows members to change server name, icon, and other settings.',
  [Permission.CREATE_INVITE]: 'Allows members to create invites to the server.',
  [Permission.KICK_MEMBERS]: 'Allows members to remove other members from the server.',
  [Permission.BAN_MEMBERS]: 'Allows members to permanently ban other members from the server.',
  [Permission.TIMEOUT_MEMBERS]: 'Allows members to timeout other members, preventing them from sending messages.',
  [Permission.SEND_MESSAGES]: 'Allows members to send messages in text channels.',
  [Permission.SEND_MESSAGES_IN_THREADS]: 'Allows members to send messages in threads.',
  [Permission.CREATE_PUBLIC_THREADS]: 'Allows members to create public threads.',
  [Permission.CREATE_PRIVATE_THREADS]: 'Allows members to create private threads.',
  [Permission.EMBED_LINKS]: 'Allows members to embed links that display previews.',
  [Permission.ATTACH_FILES]: 'Allows members to upload files and images.',
  [Permission.ADD_REACTIONS]: 'Allows members to add reactions to messages.',
  [Permission.USE_EXTERNAL_EMOJIS]: 'Allows members to use emojis from other servers.',
  [Permission.MENTION_EVERYONE]: 'Allows members to use @everyone and @here mentions.',
  [Permission.MANAGE_MESSAGES]: 'Allows members to delete and pin messages from other members.',
  [Permission.READ_MESSAGE_HISTORY]: 'Allows members to read previous messages in a channel.',
  [Permission.PIN_MESSAGES]: 'Allows members to pin messages in channels.',
  [Permission.CONNECT]: 'Allows members to connect to voice channels.',
  [Permission.SPEAK]: 'Allows members to speak in voice channels.',
  [Permission.STREAM]: 'Allows members to share their screen in voice channels.',
  [Permission.MUTE_MEMBERS]: 'Allows members to mute other members in voice channels.',
  [Permission.DEAFEN_MEMBERS]: 'Allows members to deafen other members in voice channels.',
  [Permission.MOVE_MEMBERS]: 'Allows members to move other members between voice channels.',
}

// =============================================
// Role Types
// =============================================

export interface ServerRole {
  id: string
  server_id: string
  name: string
  color: string
  hoist: boolean
  mentionable: boolean
  position: number
  permissions: Record<Permission, boolean>
  icon_url?: string
  unicode_emoji?: string
  is_default?: boolean
  is_admin?: boolean
  member_count?: number
  created_at: string
  updated_at: string
  ap_id?: string
  federation_metadata?: Record<string, any>
}

export interface UserRole {
  id: string
  user_id: string
  role_id: string
  server_id: string
  assigned_at: string
  assigned_by?: string
}

export interface ChannelPermissionOverride {
  id: string
  channel_id: string
  target_type: 'role' | 'user'
  /** Set when target_type === 'role' */
  role_id: string | null
  /** Set when target_type === 'user' */
  user_id: string | null
  /** Permissions to grant explicitly (bigint bitmask stored, decoded here). */
  allow_permissions: string | number
  /** Permissions to deny explicitly (bigint bitmask stored, decoded here). */
  deny_permissions: string | number
  created_at: string
  updated_at: string
}

export interface CreateRoleParams {
  server_id: string
  name: string
  color?: string
  hoist?: boolean
  mentionable?: boolean
  permissions?: Partial<Record<Permission, boolean>>
  icon_url?: string
  unicode_emoji?: string
}

export interface UpdateRoleParams {
  name?: string
  color?: string
  hoist?: boolean
  mentionable?: boolean
  position?: number
  permissions?: Record<Permission, boolean> | string[]
  icon_url?: string
  unicode_emoji?: string
}

// =============================================
// Role Service Class
// =============================================

class RoleService {
  private roleCache = new Map<string, ServerRole[]>() // serverId -> roles
  private userRolesCache = new Map<string, ServerRole[]>() // `${userId}-${serverId}` -> roles (FIXED: store full roles, not just IDs)
  private permissionCache = new Map<string, Record<Permission, boolean>>() // `${userId}-${serverId}-${channelId?}` -> permissions
  
  // OPTIMIZED: Request deduplication maps
  private pendingUserRolesRequests = new Map<string, Promise<ServerRole[]>>()
  private pendingPermissionsRequests = new Map<string, Promise<Record<Permission, boolean>>>()

  // =============================================
  // Role CRUD Operations
  // =============================================

  /**
   * Get all roles for a server
   */
  async getServerRoles(serverId: string, forceRefresh = false): Promise<ServerRole[]> {
    if (!forceRefresh && this.roleCache.has(serverId)) {
      return this.roleCache.get(serverId)!
    }

    try {
      // Fetch roles (simple query without embedded resource to avoid user_roles RLS issues)
      const { data, error } = await supabase
        .from('server_roles')
        .select('*')
        .eq('server_id', serverId)
        .order('position', { ascending: false })

      if (error) {
        debug.error('getServerRoles query error:', error)
        throw error
      }

      // Fetch member counts separately
      const roleIds = (data || []).map((r: any) => r.id)
      const memberCounts: Record<string, number> = {}
      if (roleIds.length > 0) {
        const { data: countData } = await supabase
          .from('user_roles')
          .select('role_id')
          .in('role_id', roleIds)

        if (countData) {
          countData.forEach((ur: any) => {
            memberCounts[ur.role_id] = (memberCounts[ur.role_id] || 0) + 1
          })
        }
      }

      const roles = (data || []).map((r: any) => ({
        ...r,
        mentionable: r.mentionable ?? true,
        permissions: bitmaskToPermissions(r.permissions),
        member_count: memberCounts[r.id] || 0,
      })) as ServerRole[]
      this.roleCache.set(serverId, roles)
      return roles
    } catch (error) {
      debug.error('Failed to fetch server roles:', error)
      return []
    }
  }

  /**
   * Alias for getServerRoles for component compatibility
   */
  async getRolesForServer(serverId: string): Promise<ServerRole[]> {
    return this.getServerRoles(serverId)
  }

  /**
   * Get a specific role by ID
   */
  async getRole(roleId: string): Promise<ServerRole | null> {
    try {
      const { data, error } = await supabase
        .from('server_roles')
        .select('*')
        .eq('id', roleId)
        .single()

      if (error) throw error
      
      // Convert bigint permissions to object format
      return {
        ...data,
        permissions: bitmaskToPermissions(data.permissions)
      } as ServerRole
    } catch (error) {
      debug.error('Failed to fetch role:', error)
      return null
    }
  }

  /**
   * Create a new role
   */
  async createRole(serverId: string, params: Partial<CreateRoleParams>): Promise<ServerRole | null> {
    try {
      // Get highest position for new role
      const roles = await this.getServerRoles(serverId)
      const maxPosition = Math.max(...roles.map(r => r.position), 0)

      // Convert permissions object to bigint for database
      const permissionsBitmask = params.permissions 
        ? Number(permissionsToBitmask(params.permissions))
        : 0

      const { data, error } = await supabase
        .from('server_roles')
        .insert({
          server_id: serverId,
          name: params.name || 'New Role',
          color: params.color || '#99AAB5',
          hoist: params.hoist || false,
          mentionable: params.mentionable || false,
          position: maxPosition + 1,
          permissions: permissionsBitmask,
          icon_url: params.icon_url,
          unicode_emoji: params.unicode_emoji,
        })
        .select()
        .single()

      if (error) throw error

      // Invalidate cache
      this.roleCache.delete(serverId)

      // Convert permissions back to object for frontend
      return {
        ...data,
        permissions: bitmaskToPermissions(data.permissions)
      } as ServerRole
    } catch (error) {
      debug.error('Failed to create role:', error)
      return null
    }
  }

  /**
   * Update an existing role
   */
  async updateRole(roleId: string, params: UpdateRoleParams): Promise<ServerRole | null> {
    try {
      // Convert permissions object to bigint if present
      const dbParams: Record<string, any> = { ...params }
      if (params.permissions && typeof params.permissions === 'object' && !Array.isArray(params.permissions)) {
        dbParams.permissions = Number(permissionsToBitmask(params.permissions as Record<Permission, boolean>))
      }
      
      const { data, error } = await supabase
        .from('server_roles')
        .update(dbParams)
        .eq('id', roleId)
        .select()
        .single()

      if (error) throw error

      // Convert bigint permissions back to object for frontend
      const role: ServerRole = {
        ...data,
        permissions: bitmaskToPermissions(data.permissions)
      }
      
      // Invalidate caches
      this.roleCache.delete(role.server_id)
      this.permissionCache.clear()

      return role
    } catch (error) {
      debug.error('Failed to update role:', error)
      return null
    }
  }

  /**
   * Delete a role
   */
  async deleteRole(roleId: string): Promise<boolean> {
    try {
      // Get role first for cache invalidation
      const role = await this.getRole(roleId)
      if (!role) return false

      if (role.is_default) {
        debug.error('Cannot delete @everyone role')
        return false
      }

      const { error } = await supabase
        .from('server_roles')
        .delete()
        .eq('id', roleId)

      if (error) throw error

      // Invalidate caches
      this.roleCache.delete(role.server_id)
      this.permissionCache.clear()

      return true
    } catch (error) {
      debug.error('Failed to delete role:', error)
      return false
    }
  }

  /**
   * Reorder roles (update positions)
   */
  async reorderRoles(serverId: string, rolePositions: { id: string; position: number }[]): Promise<boolean> {
    try {
      // Use a transaction via RPC or multiple updates
      for (const { id, position } of rolePositions) {
        const { error } = await supabase
          .from('server_roles')
          .update({ position })
          .eq('id', id)
          .eq('server_id', serverId)

        if (error) throw error
      }

      // Invalidate cache
      this.roleCache.delete(serverId)
      this.permissionCache.clear()

      return true
    } catch (error) {
      debug.error('Failed to reorder roles:', error)
      return false
    }
  }

  // =============================================
  // User Role Assignments
  // =============================================

  /**
   * Get roles assigned to a user in a server
   * OPTIMIZED: Checks cache first, deduplicates concurrent requests
   */
  async getUserRoles(userId: string, serverId: string): Promise<ServerRole[]> {
    if (!userId || !serverId) return []
    const cacheKey = `${userId}-${serverId}`
    
    // Check cache first
    if (this.userRolesCache.has(cacheKey)) {
      return this.userRolesCache.get(cacheKey)!
    }
    
    // Deduplicate concurrent requests
    if (this.pendingUserRolesRequests.has(cacheKey)) {
      return this.pendingUserRolesRequests.get(cacheKey)!
    }
    
    const fetchPromise = this._fetchUserRoles(userId, serverId, cacheKey)
    this.pendingUserRolesRequests.set(cacheKey, fetchPromise)
    
    try {
      return await fetchPromise
    } finally {
      this.pendingUserRolesRequests.delete(cacheKey)
    }
  }
  
  /**
   * Internal method to fetch user roles from DB
   */
  private async _fetchUserRoles(userId: string, serverId: string, cacheKey: string): Promise<ServerRole[]> {
    try {
      const { data, error } = await supabase
        .from('user_roles')
        .select(`
          role_id,
          server_roles (*)
        `)
        .eq('user_id', userId)
        .eq('server_id', serverId)

      if (error) throw error

      const roles = (data || [])
        .map((ur: any) => ur.server_roles)
        .filter(Boolean) as ServerRole[]

      const sortedRoles = roles.sort((a, b) => b.position - a.position)
      
      // Cache the full roles
      this.userRolesCache.set(cacheKey, sortedRoles)

      return sortedRoles
    } catch (error) {
      debug.error('Failed to fetch user roles:', error)
      return []
    }
  }

  /**
   * Get all members with a specific role
   */
  async getRoleMembers(roleId: string): Promise<{ id: string; username: string; display_name?: string; avatar_url?: string }[]> {
    try {
      const { data, error } = await supabase
        .from('user_roles')
        .select(`
          user_id,
          assigned_at,
          profiles:user_id (
            id,
            username,
            display_name,
            avatar_url
          )
        `)
        .eq('role_id', roleId)

      if (error) throw error
      
      return (data || []).map((ur: any) => ({
        id: ur.user_id,
        username: ur.profiles?.username || 'Unknown',
        display_name: ur.profiles?.display_name,
        avatar_url: ur.profiles?.avatar_url,
      }))
    } catch (error) {
      debug.error('Failed to fetch role members:', error)
      return []
    }
  }

  /**
   * Get all role assignments for a server, optionally filtered to specific role IDs.
   * Single query replaces N+1 per-role fetches.
   */
  async getRoleMembersForServer(serverId: string, roleIds?: string[]): Promise<{ user_id: string; role_id: string }[]> {
    try {
      let query = supabase
        .from('user_roles')
        .select('user_id, role_id')
        .eq('server_id', serverId)

      if (roleIds && roleIds.length > 0) {
        query = query.in('role_id', roleIds)
      }

      const { data, error } = await query
      if (error) throw error
      return data || []
    } catch (error) {
      debug.error('Failed to fetch server role assignments:', error)
      return []
    }
  }

  /**
   * Assign a role to a user
   */
  async assignRole(userId: string, roleId: string, serverId: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('user_roles')
        .insert({
          user_id: userId,
          role_id: roleId,
          server_id: serverId,
        })

      if (error) throw error

      // Invalidate caches
      this.userRolesCache.delete(`${userId}-${serverId}`)
      this.permissionCache.clear()

      return true
    } catch (error: any) {
      // Ignore duplicate key errors (role already assigned)
      if (error.code === '23505') {
        return true
      }
      debug.error('Failed to assign role:', error)
      return false
    }
  }

  /**
   * Remove a role from a user
   * Note: Cannot remove admin roles from server owners
   */
  async removeRole(userId: string, roleId: string): Promise<boolean> {
    try {
      // First, check if this is an admin role being removed from a server owner
      const { data: roleData, error: roleError } = await supabase
        .from('server_roles')
        .select('id, server_id, is_admin')
        .eq('id', roleId)
        .single()
      
      if (roleError) {
        debug.error('Failed to fetch role:', roleError)
        return false
      }
      
      // If it's an admin role, check if user is server owner
      if (roleData?.is_admin) {
        const { data: serverData, error: serverError } = await supabase
          .from('servers')
          .select('owner')
          .eq('id', roleData.server_id)
          .single()
        
        if (serverError) {
          debug.error('Failed to fetch server:', serverError)
          return false
        }
        
        // Prevent removing admin role from server owner
        if (serverData?.owner === userId) {
          debug.warn('Cannot remove admin role from server owner')
          throw new Error('Cannot remove admin role from server owner')
        }
      }
      
      const { data, error } = await supabase
        .from('user_roles')
        .delete()
        .eq('user_id', userId)
        .eq('role_id', roleId)
        .select('server_id')
        .single()

      if (error && error.code !== 'PGRST116') throw error

      if (data) {
        // Invalidate caches
        this.userRolesCache.delete(`${userId}-${data.server_id}`)
        this.permissionCache.clear()
      }

      return true
    } catch (error) {
      debug.error('Failed to remove role:', error)
      return false
    }
  }

  // =============================================
  // Permission Calculations
  // =============================================

  /**
   * Get effective permissions for a user in a server/channel
   * Uses the database function for proper calculation
   * OPTIMIZED: Deduplicates concurrent requests
   */
  async getUserPermissions(
    userId: string,
    serverId: string,
    channelId?: string
  ): Promise<Record<Permission, boolean>> {
    if (!userId || !serverId) {
      return {} as Record<Permission, boolean>
    }

    const cacheKey = `${userId}-${serverId}-${channelId || 'server'}`

    // Check cache first
    if (this.permissionCache.has(cacheKey)) {
      return this.permissionCache.get(cacheKey)!
    }
    
    // Deduplicate concurrent requests
    if (this.pendingPermissionsRequests.has(cacheKey)) {
      return this.pendingPermissionsRequests.get(cacheKey)!
    }
    
    const fetchPromise = this._fetchUserPermissions(userId, serverId, channelId, cacheKey)
    this.pendingPermissionsRequests.set(cacheKey, fetchPromise)
    
    try {
      return await fetchPromise
    } finally {
      this.pendingPermissionsRequests.delete(cacheKey)
    }
  }
  
  /**
   * Internal method to fetch user permissions from DB
   */
  private async _fetchUserPermissions(
    userId: string,
    serverId: string,
    channelId: string | undefined,
    cacheKey: string
  ): Promise<Record<Permission, boolean>> {
    try {
      const { data, error } = await supabase.rpc('get_user_permissions', {
        p_user_id: userId,
        p_server_id: serverId,
        p_channel_id: channelId || null,
      })

      if (error) throw error

      const permissions = (data || {}) as Record<Permission, boolean>
      this.permissionCache.set(cacheKey, permissions)

      return permissions
    } catch (error) {
      debug.error('Failed to get user permissions:', error)
      return {} as Record<Permission, boolean>
    }
  }

  /**
   * Check if a user has a specific permission
   */
  async hasPermission(
    userId: string,
    serverId: string,
    permission: Permission,
    channelId?: string
  ): Promise<boolean> {
    const permissions = await this.getUserPermissions(userId, serverId, channelId)
    return permissions[permission] === true || permissions[Permission.ADMINISTRATOR] === true
  }

  /**
   * Check multiple permissions at once
   */
  async hasPermissions(
    userId: string,
    serverId: string,
    requiredPermissions: Permission[],
    channelId?: string
  ): Promise<boolean> {
    const permissions = await this.getUserPermissions(userId, serverId, channelId)

    if (permissions[Permission.ADMINISTRATOR]) return true

    return requiredPermissions.every(p => permissions[p] === true)
  }

  // =============================================
  // Channel Permission Overrides
  // =============================================

  /**
   * Get permission overrides for a channel
   */
  async getChannelOverrides(channelId: string): Promise<ChannelPermissionOverride[]> {
    try {
      const { data, error } = await supabase
        .from('channel_permission_overrides')
        .select('*')
        .eq('channel_id', channelId)

      if (error) throw error
      return (data || []) as ChannelPermissionOverride[]
    } catch (error) {
      debug.error('Failed to fetch channel overrides:', error)
      return []
    }
  }

  /**
   * Upsert a permission override for a channel.
   * `allow` / `deny` are partial permission maps (e.g. `{ SEND_MESSAGES: true }`)
   * which are converted to the bigint bitmask the DB stores.
   *
   * Schema constraint: exactly one of role_id / user_id is non-null, matching
   * target_type. We upsert on (channel_id, role_id, user_id) per the table's
   * UNIQUE index.
   */
  async setChannelOverride(
    channelId: string,
    targetType: 'role' | 'user',
    targetId: string,
    allow: Partial<Record<Permission, boolean>>,
    deny: Partial<Record<Permission, boolean>>
  ): Promise<boolean> {
    try {
      const allowMask = permissionsToBitmask(allow)
      const denyMask = permissionsToBitmask(deny)

      // ---------------------------------------------------------------------
      // Why this isn't an upsert (anymore):
      //
      // PostgreSQL's `ON CONFLICT (channel_id, role_id)` needs a NON-partial
      // unique index covering exactly those columns. Our partial indexes
      // `uniq_cpo_channel_role WHERE user_id IS NULL` and the analogous user
      // one DO exist in the DB, but PostgREST's `on_conflict` query parameter
      // can't pass the partial WHERE clause to Postgres — so the planner
      // refuses with 42P10 "no unique or exclusion constraint matching the
      // ON CONFLICT specification".
      //
      // The composite `UNIQUE(channel_id, role_id, user_id)` doesn't help
      // because Postgres treats NULL as distinct, so role-only and user-only
      // rows aren't actually unique-constrained.
      //
      // Cleanest fix without changing the schema: do a manual lookup +
      // INSERT-or-UPDATE. Two roundtrips instead of one, but this is admin
      // UI traffic — frequency is negligible.
      // ---------------------------------------------------------------------

      const baseQuery = supabase
        .from('channel_permission_overrides')
        .select('id')
        .eq('channel_id', channelId)
      const filteredQuery =
        targetType === 'role'
          ? baseQuery.eq('role_id', targetId).is('user_id', null)
          : baseQuery.eq('user_id', targetId).is('role_id', null)
      const { data: existing, error: lookupErr } = await filteredQuery.maybeSingle()
      if (lookupErr) throw lookupErr

      // If both masks are zero, the row is meaningless ("inherit everything")
      // — delete an existing row, or no-op if there's none. Avoids writing
      // 0/0 noise rows.
      if (allowMask === BigInt(0) && denyMask === BigInt(0)) {
        if (existing?.id) {
          const { error: delErr } = await supabase
            .from('channel_permission_overrides')
            .delete()
            .eq('id', existing.id)
          if (delErr) throw delErr
        }
        this.permissionCache.clear()
        return true
      }

      // Postgres bigint accepts strings (avoids JS precision loss > 2^53).
      const allowStr = allowMask.toString()
      const denyStr = denyMask.toString()

      if (existing?.id) {
        const { error: updErr } = await supabase
          .from('channel_permission_overrides')
          .update({
            allow_permissions: allowStr,
            deny_permissions: denyStr,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id)
        if (updErr) throw updErr
      } else {
        const { error: insErr } = await supabase
          .from('channel_permission_overrides')
          .insert({
            channel_id: channelId,
            target_type: targetType,
            role_id: targetType === 'role' ? targetId : null,
            user_id: targetType === 'user' ? targetId : null,
            allow_permissions: allowStr,
            deny_permissions: denyStr,
          })
        if (insErr) throw insErr
      }

      this.permissionCache.clear()
      return true
    } catch (error) {
      debug.error('Failed to set channel override:', error)
      return false
    }
  }

  /**
   * Delete a channel permission override
   */
  async deleteChannelOverride(overrideId: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('channel_permission_overrides')
        .delete()
        .eq('id', overrideId)

      if (error) throw error

      this.permissionCache.clear()
      return true
    } catch (error) {
      debug.error('Failed to delete channel override:', error)
      return false
    }
  }

  // =============================================
  // Helper Methods
  // =============================================

  /**
   * Get the highest role for a user (for display purposes)
   */
  async getHighestRole(userId: string, serverId: string): Promise<ServerRole | null> {
    const roles = await this.getUserRoles(userId, serverId)
    return roles.length > 0 ? roles[0] : null
  }

  /**
   * Get display color for a user (from highest hoisted role)
   */
  async getUserColor(userId: string, serverId: string): Promise<string | null> {
    const roles = await this.getUserRoles(userId, serverId)
    const hoistedRole = roles.find(r => r.hoist && r.color !== '#99AAB5')
    return hoistedRole?.color || null
  }

  /**
   * Check if user can manage another user (based on role hierarchy)
   */
  async canManageUser(
    managerId: string,
    targetId: string,
    serverId: string
  ): Promise<boolean> {
    // Get both users' highest roles
    const [managerRoles, targetRoles] = await Promise.all([
      this.getUserRoles(managerId, serverId),
      this.getUserRoles(targetId, serverId),
    ])

    const managerHighest = managerRoles[0]?.position || 0
    const targetHighest = targetRoles[0]?.position || 0

    return managerHighest > targetHighest
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.roleCache.clear()
    this.userRolesCache.clear()
    this.permissionCache.clear()
  }

  /**
   * Clear cache for a specific server
   */
  clearServerCache(serverId: string): void {
    this.roleCache.delete(serverId)
    // Clear user role caches for this server
    for (const key of this.userRolesCache.keys()) {
      if (key.endsWith(`-${serverId}`)) {
        this.userRolesCache.delete(key)
      }
    }
    // Clear permission caches for this server
    for (const key of this.permissionCache.keys()) {
      if (key.includes(serverId)) {
        this.permissionCache.delete(key)
      }
    }
  }
}

// Export singleton instance
export const roleService = new RoleService()

