import { supabase } from '../config/supabase.js'
import type { WebSocketGateway } from './WebSocketGateway.js'
import { absoluteAvatarUrl } from '../utils/avatarUrl.js'

export const INTERACTION_POLL_MS = 250
export const INTERACTION_CLAIM_LIMIT = 50

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** A user object with avatar_url as an absolute `avatar`, in the same place; omitted when unset. */
function withAvatar(user: unknown): unknown {
  if (!isObject(user)) return user
  const out: Json = {}
  for (const [key, value] of Object.entries(user)) {
    if (key !== 'avatar_url') {
      out[key] = value
      continue
    }
    const avatar = absoluteAvatarUrl(typeof value === 'string' ? value : null)
    if (avatar) out.avatar = avatar
  }
  return out
}

/** INTERACTION_CREATE `d` of a claim_bot_interactions row: bot_id dropped, user avatars absolute. */
export function interactionEvent(row: Json): Json {
  const { bot_id: _botId, ...event } = row
  if ('user' in event) event.user = withAvatar(event.user)
  const data = event.data
  if (isObject(data) && isObject(data.resolved) && isObject(data.resolved.users)) {
    const users = Object.fromEntries(Object.entries(data.resolved.users).map(([id, user]) => [id, withAvatar(user)]))
    event.data = { ...data, resolved: { ...data.resolved, users } }
  }
  return event
}

/**
 * Delivers slash command invocations. Every INTERACTION_POLL_MS while a bot is identified here,
 * claim_bot_interactions marks the pending rows of the connected bots delivered and answers
 * them; each goes to every connection of its bot as INTERACTION_CREATE. A row that reaches no
 * socket fails 'offline' at once. Claims lock with SKIP LOCKED, so several gateway processes
 * share the queue. A tick that finds its previous run unfinished is skipped.
 */
export class InteractionPoller {
  private timer: NodeJS.Timeout | null = null
  private polling = false

  constructor(private gateway: Pick<WebSocketGateway, 'getConnectedBots' | 'sendToBot'>) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.poll().catch((err) => console.error('Interaction poll failed:', err))
    }, INTERACTION_POLL_MS)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async poll(): Promise<void> {
    if (this.polling) return
    const botIds = Array.from(new Set(this.gateway.getConnectedBots().map((conn) => conn.botId)))
    if (botIds.length === 0) return
    this.polling = true
    try {
      const { data, error } = await supabase.rpc('claim_bot_interactions', {
        p_bot_ids: botIds,
        p_limit: INTERACTION_CLAIM_LIMIT,
      })
      if (error) {
        console.error('claim_bot_interactions failed:', error.message)
        return
      }
      // Claimed rows are delivered already; one failing send leaves the rest to go out.
      for (const row of Array.isArray(data) ? data : []) {
        if (!isObject(row)) continue
        try {
          await this.deliver(row)
        } catch (err) {
          console.error(`Interaction ${String(row.id)} delivery failed:`, err)
        }
      }
    } finally {
      this.polling = false
    }
  }

  private async deliver(row: Json) {
    const botId = row.bot_id
    const id = row.id
    if (typeof botId !== 'string' || typeof id !== 'string') {
      console.error('claim_bot_interactions answered a row without bot_id or id:', row)
      return
    }
    const sockets = this.gateway.sendToBot(botId, { op: 0, t: 'INTERACTION_CREATE', d: interactionEvent(row) })
    if (sockets > 0) return
    const { error } = await supabase.rpc('bot_interaction_fail', { p_bot_id: botId, p_id: id, p_error: 'offline' })
    if (error) console.error(`bot_interaction_fail failed for ${id}:`, error.message)
  }
}
