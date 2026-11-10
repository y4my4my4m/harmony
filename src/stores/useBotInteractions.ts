// Slash command invocations of this user, as the invoker's lines at the end of a channel or
// thread. Memory only: rows vanish on reload. Status arrives through the user channel push
// ('bot_interaction:update', 20261110400001_bot_slash_commands.sql), through a public reply
// carrying metadata.interaction, and through get_my_bot_interactions on reconnect, on channel open
// and at each deadline, so a missed push never reads as silence.

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { supabase } from '@/supabase'
import { userEventChannel } from '@/services/UserEventChannel'
import { useChatStore } from '@/stores/useChat'
import { fetchBotProfile } from '@/services/botProfileService'
import {
  getMyBotInteractions,
  type BotCommandBot,
  type BotInteractionReply,
  type BotInteractionRow,
  type BotInteractionStatus,
  type BotInvokeResult,
} from '@/services/botCommandService'
import type { Message } from '@/types'
import { debug } from '@/utils/debug'

// bot_interactions.respond_by is created_at + 5 s, expires_at created_at + 15 min. A row first seen
// through a push carries expires_in_ms only; its respond window is derived from the difference.
const RESPOND_WINDOW_MS = 5_000
const EXPIRES_WINDOW_MS = 15 * 60_000
// Interaction ids of public replies remembered for rows not yet added; oldest dropped first.
const ANSWERED_IDS_KEPT = 200

export interface BotInteractionEntry {
  id: string
  botId: string
  bot: BotCommandBot | null
  channelId: string
  threadId: string | null
  /** Full command path, "bridge clone-server". */
  commandName: string
  status: BotInteractionStatus
  error: string | null
  ephemeral: boolean
  responseMessageId: string | null
  replies: BotInteractionReply[]
  /** The bot let its window pass: 5 s before an acknowledgement, 15 min after a defer. */
  timedOut: boolean
  /** Order of creation in this client. */
  seq: number
}

/** What the line says. */
export type BotInteractionPhase =
  | 'thinking'
  | 'replied'
  | 'timed_out'
  | 'offline'
  | 'cannot_post'
  | 'blocked'
  | 'thread_locked'
  | 'failed'
  | 'done'

const WAITING_FOR_ACK: readonly BotInteractionStatus[] = ['pending', 'delivered']
const WAITING_FOR_REPLY: readonly BotInteractionStatus[] = ['deferred', 'responding']

export function interactionPhase(row: BotInteractionEntry): BotInteractionPhase {
  if (row.status === 'failed') {
    switch (row.error) {
      case 'offline': return 'offline'
      case 'bot_cannot_post': return 'cannot_post'
      case 'automod_blocked': return 'blocked'
      case 'thread_locked': return 'thread_locked'
      default: return 'failed'
    }
  }
  if (row.status === 'expired' || row.timedOut) return 'timed_out'
  if (row.status === 'responded') return row.replies.length > 0 ? 'replied' : 'done'
  return 'thinking'
}

