// Bot slash commands: list per channel or thread, invoke, and the invoker's interaction rows.
// RPCs of migration 20261110400001_bot_slash_commands.sql; every call is gated by the
// 'bot-commands' capability, and an instance without it gets no call.

import { supabase } from '@/supabase'
import { hasCapability } from '@/services/instanceCapabilities'
import { SERVER_BOT_CHANGE_EVENT } from '@/services/serverBotsService'
import { debug } from '@/utils/debug'
import type { MessagePart } from '@/types'

/** Discord application command option types; 9 MENTIONABLE and 11 ATTACHMENT are refused by the gateway. */
export const BotOptionType = {
  SUB_COMMAND: 1,
  SUB_COMMAND_GROUP: 2,
  STRING: 3,
  INTEGER: 4,
  BOOLEAN: 5,
  USER: 6,
  CHANNEL: 7,
  ROLE: 8,
  NUMBER: 10,
} as const
export type BotOptionTypeValue = (typeof BotOptionType)[keyof typeof BotOptionType]

export interface BotCommandChoice {
  name: string
  value: string | number
}

export interface BotCommandOption {
  type: BotOptionTypeValue
  name: string
  description?: string | null
  required?: boolean
  choices?: BotCommandChoice[] | null
  min_value?: number | null
  max_value?: number | null
  min_length?: number | null
  max_length?: number | null
  options?: BotCommandOption[] | null
}

export interface BotCommandBot {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
}

/** One element of get_channel_bot_commands. */
export interface ChannelBotCommand {
  id: string
  name: string
  description: string | null
  options: BotCommandOption[] | null
  bot: BotCommandBot
}

/** A command or one of its subcommands, as the `/` list offers it. */
export interface FlatBotCommand {
  command: ChannelBotCommand
  /** p_path of invoke_bot_command: [], [sub] or [group, sub]. */
  path: string[]
  /** "weather", "bridge clone-server". */
  fullName: string
  description: string
  /** Options of the leaf: value options only. */
  options: BotCommandOption[]
}

/** Values of invoke_bot_command p_options: uuid strings for USER, CHANNEL and ROLE. */
export type BotCommandValues = Record<string, string | number | boolean>

export interface BotInvokeResult {
  id: string
  respond_in_ms: number
  expires_in_ms: number
}

export type BotInteractionStatus =
  | 'pending' | 'delivered' | 'deferred' | 'responding' | 'responded' | 'failed' | 'expired'

/** An element of bot_interactions.replies: a private reply or follow-up. */
export interface BotInteractionReply {
  id: string
  content: MessagePart[]
  created_at: string
  edited_at: string | null
}

/** One element of get_my_bot_interactions. */
export interface BotInteractionRow {
  id: string
  bot_id: string
  channel_id: string
  thread_id: string | null
  command_name: string
  status: BotInteractionStatus
  error: string | null
  ephemeral: boolean | null
  response_message_id: string | null
  replies: BotInteractionReply[] | null
  respond_in_ms: number
  expires_in_ms: number
}

export type BotCommandErrorCode =
  | 'unavailable'
  | 'forbidden'
  | 'timed_out'
  | 'thread_locked'
  | 'slowmode'
  | 'rate_limited'
  | 'invalid_option'
  | 'bot_offline'
  | 'failed'

const ERROR_CODES: Record<string, BotCommandErrorCode> = {
  BOT_COMMAND_UNAVAILABLE: 'unavailable',
  BOT_COMMAND_FORBIDDEN: 'forbidden',
  BOT_COMMAND_TIMED_OUT: 'timed_out',
  BOT_COMMAND_THREAD_LOCKED: 'thread_locked',
  BOT_COMMAND_SLOWMODE: 'slowmode',
  BOT_COMMAND_RATE_LIMITED: 'rate_limited',
  BOT_COMMAND_INVALID_OPTION: 'invalid_option',
  BOT_COMMAND_BOT_OFFLINE: 'bot_offline',
}

/** A refusal of invoke_bot_command. `seconds` for slowmode and rate_limited, `option` for invalid_option. */
export class BotCommandError extends Error {
  readonly code: BotCommandErrorCode
  readonly seconds: number | null
  readonly option: string | null

  constructor(code: BotCommandErrorCode, message: string, detail: string | null = null) {
    super(message)
    this.name = 'BotCommandError'
    this.code = code
    const seconds = detail !== null && /^\d+$/.test(detail) ? Number(detail) : null
    this.seconds = code === 'slowmode' || code === 'rate_limited' ? seconds : null
    this.option = code === 'invalid_option' && detail ? detail : null
  }
}

/** P0001 message `BOT_COMMAND_<CODE>` or `BOT_COMMAND_<CODE>:<detail>`; anything else is 'failed'. */
export function toBotCommandError(error: unknown): BotCommandError {
  if (error instanceof BotCommandError) return error
  const message = String((error as { message?: unknown } | null)?.message ?? error ?? '')
  const match = /\b(BOT_COMMAND_[A-Z_]+?)(?::([^\s]+))?(?:\s|$)/.exec(message)
  const code = match ? ERROR_CODES[match[1]] : undefined
  if (!code) return new BotCommandError('failed', message)
  return new BotCommandError(code, message, match![2] ?? null)
}

