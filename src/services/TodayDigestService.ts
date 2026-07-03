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
  serverIcon: string | null
  unreadMessages: number
  unreadMentions: number
}

export interface ChannelHighlight {
  channelId: string
  serverId: string
  channelName: string
  serverName: string
  serverIcon: string | null
  summary: string
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
  followedPosts: TimelinePost[]
}

class TodayDigestService {
  async getDigest(): Promise<TodayDigest> {
    const profileId = await authContextService.getCurrentProfileId()

    const [channels, threads, trending, followed, mentions] = await Promise.all([
      this.getActiveChannels(profileId),
      this.getActiveThreads(profileId),
      this.getTrendingPosts(),
      this.getFollowedPosts(profileId),
      this.getUnreadMentionCount(profileId),
    ])

    return {
      unreadMentions: mentions,
      activeChannels: channels,
      activeThreads: threads,
      trendingPosts: trending,
      followedPosts: followed,
    }
  }

  /**
   * A stable fingerprint of the digest's inputs. The view caches AI output
   * against this: same signature → same summary, no model re-run.
   */
  digestSignature(digest: TodayDigest): string {
    const parts = [
      ...digest.activeChannels.map(c => `${c.channelId}:${c.unreadMessages}:${c.unreadMentions}`),
      ...digest.activeThreads.map(t => `${t.threadId}:${t.messageCount}`),
      ...digest.trendingPosts.map(p => p.id),
      ...digest.followedPosts.map(p => p.id),
      String(digest.unreadMentions),
    ]
    return parts.join('|')
  }

  // Cap: 12 unread channels ACROSS ALL SERVERS, mention-heavy first. The
  // view groups them per server; a busy server can therefore occupy several
  // slots but never crowds out another server's mentions (mentions sort
  // first regardless of origin).
  private async getActiveChannels(profileId: string, limit = 12): Promise<ActiveChannelEntry[]> {
    const { data, error } = await supabase
      .from('unread_counts')
      .select(`
        channel_id,
        server_id,
        unread_messages,
        unread_mentions,
        channels ( name ),
        servers ( name, icon )
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
        serverIcon: row.servers?.icon || null,
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

  /**
   * Recent posts from people the user follows (last 48h), ranked by
   * engagement so the section surfaces what mattered, not just what's newest.
   */
  private async getFollowedPosts(profileId: string, limit = 5): Promise<TimelinePost[]> {
    const { data: follows, error: followsError } = await supabase
      .from('follows')
      .select('following_id')
      .eq('follower_id', profileId)
      .eq('status', 'accepted')
      .limit(400)

    if (followsError || !follows || follows.length === 0) return []

    const since = new Date(Date.now() - 48 * 3600_000).toISOString()
    const { data: posts, error } = await supabase
      .from('posts')
      .select(`
        *,
        author:profiles!posts_author_id_fkey(
          id, username, display_name, avatar_url, color, domain, is_local
        )
      `)
      .in('author_id', follows.map(f => f.following_id))
      .in('visibility', ['public', 'unlisted'])
      .or('is_deleted.is.null,is_deleted.eq.false')
      .is('in_reply_to', null)
      .gt('created_at', since)
      .order('created_at', { ascending: false })
      .limit(40)

    if (error) {
      debug.warn('Today digest: failed to load followed posts:', error)
      return []
    }

    return ((posts as TimelinePost[]) || [])
      .sort((a, b) => this.relevanceScore(b) - this.relevanceScore(a))
      .slice(0, limit)
  }

  /**
   * Engagement-psychology ranking for the followed-posts section.
   *
   * - Replies weigh most: an active conversation is an invitation to
   *   participate, which retains far better than passively-likeable content.
   * - Reblogs next: endorsement + spread.
   * - Favorites sublinear: the cheapest signal, with diminishing returns -
   *   2000 replies / 20 favorites should beat 21 favorites / 2 replies.
   * - Exponential time decay (18h half-life) so yesterday's viral post
   *   doesn't pin the list while today's discussion is happening.
   */
  private relevanceScore(p: any): number {
    const replies = Math.pow(Math.max(0, p.replies_count || 0), 0.9) * 3
    const reblogs = Math.pow(Math.max(0, p.reblogs_count || 0), 0.8) * 2
    const favorites = Math.pow(Math.max(0, p.favorites_count || 0), 0.7)

    const ageHours = Math.max(0, (Date.now() - new Date(p.created_at).getTime()) / 3600_000)
    const decay = Math.pow(0.5, ageHours / 18)

    return (replies + reblogs + favorites + 0.1) * decay
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
   * Per-channel sub-summaries ("A and B discussed X"), built from the last
   * ~30 plaintext messages of the busiest unread channels and summarized
   * on-device. Encrypted messages are skipped entirely - their ciphertext
   * never reaches the model. Empty when the model is unavailable.
   */
  async getChannelHighlights(channels: ActiveChannelEntry[], maxChannels = 3): Promise<ChannelHighlight[]> {
    const Summarizer = (globalThis as any).Summarizer
    if (typeof Summarizer?.availability !== 'function') return []

    try {
      if (await Summarizer.availability() !== 'available') return []
    } catch {
      return []
    }

    const targets = await this.rankChannelsForHighlights(channels, maxChannels)
    const highlights: ChannelHighlight[] = []

    for (const channel of targets) {
      const transcript = await this.getChannelTranscript(channel.channelId)
      if (!transcript) continue

      let summarizer: any = null
      try {
        summarizer = await Summarizer.create({
          type: 'tldr',
          format: 'plain-text',
          length: 'short',
        })
        const summary = await summarizer.summarize(transcript, {
          context:
            'Chat channel transcript, oldest first. One or two sentences: say who talked about what. ' +
            'Refer to people by name.',
        })
        if (typeof summary === 'string' && summary.trim()) {
          highlights.push({
            channelId: channel.channelId,
            serverId: channel.serverId,
            channelName: channel.channelName,
            serverName: channel.serverName,
            serverIcon: channel.serverIcon,
            summary: summary.trim(),
          })
        }
      } catch (error) {
        debug.warn(`Today digest: highlight failed for #${channel.channelName}:`, error)
      } finally {
        summarizer?.destroy?.()
      }
    }

