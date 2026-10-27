/**
 * FederationServerService - Remote server federation operations
 * 
 * Handles:
 * - Discovering remote Harmony servers (by URL or handle)
 * - Resolving invite links from remote instances
 * - Joining/leaving remote servers
 * - Syncing remote server metadata
 * 
 * Works with the federation-backend to enable cross-instance servers.
 */

import { debug } from '@/utils/debug'
import { supabase } from '@/supabase'
import { apiUrl } from '@/services/instanceConfig'

// Types
export interface RemoteServer {
  id: string
  name: string
  description: string
  icon?: string
  memberCount: number
  channels: RemoteChannel[]
  inbox: string
  discoverable: boolean
  instance: string
  /** False: the server refuses members from other instances. Null: it does not say (before 1.8.10). */
  federationEnabled: boolean | null
}

export interface RemoteChannel {
  id: string
  name: string
  type: 'text' | 'voice'
}

export interface InviteInfo {
  code: string
  server: RemoteServer
  expiresAt?: string
  maxUses?: number
  uses?: number
  /** Server rules from the origin instance, shown before joining. */
  serverRules?: string[]
  /** Origin instance-wide rules, shown before joining. */
  instanceRules?: string[]
  createdBy?: {
    username: string
    displayName?: string
    avatar?: string
  }
}

/** This instance refuses: its staff blocked the server, or keep this account out of it. */
export type RefusedHere = 'server_blocked_here' | 'kept_out_here'

const REFUSED_HERE = new Set<string>(['server_blocked_here', 'kept_out_here'])

function refusedHere(code: unknown): { refusedHere: RefusedHere } | Record<string, never> {
  return typeof code === 'string' && REFUSED_HERE.has(code) ? { refusedHere: code as RefusedHere } : {}
}

export interface JoinServerResult {
  success: boolean
  serverId?: string
  defaultChannelId?: string
  status?: 'pending' | 'accepted' | 'rejected'
  error?: string
  /** The server answered the Join with a Reject; `reason` is its summary, when it gave one. */
  rejected?: boolean
  reason?: string | null
  refusedHere?: RefusedHere
}

export interface LeaveServerResult {
  success: boolean
  error?: string
}

export interface DiscoverServerResult {
  success: boolean
  server?: RemoteServer
  invite?: InviteInfo
  isInvite?: boolean
  error?: string
  /** The server refuses members from other instances and shows nothing of itself. */
  federationDisabled?: boolean
  refusedHere?: RefusedHere
}

// Federation backend base path (proxied via nginx)
// apiUrl resolves against the stored instance on native builds, where relative URLs
// point at the bundled app.
const federationApi = (path: string) => apiUrl(`/api/federation${path}`)

const INVITE_PATH_RE = /^\/invite\/([A-Za-z0-9_-]+)\/?$/

/** `https://host[:port]/invite/CODE`, tolerating surrounding whitespace, a trailing slash, query and fragment. */
export function parseInviteUrl(input: string): { instance: string; code: string } | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const match = url.pathname.match(INVITE_PATH_RE)
  return match ? { instance: url.host, code: match[1] } : null
}

/**
 * UUID of a Harmony Group actor (`https://host/servers/{uuid}`); equals the id
 * of the local reference row created on join.
 */
export function remoteServerUuid(actorId: string): string | null {
  const match = actorId.match(/\/servers\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i)
  return match ? match[1].toLowerCase() : null
}

/**
 * FederationServerService - Singleton for remote server operations
 */
export class FederationServerService {
  private static instance: FederationServerService

  private constructor() {}

  static getInstance(): FederationServerService {
    if (!this.instance) {
      this.instance = new FederationServerService()
    }
    return this.instance
  }

  // DISCOVER REMOTE SERVER

  /**
   * Discover a remote server by URL, handle, or invite link
   * 
   * Supported formats:
   * - Direct server URL: https://instance.com/servers/uuid
   * - Server handle: servername{'@'}instance.com
   * - Invite link: https://instance.com/invite/CODE
   * 
   * @param input - Server URL, handle, or invite link
   */
  async discoverServer(rawInput: string): Promise<DiscoverServerResult> {
    const input = rawInput.trim()
    try {
      debug.log(`Discovering: ${input}`)

      const invite = parseInviteUrl(input)
      if (invite) {
        return await this.resolveInviteLink(input, invite.instance, invite.code)
      }

      // Regular server discovery
      const params = new URLSearchParams()
      
      if (input.startsWith('http://') || input.startsWith('https://')) {
        params.set('url', input)
      } else {
        params.set('handle', input)
      }

      const response = await fetch(
        federationApi(`/servers/discover?${params}`),
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
        }
      )

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        return {
          success: false,
          error: errorData.error || `Server not found (${response.status})`,
          ...refusedHere(errorData.code),
        }
      }