/** Commands and subcommands as the `/` list offers them: group → subcommand → values, no deeper. */
export function flattenBotCommands(commands: readonly ChannelBotCommand[]): FlatBotCommand[] {
  const flat: FlatBotCommand[] = []
  for (const command of commands) {
    const options = command.options ?? []
    const nested = options.filter(
      (o) => o.type === BotOptionType.SUB_COMMAND || o.type === BotOptionType.SUB_COMMAND_GROUP,
    )
    if (nested.length === 0) {
      flat.push({
        command,
        path: [],
        fullName: command.name,
        description: command.description ?? '',
        options,
      })
      continue
    }
    for (const option of nested) {
      if (option.type === BotOptionType.SUB_COMMAND) {
        flat.push({
          command,
          path: [option.name],
          fullName: `${command.name} ${option.name}`,
          description: option.description || command.description || '',
          options: option.options ?? [],
        })
        continue
      }
      for (const sub of option.options ?? []) {
        if (sub.type !== BotOptionType.SUB_COMMAND) continue
        flat.push({
          command,
          path: [option.name, sub.name],
          fullName: `${command.name} ${option.name} ${sub.name}`,
          description: sub.description || option.description || command.description || '',
          options: sub.options ?? [],
        })
      }
    }
  }
  return flat
}

const CACHE_TTL_MS = 60_000

const cache = new Map<string, { at: number; commands: ChannelBotCommand[] }>()
const inFlight = new Map<string, Promise<ChannelBotCommand[]>>()
let cacheGeneration = 0

const cacheKey = (channelId: string, threadId: string | null | undefined) => `${channelId}:${threadId ?? ''}`

/** Drops every cached list: install, removal, presence and command changes arrive as one event. */
export function clearBotCommandCache(): void {
  cacheGeneration++
  cache.clear()
  inFlight.clear()
}

if (typeof window !== 'undefined') {
  window.addEventListener(SERVER_BOT_CHANGE_EVENT, clearBotCommandCache)
}

/**
 * Commands the caller may use in a channel or thread, cached 60 s per (channel, thread).
 * Empty without the capability, and when a member check fails.
 */
export async function getChannelBotCommands(
  channelId: string,
  threadId: string | null = null,
): Promise<ChannelBotCommand[]> {
  if (!hasCapability('bot-commands') || !channelId) return []
  const key = cacheKey(channelId, threadId)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.commands
  const pending = inFlight.get(key)
  if (pending) return pending

  // A cache clear while the read runs drops its answer: it may predate the change.
  const generation = cacheGeneration
  const request = (async () => {
    try {
      const { data, error } = await supabase.rpc('get_channel_bot_commands', {
        p_channel_id: channelId,
        p_thread_id: threadId,
      })
      if (error) throw error
      const commands = Array.isArray(data) ? (data as ChannelBotCommand[]) : []
      if (generation === cacheGeneration) cache.set(key, { at: Date.now(), commands })
      return commands
    } catch (error) {
      debug.warn('get_channel_bot_commands failed:', error)
      return []
    } finally {
      if (generation === cacheGeneration) inFlight.delete(key)
    }
  })()
  inFlight.set(key, request)
  return request
}

/** Throws BotCommandError on a refusal. */
export async function invokeBotCommand(params: {
  channelId: string
  threadId: string | null
  commandId: string
  path: string[]
  options: BotCommandValues
}): Promise<BotInvokeResult> {
  if (!hasCapability('bot-commands')) throw new BotCommandError('unavailable', 'bot-commands capability absent')
  const { data, error } = await supabase.rpc('invoke_bot_command', {
    p_channel_id: params.channelId,
    p_thread_id: params.threadId,
    p_command_id: params.commandId,
    p_path: params.path,
    p_options: params.options,
  })
  if (error) throw toBotCommandError(error)
  const result = data as BotInvokeResult | null
  if (!result?.id) throw new BotCommandError('failed', 'invoke_bot_command returned no id')
  return result
}

/** The caller's rows among `ids`, at most 50 per call. Null when the read failed. */
export async function getMyBotInteractions(ids: readonly string[]): Promise<BotInteractionRow[] | null> {
  if (!hasCapability('bot-commands') || ids.length === 0) return []
  const rows: BotInteractionRow[] = []
  for (let i = 0; i < ids.length; i += 50) {
    const { data, error } = await supabase.rpc('get_my_bot_interactions', { p_ids: ids.slice(i, i + 50) })
    if (error) {
      debug.warn('get_my_bot_interactions failed:', error)
      return null
    }
    if (Array.isArray(data)) rows.push(...(data as BotInteractionRow[]))
  }
  return rows
}
