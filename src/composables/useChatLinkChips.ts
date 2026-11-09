/**
 * Message links drawn as channel references: `#channel` for a channel or its message,
 * `#channel › thread` for a thread or its message.
 *
 * Names are read at display time with the viewer's own access. A link to a place the viewer
 * cannot read stays a plain URL and names nothing. Covers links `channel_mention` parts miss:
 * threads, other servers and DMs (unifiedContentProcessing.matchChannelUrl reads the current
 * server's channels only).
 */

import { shallowReactive } from 'vue'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { parseChatLink, type ChatLinkTarget } from '@/utils/chatLinks'

interface ThreadName {
  name: string
  channelName: string | null
}

const threadNames = shallowReactive(new Map<string, ThreadName | null>())
const channelNames = shallowReactive(new Map<string, string | null>())
const reading = new Set<string>()

async function readChannelName(channelId: string): Promise<string | null> {
  const { data, error } = await supabase.from('channels').select('name').eq('id', channelId).maybeSingle()
  if (error) throw error
  return data?.name ?? null
}

function loadOnce(key: string, load: () => Promise<void>): void {
  if (reading.has(key)) return
  reading.add(key)
  load().catch((err) => debug.warn('Chat link lookup failed:', err))
}

function loadChannel(channelId: string): void {
  loadOnce(`channel:${channelId}`, async () => {
    channelNames.set(channelId, await readChannelName(channelId))
  })
}

function loadThread(threadId: string): void {
  loadOnce(`thread:${threadId}`, async () => {
    const { data, error } = await supabase.from('threads').select('name, channel_id').eq('id', threadId).maybeSingle()
    if (error) throw error
    if (!data) {
      threadNames.set(threadId, null)
      return
    }
    const channelName = data.channel_id ? await readChannelName(data.channel_id).catch(() => null) : null
    threadNames.set(threadId, { name: data.name, channelName })
  })
}

export interface ChatLinkChip {
  target: ChatLinkTarget
  channelName: string | null
  threadName: string | null
  /** Full text, for the title attribute. */
  title: string
}

/** Chip of a chat URL once its names are known; null for any other URL and while loading. */
export function chatLinkChip(url: unknown): ChatLinkChip | null {
  const target = parseChatLink(url)
  if (!target) return null

  if (target.threadId) {
    if (!threadNames.has(target.threadId)) {
      loadThread(target.threadId)
      return null
    }
    const thread = threadNames.get(target.threadId)
    if (!thread) return null
    return {
      target,
      channelName: thread.channelName,
      threadName: thread.name,
      title: thread.channelName ? `#${thread.channelName} › ${thread.name}` : thread.name,
    }
  }

  const channelId = target.channelId!
  if (!channelNames.has(channelId)) {
    loadChannel(channelId)
    return null
  }
  const name = channelNames.get(channelId)
  if (!name) return null
  return { target, channelName: name, threadName: null, title: `#${name}` }
}
