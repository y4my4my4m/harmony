/**
 * FederationServerService - Remote server federation operations
 * 
 * Handles:
 * - Discovering remote Harmony servers
 * - Joining/leaving remote servers
 * - Syncing remote server metadata
 * 
 * Works with the federation-backend to enable cross-instance servers.
 */

import { debug } from '@/utils/debug'

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

export interface JoinServerResult {
  success: boolean
  serverId?: string
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
  error?: string
}

// Get federation backend URL from environment or default
function getFederationBackendUrl(): string {
  // Try multiple sources for the federation backend URL
  const url = import.meta.env.VITE_FEDERATION_BACKEND_URL || 
              import.meta.env.VITE_FEDERATION_URL ||
              'http://localhost:3001'
  return url.replace(/\/$/, '') // Remove trailing slash
}

/**
 * FederationServerService - Singleton for remote server operations
 */
export class FederationServerService {
  private static instance: FederationServerService
  private baseUrl: string

  private constructor() {
    this.baseUrl = getFederationBackendUrl()
  }

  static getInstance(): FederationServerService {
    if (!this.instance) {
      this.instance = new FederationServerService()
    }
    return this.instance
  }

  // =====================================================
  // DISCOVER REMOTE SERVER
  // =====================================================

  /**
   * Discover a remote server by URL or handle
   * 
   * @param serverUrl - Full URL (https://instance.com/servers/uuid) or handle (servername@instance.com)
   */
  async discoverServer(serverUrl: string): Promise<DiscoverServerResult> {
    try {
      debug.log(`🔍 Discovering remote server: ${serverUrl}`)

      const params = new URLSearchParams()
      
      // Determine if it's a URL or handle
      if (serverUrl.startsWith('http://') || serverUrl.startsWith('https://')) {
        params.set('url', serverUrl)
      } else {
        params.set('handle', serverUrl)
      }

      const response = await fetch(
        `${this.baseUrl}/api/federation/servers/discover?${params}`,
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

      // Extract instance from server URL
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

      debug.log(`✅ Found remote server: ${server.name} on ${server.instance}`)
      return { success: true, server }

    } catch (error: any) {
      debug.error('❌ Error discovering remote server:', error)
      return {
        success: false,
        error: error.message || 'Failed to connect to federation backend',
      }
    }
  }

  // =====================================================
  // JOIN REMOTE SERVER
  // =====================================================

  /**
   * Join a remote server
   * 
   * @param serverUrl - The ActivityPub URL of the server (Group actor)
   * @param userId - The local user's ID
   */
  async joinServer(serverUrl: string, userId: string): Promise<JoinServerResult> {
    try {
      debug.log(`👋 Joining remote server: ${serverUrl}`)

      const response = await fetch(
        `${this.baseUrl}/api/federation/servers/join`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({
            serverUrl,
            userId,
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

      debug.log(`✅ Join request sent, status: ${data.status}`)
      return {
        success: true,
        serverId: data.serverId,
        status: data.status,
      }

    } catch (error: any) {
      debug.error('❌ Error joining remote server:', error)
      return {
        success: false,
        error: error.message || 'Failed to connect to federation backend',
      }
    }
  }

  // =====================================================
  // LEAVE REMOTE SERVER
  // =====================================================

  /**
   * Leave a remote server
   * 
   * @param serverId - The local server reference ID
   * @param userId - The user's ID
   */
  async leaveServer(serverId: string, userId: string): Promise<LeaveServerResult> {
    try {
      debug.log(`👋 Leaving server: ${serverId}`)

      const response = await fetch(
        `${this.baseUrl}/api/federation/servers/leave`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
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

      debug.log(`✅ Left server successfully`)
      return { success: true }

    } catch (error: any) {
      debug.error('❌ Error leaving server:', error)
      return {
        success: false,
        error: error.message || 'Failed to connect to federation backend',
      }
    }
  }

  // =====================================================
  // SYNC REMOTE SERVER
  // =====================================================

  /**
   * Sync remote server metadata (channels, icon, etc.)
   * 
   * @param serverId - The local server reference ID
   */
  async syncServer(serverId: string): Promise<{ success: boolean; error?: string }> {
    try {
      debug.log(`🔄 Syncing server: ${serverId}`)

      const response = await fetch(
        `${this.baseUrl}/api/federation/servers/${serverId}/sync`,
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

      debug.log(`✅ Server synced successfully`)
      return { success: true }

    } catch (error: any) {
      debug.error('❌ Error syncing server:', error)
      return {
        success: false,
        error: error.message || 'Failed to connect to federation backend',
      }
    }
  }

  // =====================================================
  // HELPER: CHECK IF SERVER IS REMOTE
  // =====================================================

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

    // Parse handle format: name@instance
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