      const data = await response.json()

      if (!data.success || !data.server) {
        return {
          success: false,
          error: data.error || 'Invalid response from federation backend',
        }
      }

      const serverInstance = new URL(data.server.id).hostname

      const server: RemoteServer = {
        id: data.server.id,
        // A Group closed to other instances serves no name.
        name: data.server.name || serverInstance,
        description: data.server.description || '',
        icon: data.server.icon,
        memberCount: data.server.memberCount || 0,
        channels: data.server.channels || [],
        inbox: data.server.inbox,
        discoverable: data.server.discoverable,
        instance: serverInstance,
        federationEnabled: typeof data.server.federationEnabled === 'boolean' ? data.server.federationEnabled : null,
      }

      debug.log(`Found remote server: ${server.name} on ${server.instance}`)
      return { success: true, server, isInvite: false }

    } catch (error: any) {
      debug.error('Error discovering remote server:', error)
      return {
        success: false,
        error: error.message || 'Failed to connect to federation backend',
      }
    }
  }

  // RESOLVE INVITE LINK

  /**
   * Resolve an invite link from a remote instance
   * Routes through local backend to avoid CORS issues
   * 
   * @param fullUrl - The full invite URL
   * @param instance - The instance domain
   * @param code - The invite code
   */
  private async resolveInviteLink(
    fullUrl: string, 
    instance: string, 
    code: string
  ): Promise<DiscoverServerResult> {
    try {
      debug.log(`Resolving invite: ${code} from ${instance}`)

      // Route through local backend to avoid CORS issues
      // Backend will proxy the request to the remote instance
      const response = await fetch(
        federationApi(`/invites/resolve`),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({
            instance,
            code,
          }),
        }
      )

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        if (response.status === 404) {
          return { success: false, error: 'Invite not found or expired' }
        }
        if (errorData.code === 'federation_disabled') {
          return { success: false, federationDisabled: true, error: errorData.error || 'This server does not accept members from other instances' }
        }
        if (REFUSED_HERE.has(errorData.code)) {
          return { success: false, error: errorData.error, ...refusedHere(errorData.code) }
        }
        return { success: false, error: errorData.error || `Failed to resolve invite (${response.status})` }
      }

      const data = await response.json()

      if (!data.server) {
        return { success: false, error: 'Invalid invite response' }
      }

      const server: RemoteServer = {
        id: data.server.id || `https://${instance}/servers/${data.server.serverId}`,
        name: data.server.name,
        description: data.server.description || '',
        icon: data.server.icon,
        memberCount: data.server.memberCount || 0,
        channels: data.server.channels || [],
        inbox: data.server.inbox || `https://${instance}/servers/${data.server.serverId}/inbox`,
        discoverable: false, // Private server accessed via invite
        instance,
        federationEnabled: typeof data.server.federationEnabled === 'boolean' ? data.server.federationEnabled : null,
      }

      const invite: InviteInfo = {
        code,
        server,
        expiresAt: data.expiresAt,
        maxUses: data.maxUses,
        uses: data.uses,
        serverRules: Array.isArray(data.server.rules) ? data.server.rules : [],
        instanceRules: Array.isArray(data.instanceRules) ? data.instanceRules : [],
        createdBy: data.createdBy,
      }

      debug.log(`Resolved invite to: ${server.name} on ${instance}`)
      return { success: true, server, invite, isInvite: true }

    } catch (error: any) {
      debug.error('Error resolving invite:', error)
      return {
        success: false,
        error: error.message || 'Failed to resolve invite link',
      }
    }
  }

  // JOIN REMOTE SERVER

  /**
   * Join a remote server (via direct URL or invite)
   * 
   * @param serverUrl - The ActivityPub URL of the server (Group actor)
   * @param userId - The local user's ID
   * @param inviteCode - Optional invite code for private servers
   */
  async joinServer(
    serverUrl: string, 
    userId: string, 
    inviteCode?: string
  ): Promise<JoinServerResult> {
    try {
      debug.log(`Joining remote server: ${serverUrl}${inviteCode ? ` with invite ${inviteCode}` : ''}`)

      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        return { success: false, error: 'Not authenticated' }
      }

      const response = await fetch(
        federationApi(`/servers/join`),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            serverUrl,
            userId,
            inviteCode,
          }),
        }
      )

      const data = await response.json()

      if (!response.ok) {
        return {
          success: false,
          error: data.error || `Failed to join server (${response.status})`,
          ...(data.code === 'join_rejected' ? { rejected: true, reason: data.reason ?? null } : {}),
          ...refusedHere(data.code),
        }
      }

      debug.log(`Join request sent, status: ${data.status}`)
      return {
        success: true,
        serverId: data.serverId,
        defaultChannelId: data.defaultChannelId,
        status: data.status,
      }

    } catch (error: any) {
      debug.error('Error joining remote server:', error)
      return {
        success: false,
        error: error.message || 'Failed to connect to federation backend',
      }
    }
  }

  // LEAVE REMOTE SERVER

  /**
   * Leave a remote server
   * 
   * @param serverId - The local server reference ID
   * @param userId - The user's ID
   */
  async leaveServer(serverId: string, userId: string): Promise<LeaveServerResult> {
    try {
      debug.log(`Leaving server: ${serverId}`)

      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        return { success: false, error: 'Not authenticated' }
      }

      const response = await fetch(
        federationApi(`/servers/leave`),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            serverId,
            userId,
          }),
        }
      )

      const data = await response.json()

      if (!response.ok) {
        return {
          success: false,
          error: data.error || `Failed to leave server (${response.status})`,
        }
      }

      debug.log(`Left server successfully`)
      return { success: true }

    } catch (error: any) {
      debug.error('Error leaving server:', error)
      return {
        success: false,
        error: error.message || 'Failed to connect to federation backend',
      }
    }
  }

  // SYNC REMOTE SERVER

  /**
   * Sync a remote server's copy: channels, icon, roles, pins, and, for a member, the members and
   * their roles. Read from the host as the signed-in member.
   *
   * @param serverId - The local server reference ID
   */
  async syncServer(serverId: string): Promise<{ success: boolean; error?: string }> {
    try {
      debug.log(`Syncing server: ${serverId}`)

      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch(
        federationApi(`/servers/${serverId}/sync`),
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            ...(session?.access_token ? { 'Authorization': `Bearer ${session.access_token}` } : {}),
          },
        }
      )

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        return {
          success: false,
          error: data.error || `Failed to sync server (${response.status})`,
        }
      }

      debug.log(`Server synced successfully`)
      return { success: true }

    } catch (error: any) {
      debug.error('Error syncing server:', error)
      return {
        success: false,
        error: error.message || 'Failed to connect to federation backend',
      }
    }
  }

  // REMOTE SERVER STATUS

  /**
   * Whether a remote server still takes members from this instance (federation-backend
   * GET /servers/:id/status, its Group read as the caller). Null when there is no answer.
   */
  async serverStatus(serverId: string): Promise<{ federationClosed: boolean } | null> {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return null

      const response = await fetch(federationApi(`/servers/${serverId}/status`), {
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
      })
      if (!response.ok) return null
      const data = await response.json()
      return { federationClosed: data?.federationClosed === true }
    } catch (error) {
      debug.warn('Remote server status unavailable:', error)
      return null
    }
  }

  // HELPER: CHECK IF SERVER IS REMOTE

  /**
   * Check if a server URL is from a remote instance
   * 
   * @param serverUrl - The server URL to check
   * @param localDomain - The local instance domain
   */
  isRemoteServer(serverUrl: string, localDomain: string): boolean {
    try {
      const serverDomain = new URL(serverUrl).hostname
      return serverDomain !== localDomain
    } catch {
      return false
    }
  }

  /**
   * Parse a server handle into its components
   * 
   * @param handle - Format: "servername@instance.com" or "https://instance.com/servers/uuid"
   */
  parseServerHandle(handle: string): { name?: string; instance?: string; url?: string } {
    if (handle.startsWith('http://') || handle.startsWith('https://')) {
      try {
        const url = new URL(handle)
        return {
          instance: url.hostname,
          url: handle,
        }
      } catch {
        return {}
      }
    }

    const match = handle.match(/^([^@]+)@(.+)$/)
    if (match) {
      return {
        name: match[1],
        instance: match[2],
      }
    }

    return {}
  }
}

// Export singleton instance
export const federationServerService = FederationServerService.getInstance()