/** data-status of the line: the row's status, or 'timed_out' / 'offline'. */
export function interactionStatusAttr(row: BotInteractionEntry): string {
  const phase = interactionPhase(row)
  if (phase === 'timed_out' || phase === 'offline') return phase
  return row.status
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Payload of the 'bot_interaction:update' user event. */
interface BotInteractionPush {
  id?: string
  bot_id?: string
  channel_id?: string
  thread_id?: string | null
  command_name?: string
  status?: BotInteractionStatus
  error?: string | null
  ephemeral?: boolean | null
  response_message_id?: string | null
  reply?: BotInteractionReply | null
  reply_count?: number
  expires_in_ms?: number
}

export const useBotInteractionsStore = defineStore('botInteractions', () => {
  const rows = ref<Record<string, BotInteractionEntry>>({})
  const bots = new Map<string, BotCommandBot>()
  const botLookups = new Map<string, Promise<void>>()
  const deadlines = new Map<string, { respondAt: number; expireAt: number }>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  // A public reply seen before its row: an invoke answer racing the message broadcast.
  const answeredIds = new Set<string>()
  let seq = 0
  let offs: Array<() => void> = []

  function clearTimer(id: string) {
    const timer = timers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(id)
  }

  // One timer per row: the respond deadline while unacknowledged, the expiry once deferred.
  function schedule(id: string) {
    clearTimer(id)
    const row = rows.value[id]
    const due = deadlines.get(id)
    if (!row || !due || row.timedOut) return
    const at = WAITING_FOR_ACK.includes(row.status)
      ? due.respondAt
      : WAITING_FOR_REPLY.includes(row.status) ? due.expireAt : null
    if (at === null) return
    const delay = at - Date.now()
    if (delay <= 0) {
      row.timedOut = true
      return
    }
    timers.set(id, setTimeout(() => {
      timers.delete(id)
      void expire(id)
    }, delay))
  }

  /** A deadline passed: re-read the row, and time it out only if the server still has it waiting. */
  async function expire(id: string) {
    try {
      await resync([id])
    } catch (error) {
      debug.warn('Interaction re-read failed:', error)
    }
    const row = rows.value[id]
    const due = deadlines.get(id)
    if (!row || !due || row.timedOut) return
    const at = WAITING_FOR_ACK.includes(row.status)
      ? due.respondAt
      : WAITING_FOR_REPLY.includes(row.status) ? due.expireAt : null
    if (at !== null && at <= Date.now()) row.timedOut = true
  }

  /** A public reply the server holds but the list never received: fetch the channel's newer rows. */
  function catchUpReply(row: BotInteractionEntry) {
    if (row.ephemeral || !row.responseMessageId || row.threadId || answeredIds.has(row.id)) return
    answeredIds.add(row.id)
    const chat = useChatStore()
    if (chat.currentChannelId !== row.channelId) return
    void chat.revalidateRecentMessages(row.channelId)
  }

  function setDeadlines(id: string, respondInMs: number | undefined, expiresInMs: number | undefined) {
    const now = Date.now()
    const previous = deadlines.get(id)
    const expireAt = typeof expiresInMs === 'number' ? now + Math.max(0, expiresInMs) : previous?.expireAt
    const respondAt = typeof respondInMs === 'number'
      ? now + Math.max(0, respondInMs)
      : previous?.respondAt
        ?? (typeof expiresInMs === 'number' ? now + Math.max(0, expiresInMs - (EXPIRES_WINDOW_MS - RESPOND_WINDOW_MS)) : undefined)
    if (expireAt === undefined || respondAt === undefined) return
    deadlines.set(id, { respondAt, expireAt })
  }

  function remove(id: string) {
    clearTimer(id)
    deadlines.delete(id)
    const next = { ...rows.value }
    delete next[id]
    rows.value = next
  }

  /** Public reply with nothing private beside it: the message in the list is the answer. */
  function settle(id: string) {
    const row = rows.value[id]
    if (!row) return
    if (row.replies.length > 0) return
    if (interactionPhase(row) === 'done' || answeredIds.has(id)) remove(id)
  }

  function lookupBot(botId: string) {
    const known = bots.get(botId)
    if (known) {
      for (const row of Object.values(rows.value)) if (row.botId === botId && !row.bot) row.bot = known
      return
    }
    if (botLookups.has(botId)) return
    botLookups.set(botId, (async () => {
      try {
        const { data } = await supabase.from('bots').select('id, username, display_name, avatar_url').eq('id', botId).maybeSingle()
        // bots rows read only for public bots and their owners; get_bot_profile also serves members.
        const profile = data ? null : await fetchBotProfile(botId)
        const found: BotCommandBot | null = data
          ? data as BotCommandBot
          : profile
            ? { id: profile.id, username: profile.username, display_name: profile.displayName, avatar_url: profile.avatarUrl || null }
            : null
        if (found) {
          bots.set(botId, found)
          for (const row of Object.values(rows.value)) if (row.botId === botId && !row.bot) row.bot = found
        }
      } catch (error) {
        debug.warn('Bot lookup failed:', error)
      } finally {
        botLookups.delete(botId)
      }
    })())
  }

  function mergeReply(row: BotInteractionEntry, reply: BotInteractionReply) {
    const index = row.replies.findIndex((r) => r.id === reply.id)
    if (index === -1) row.replies = [...row.replies, reply]
    else row.replies = row.replies.map((r, i) => (i === index ? reply : r))
  }

  function applyStatus(row: BotInteractionEntry, status: BotInteractionStatus | undefined) {
    if (!status || status === row.status) return
    row.status = status
    row.timedOut = false
  }

  function applyPush(payload: BotInteractionPush) {
    const id = payload.id
    if (!id) return
    let row = rows.value[id]
    if (!row) {
      if (!payload.channel_id || !payload.bot_id || !payload.status) return
      row = {
        id,
        botId: payload.bot_id,
        bot: bots.get(payload.bot_id) ?? null,
        channelId: payload.channel_id,
        threadId: payload.thread_id ?? null,
        commandName: payload.command_name ?? '',
        status: payload.status,
        error: null,
        ephemeral: false,
        responseMessageId: null,
        replies: [],
        timedOut: false,
        seq: ++seq,
      }
      rows.value = { ...rows.value, [id]: row }
      row = rows.value[id]
      if (!row.bot) lookupBot(row.botId)
    }
    applyStatus(row, payload.status)
    if (payload.error !== undefined) row.error = payload.error
    if (typeof payload.ephemeral === 'boolean') row.ephemeral = payload.ephemeral
    if (payload.response_message_id !== undefined) row.responseMessageId = payload.response_message_id
    if (payload.reply) mergeReply(row, payload.reply)
    setDeadlines(id, undefined, payload.expires_in_ms)
    schedule(id)
    // A push lost while away leaves the reply list short.
    if (typeof payload.reply_count === 'number' && payload.reply_count > row.replies.length) void resync([id])
    settle(id)
  }

  function applyRow(remote: BotInteractionRow) {
    const row = rows.value[remote.id]
    if (!row) return
    applyStatus(row, remote.status)
    row.error = remote.error
    row.ephemeral = remote.ephemeral === true
    row.responseMessageId = remote.response_message_id
    row.replies = Array.isArray(remote.replies) ? remote.replies : []
    if (!row.commandName) row.commandName = remote.command_name
    setDeadlines(remote.id, remote.respond_in_ms, remote.expires_in_ms)
    schedule(remote.id)
    if (row.status === 'responded') catchUpReply(row)
    settle(remote.id)
  }

  /** Registers the push handlers. Repeatable: a sign-out clears the channel's handlers. */
  function listen() {
    for (const off of offs) off()
    offs = [
      userEventChannel.on('bot_interaction:update', (payload) => applyPush(payload as BotInteractionPush)),
      userEventChannel.on('_reconnected', () => { void resync() }),
    ]
  }

  /** Adds the row of an accepted invoke. */
  function addInvoked(params: {
    result: BotInvokeResult
    bot: BotCommandBot
    channelId: string
    threadId: string | null
    commandName: string
  }) {
    listen()
    const { result, bot } = params
    bots.set(bot.id, bot)
    const existing = rows.value[result.id]
    if (existing) {
      existing.bot = bot
      if (!existing.commandName) existing.commandName = params.commandName
    } else {
      rows.value = {
        ...rows.value,
        [result.id]: {
          id: result.id,
          botId: bot.id,
          bot,
          channelId: params.channelId,
          threadId: params.threadId,
          commandName: params.commandName,
          status: 'pending',
          error: null,
          ephemeral: false,
          responseMessageId: null,
          replies: [],
          timedOut: false,
          seq: ++seq,
        },
      }
    }
    setDeadlines(result.id, result.respond_in_ms, result.expires_in_ms)
    schedule(result.id)
    settle(result.id)
  }

  /** A line with no server row: an invoke the server refused because the bot is offline. */
  function addLocalFailure(params: {
    bot: BotCommandBot
    channelId: string
    threadId: string | null
    commandName: string
    error: string
  }) {
    const id = `local:${++seq}`
    bots.set(params.bot.id, params.bot)
    rows.value = {
      ...rows.value,
      [id]: {
        id,
        botId: params.bot.id,
        bot: params.bot,
        channelId: params.channelId,
        threadId: params.threadId,
        commandName: params.commandName,
        status: 'failed',
        error: params.error,
        ephemeral: false,
        responseMessageId: null,
        replies: [],
        timedOut: false,
        seq,
      },
    }
  }

  /** A message carrying metadata.interaction: a public original reply answers its row. */
  function noteMessage(message: Pick<Message, 'metadata'>) {
    const interaction = message.metadata?.interaction
    if (!interaction?.id || interaction.followup) return
    answeredIds.add(interaction.id)
    if (answeredIds.size > ANSWERED_IDS_KEPT) answeredIds.delete(answeredIds.values().next().value as string)
    const row = rows.value[interaction.id]
    if (!row) return
    row.timedOut = false
    clearTimer(row.id)
    settle(row.id)
  }

  /**
   * Re-reads rows from the server: all of them, the given ids, or those of one channel or thread.
   * Rows the server no longer returns (purged 24 h after expiry) are dropped.
   */
  async function resync(scope?: string[] | { channelId: string; threadId: string | null }) {
    const ids = Object.values(rows.value)
      .filter((row) => UUID_RE.test(row.id))
      .filter((row) => {
        if (!scope) return true
        if (Array.isArray(scope)) return scope.includes(row.id)
        return row.channelId === scope.channelId && row.threadId === scope.threadId
      })
      .map((row) => row.id)
    if (ids.length === 0) return
    const remote = await getMyBotInteractions(ids)
    if (!remote) return
    const returned = new Set(remote.map((row) => row.id))
    for (const row of remote) applyRow(row)
    for (const id of ids) if (!returned.has(id)) remove(id)
  }

  function rowsFor(channelId: string | null | undefined, threadId: string | null | undefined): BotInteractionEntry[] {
    if (!channelId) return []
    const thread = threadId ?? null
    return Object.values(rows.value)
      .filter((row) => row.channelId === channelId && row.threadId === thread)
      .sort((a, b) => a.seq - b.seq)
  }

  function dismiss(id: string) {
    remove(id)
  }

  /** Sign-out: rows, timers and handlers belong to the account that made them. */
  function reset() {
    for (const off of offs) off()
    offs = []
    for (const id of timers.keys()) clearTimer(id)
    deadlines.clear()
    answeredIds.clear()
    bots.clear()
    rows.value = {}
  }

  listen()

  return {
    rows,
    rowsFor,
    addInvoked,
    addLocalFailure,
    noteMessage,
    resync,
    dismiss,
    listen,
    reset,
  }
})
