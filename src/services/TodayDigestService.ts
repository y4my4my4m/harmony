/**
 * Data for the Today dashboard.
 *
 * The summary is one call to public.get_today_summary, shaped by utils/todaySummary.
 * Encrypted messages in it are decrypted in a second, local pass; the view shows the
 * "Encrypted message" placeholder until that pass replaces them.
 *
 * Channel highlights run through Chrome's built-in Summarizer API (Gemini Nano) and read
 * recent messages per channel; text stays on-device. They are optional and additive.
 */

import { supabase } from '@/supabase'
import { authContextService } from '@/services/AuthContextService'
import type { Message } from '@/types'
import { debug } from '@/utils/debug'
import {
  encryptedMessages,
  shapeTodaySummary,
  type TodayServerGroup,
  type TodaySummary,
} from '@/utils/todaySummary'

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

class TodayDigestService {
  /** Null when the caller has no profile. */
  async getSummary(since: string | null, signal?: AbortSignal): Promise<TodaySummary | null> {
    let request = supabase.rpc('get_today_summary', { p_since: since })
    if (signal) request = request.abortSignal(signal)
    const { data, error } = await request
    if (error) throw new Error(error.message)
    if (data == null) return null
    return shapeTodaySummary(data)
  }

  /** Decrypted copies of the summary's encrypted messages; failures are left out. */
  async decryptSummaryMessages(summary: TodaySummary): Promise<Message[]> {
    const targets = encryptedMessages(summary)
    if (targets.length === 0) return []
    try {
      const { processMessageDecryption } = await import('@/utils/messageDecryption')
      const result = await processMessageDecryption(targets.map(m => ({ ...m })))
      return result.filter(m => m.decrypted === true)
    } catch (error) {
      debug.warn('Today: decrypting summary messages failed:', error)
      return []
    }
  }

  /** Unread channels across servers, mentions first, then by unread count. */
  activeChannels(servers: readonly TodayServerGroup[], limit = 12): ActiveChannelEntry[] {
    const out: ActiveChannelEntry[] = []
    for (const server of servers) {
      for (const channel of server.channels) {
        out.push({
          channelId: channel.id,
          serverId: server.id,
          channelName: channel.name,
          serverName: server.name,
          serverIcon: server.icon,
          unreadMessages: channel.unreadMessages,
          unreadMentions: channel.unreadMentions,
        })
      }
    }
    return out
      .sort((a, b) => b.unreadMentions - a.unreadMentions || b.unreadMessages - a.unreadMessages)
      .slice(0, limit)
  }

  /** Fingerprint of the highlight inputs. */
  highlightSignature(channels: readonly ActiveChannelEntry[]): string {
    return channels.map(c => `${c.channelId}:${c.unreadMessages}:${c.unreadMentions}`).join('|')
  }

  async markServerRead(serverId: string): Promise<void> {
    const { error } = await supabase.rpc('mark_server_as_read', { p_server_id: serverId })
    if (error) throw new Error(error.message)
  }

  // On-device AI (Chrome built-in Summarizer API / Gemini Nano)

  isOnDeviceAiSupported(): boolean {
    return typeof (globalThis as any).Summarizer?.availability === 'function'
  }

  /**
   * Per-channel summaries built from the last 30 plaintext messages of the
   * top-ranked unread channels. Encrypted messages are skipped; ciphertext
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
        debug.warn(`Today: highlight failed for #${channel.channelName}:`, error)
      } finally {
        summarizer?.destroy?.()
      }
    }

    return highlights
  }

  /**
   * Selects channels for AI highlights. Unread volume alone lets one
   * hyperactive server dominate, so the score weights, in order:
   *   - mentions of the user
   *   - channels the user recently posted in
   *   - unread volume, as tie-breaker
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
