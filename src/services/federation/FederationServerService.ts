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

export interface JoinServerResult {
  success: boolean
  serverId?: string
  defaultChannelId?: string
  status?: 'pending' | 'accepted' | 'rejected'
  error?: string
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
        name: data.server.name,
        description: data.server.description || '',
        icon: data.server.icon,
        memberCount: data.server.memberCount || 0,
        channels: data.server.channels || [],
        inbox: data.server.inbox,
        discoverable: data.server.discoverable,
        instance: serverInstance,
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
   * Sync remote server metadata (channels, icon, etc.)
   * 
   * @param serverId - The local server reference ID
   */
  async syncServer(serverId: string): Promise<{ success: boolean; error?: string }> {
    try {
      debug.log(`Syncing server: ${serverId}`)

      const response = await fetch(
        federationApi(`/servers/${serverId}/sync`),
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
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

