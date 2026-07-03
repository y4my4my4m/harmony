/**
 * Data aggregation for the "Today" dashboard (beta).
 *
 * Pulls together, without any new server-side infrastructure:
 *   - channels with the most unread activity (from unread_counts)
 *   - threads the user participates in, ordered by recent activity
 *   - trending ActivityPub posts (reuses TrendingService)
 *   - total unread mentions
 *
 * Optionally produces a short on-device AI summary of the digest using
 * Chrome's built-in Summarizer API (Gemini Nano). No text ever leaves the
 * device; when the API is unavailable the digest simply renders without it.
 */

import { supabase } from '@/supabase'
import { authContextService } from '@/services/AuthContextService'
import { trendingService } from '@/services/TrendingService'
import type { TimelinePost } from '@/types'
import { debug } from '@/utils/debug'

export interface ActiveChannelEntry {
  channelId: string
  serverId: string
  channelName: string
  serverName: string
  unreadMessages: number
  unreadMentions: number
}

export interface ActiveThreadEntry {
  threadId: string
  serverId: string
  name: string
  messageCount: number
  lastMessageAt: string | null
}

export interface TodayDigest {
  unreadMentions: number
  activeChannels: ActiveChannelEntry[]
  activeThreads: ActiveThreadEntry[]
  trendingPosts: TimelinePost[]
}

class TodayDigestService {
  async getDigest(): Promise<TodayDigest> {
    const profileId = await authContextService.getCurrentProfileId()

    const [channels, threads, trending, mentions] = await Promise.all([
      this.getActiveChannels(profileId),
      this.getActiveThreads(profileId),
      this.getTrendingPosts(),
      this.getUnreadMentionCount(profileId),
    ])

    return {
      unreadMentions: mentions,
      activeChannels: channels,
      activeThreads: threads,
      trendingPosts: trending,
    }
  }

  private async getActiveChannels(profileId: string, limit = 6): Promise<ActiveChannelEntry[]> {
    const { data, error } = await supabase
      .from('unread_counts')
      .select(`
        channel_id,
        server_id,
        unread_messages,
        unread_mentions,
        channels ( name ),
        servers ( name )
      `)
      .eq('user_id', profileId)
      .not('channel_id', 'is', null)
      .gt('unread_messages', 0)
      .order('unread_mentions', { ascending: false })
      .order('unread_messages', { ascending: false })
      .limit(limit)

    if (error) {
      debug.warn('Today digest: failed to load active channels:', error)
      return []
    }

    return (data || [])
      .filter((row: any) => row.channels && row.server_id)
      .map((row: any) => ({
        channelId: row.channel_id,
        serverId: row.server_id,
        channelName: row.channels.name,
        serverName: row.servers?.name || '',
        unreadMessages: row.unread_messages || 0,
        unreadMentions: row.unread_mentions || 0,
      }))
  }

  private async getActiveThreads(profileId: string, limit = 5): Promise<ActiveThreadEntry[]> {
    const { data, error } = await supabase
      .from('thread_members')
      .select(`
        thread_id,
        threads (
          id,
          name,
          message_count,
          last_message_at,
          archived,
          channels ( server_id )
        )
      `)
      .eq('user_id', profileId)
      .limit(30)

    if (error) {
      debug.warn('Today digest: failed to load threads:', error)
      return []
    }

    return (data || [])
      .map((row: any) => row.threads)
      .filter((t: any) => t && !t.archived && t.channels?.server_id)
      .sort((a: any, b: any) =>
        new Date(b.last_message_at || 0).getTime() - new Date(a.last_message_at || 0).getTime())
      .slice(0, limit)
      .map((t: any) => ({
        threadId: t.id,
        serverId: t.channels.server_id,
        name: t.name,
        messageCount: t.message_count || 0,
        lastMessageAt: t.last_message_at,
      }))
  }

  private async getTrendingPosts(limit = 5): Promise<TimelinePost[]> {
    try {
      const trending = await trendingService.getTrendingPosts({ limit, timeRange: '24h' })
      return trending.map(t => t.post)
    } catch (error) {
      debug.warn('Today digest: failed to load trending posts:', error)
      return []
    }
  }

  private async getUnreadMentionCount(profileId: string): Promise<number> {
    const { data, error } = await supabase
      .from('unread_counts')
      .select('unread_mentions')
      .eq('user_id', profileId)
      .gt('unread_mentions', 0)

    if (error) return 0
    return (data || []).reduce((sum, row: any) => sum + (row.unread_mentions || 0), 0)
  }

  // ---------------------------------------------------------------------
  // On-device AI (Chrome built-in Summarizer API / Gemini Nano)
  // ---------------------------------------------------------------------

  isOnDeviceAiSupported(): boolean {
    return typeof (globalThis as any).Summarizer?.availability === 'function'
  }

  /**
   * Summarize the digest on-device. Returns null when the API is missing,
   * the model isn't downloaded, or summarization fails - callers treat the
   * summary as strictly optional.
   */
  async summarizeDigest(digest: TodayDigest): Promise<string | null> {
    const Summarizer = (globalThis as any).Summarizer
    if (typeof Summarizer?.availability !== 'function') return null

    try {
      const availability = await Summarizer.availability()
      if (availability !== 'available') {
        debug.log(`Today digest: on-device model not ready (${availability})`)
        return null
      }

      const summarizer = await Summarizer.create({
        type: 'tldr',
        format: 'plain-text',
        length: 'short',
      })

      try {
        const text = this.digestToPlainText(digest)
        if (!text) return null
        const summary = await summarizer.summarize(text, {
          context: 'Activity digest for a chat and social app user. Address the reader directly.',
        })
        return typeof summary === 'string' && summary.trim() ? summary.trim() : null
      } finally {
        summarizer.destroy?.()
      }
    } catch (error) {
      debug.warn('Today digest: on-device summarization failed:', error)
      return null
    }
  }

  private digestToPlainText(digest: TodayDigest): string {
    const parts: string[] = []

    if (digest.unreadMentions > 0) {
      parts.push(`You have ${digest.unreadMentions} unread mentions.`)
    }
    for (const c of digest.activeChannels) {
      parts.push(`Channel #${c.channelName} in ${c.serverName} has ${c.unreadMessages} unread messages.`)
    }
    for (const t of digest.activeThreads) {
      parts.push(`Thread "${t.name}" you participate in has ${t.messageCount} messages.`)
    }
    for (const p of digest.trendingPosts) {
      const author = (p as any).author?.display_name || (p as any).author?.username
      if (author) parts.push(`A post by ${author} is trending.`)
    }

    return parts.join('\n')
  }
}

export const todayDigestService = new TodayDigestService()
