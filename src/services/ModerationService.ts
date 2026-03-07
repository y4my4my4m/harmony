import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

export interface ServerBan {
  id: string
  user_id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  banned_by: string
  banned_by_username: string | null
  reason: string | null
  created_at: string
}

export type DeleteMessageDuration = 0 | 3600 | 86400 | 604800

export const DELETE_MESSAGE_OPTIONS: { label: string; value: DeleteMessageDuration }[] = [
  { label: "Don't Delete Any", value: 0 },
  { label: 'Last Hour', value: 3600 },
  { label: 'Last 24 Hours', value: 86400 },
  { label: 'Last 7 Days', value: 604800 },
]

class ModerationService {
  async kickMember(
    serverId: string,
    userId: string,
    reason?: string,
    deleteMessageSeconds: DeleteMessageDuration = 0
  ): Promise<{ success: boolean; messagesDeleted?: number; error?: string }> {
    try {
      const { data, error } = await supabase.rpc('kick_server_member', {
        p_server_id: serverId,
        p_user_id: userId,
        p_reason: reason || null,
        p_delete_message_seconds: deleteMessageSeconds,
      })

      if (error) {
        debug.error('Failed to kick member:', error)
        return { success: false, error: error.message }
      }

      return { success: true, messagesDeleted: data?.messages_deleted || 0 }
    } catch (err: any) {
      debug.error('Kick member exception:', err)
      return { success: false, error: err.message }
    }
  }

  async banMember(
    serverId: string,
    userId: string,
    reason?: string,
    deleteMessageSeconds: DeleteMessageDuration = 0
  ): Promise<{ success: boolean; messagesDeleted?: number; error?: string }> {
    try {
      const { data, error } = await supabase.rpc('ban_server_member', {
        p_server_id: serverId,
        p_user_id: userId,
        p_reason: reason || null,
        p_delete_message_seconds: deleteMessageSeconds,
      })

      if (error) {
        debug.error('Failed to ban member:', error)
        return { success: false, error: error.message }
      }

      return { success: true, messagesDeleted: data?.messages_deleted || 0 }
    } catch (err: any) {
      debug.error('Ban member exception:', err)
      return { success: false, error: err.message }
    }
  }

  async unbanMember(
    serverId: string,
    userId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { data, error } = await supabase.rpc('unban_server_member', {
        p_server_id: serverId,
        p_user_id: userId,
      })

      if (error) {
        debug.error('Failed to unban member:', error)
        return { success: false, error: error.message }
      }

      if (data?.error) {
        return { success: false, error: data.error }
      }

      return { success: true }
    } catch (err: any) {
      debug.error('Unban member exception:', err)
      return { success: false, error: err.message }
    }
  }

  async getServerBans(serverId: string): Promise<ServerBan[]> {
    try {
      const { data, error } = await supabase.rpc('get_server_bans', {
        p_server_id: serverId,
      })

      if (error) {
        debug.error('Failed to fetch server bans:', error)
        return []
      }

      return (data as ServerBan[]) || []
    } catch (err) {
      debug.error('Get server bans exception:', err)
      return []
    }
  }
}

export const moderationService = new ModerationService()