    return highlights
  }

  /**
   * Pick which channels deserve an AI highlight. Raw unread volume is a weak
   * signal (one hyperactive server drowns everything); weight instead by:
   *   - mentions (someone wanted YOU there)
   *   - channels the user recently posted in themselves (their actual circles)
   *   - unread volume as the tie-breaker
   */
  private async rankChannelsForHighlights(
    channels: ActiveChannelEntry[],
    maxChannels: number,
  ): Promise<ActiveChannelEntry[]> {
    let myRecentChannelIds = new Set<string>()
    try {
      const profileId = await authContextService.getCurrentProfileId()
      const { data } = await supabase
        .from('messages')
        .select('channel_id')
        .eq('user_id', profileId)
        .not('channel_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(50)
      myRecentChannelIds = new Set((data || []).map((m: any) => m.channel_id))
    } catch {
      /* fall back to unread-only ranking */
    }

    const score = (c: ActiveChannelEntry) =>
      c.unreadMentions * 100 +
      (myRecentChannelIds.has(c.channelId) ? 50 : 0) +
      Math.min(c.unreadMessages, 40)

    return [...channels]
      .sort((a, b) => score(b) - score(a))
      .slice(0, maxChannels)
  }

  /** "Name: text" lines from recent plaintext messages, oldest first. */
  private async getChannelTranscript(channelId: string, limit = 30): Promise<string | null> {
    const { data: messages, error } = await supabase
      .from('messages')
      .select('user_id, content, encrypted, created_at')
      .eq('channel_id', channelId)
      .or('is_deleted.is.null,is_deleted.eq.false')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error || !messages || messages.length === 0) return null

    const userIds = [...new Set(messages.map((m: any) => m.user_id).filter(Boolean))]
    const nameById = new Map<string, string>()
    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name, username')
        .in('id', userIds)
      for (const p of profiles || []) {
        nameById.set(p.id, p.display_name || p.username || 'Someone')
      }
    }

    const lines: string[] = []
    for (const msg of [...messages].reverse()) {
      if ((msg as any).encrypted) continue
      const text = this.extractText((msg as any).content)
      if (!text) continue
      const name = nameById.get((msg as any).user_id) || 'Someone'
      lines.push(`${name}: ${text.slice(0, 300)}`)
    }

    if (lines.length < 3) return null
    return lines.join('\n').slice(0, 6000)
  }

  private extractText(content: unknown): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
      .map((part: any) => part.text)
      .join(' ')
      .trim()
  }

}

export const todayDigestService = new TodayDigestService()
