import { supabase } from '../config/supabase.js'

/**
 * Outgoing webhooks (migration 20261028600001). The routes of active webhooks, read every
 * REFRESH_MS, decide whether an event the dispatcher sends is also handed to
 * enqueue_outgoing_webhook_event, which writes one delivery per webhook taking it and queues
 * it for the federation backend's worker. Without a route nothing is written: most events
 * cost no query.
 *
 * A bot's webhook takes an event its bot reads (EventDispatcher.resolveReaders), connected
 * or not. A server's webhook takes an event of its server; the database checks that the
 * webhook's creator reads the channel.
 */
export const OUTGOING_WEBHOOK_REFRESH_MS = 10_000

export class OutgoingWebhookRoutes {
  private serverEvents = new Map<string, Set<string>>()
  private botEvents = new Map<string, Set<string>>()

  /** Re-reads the routes; a failed read keeps the last ones. */
  async refresh(): Promise<void> {
    const { data, error } = await supabase.rpc('outgoing_webhook_routes')
    if (error || !Array.isArray(data)) {
      if (error) console.warn('outgoing_webhook_routes: keeping the last routes:', error.message)
      return
    }
    const servers = new Map<string, Set<string>>()
    const bots = new Map<string, Set<string>>()
    for (const row of data as Array<{ bot_id: string | null; server_id: string | null; events: string[] | null }>) {
      const target = row.bot_id ? bots : row.server_id ? servers : null
      const key = row.bot_id ?? row.server_id
      if (!target || !key) continue
      const events = target.get(key) ?? new Set<string>()
      for (const event of row.events ?? []) events.add(event)
      target.set(key, events)
    }
    this.serverEvents = servers
    this.botEvents = bots
  }

  /** The bots among `botIds` with a webhook taking `event`. */
  botsTaking(event: string, botIds: readonly string[]): string[] {
    return botIds.filter((id) => this.botEvents.get(id)?.has(event))
  }

  /** Some webhook takes the event: the server's, or one of a reading bot. */
  wants(event: string, serverId: string, botIds: readonly string[]): boolean {
    return this.serverEvents.get(serverId)?.has(event) === true || this.botsTaking(event, botIds).length > 0
  }

  /**
   * Queues the event for the webhooks taking it. `payload` is the event's gateway `d`, with
   * server_id added. Errors are logged: a webhook never holds up a gateway event.
   */
  async enqueue(event: string, serverId: string, channelId: string | null, botIds: readonly string[], payload: Record<string, unknown>): Promise<void> {
    if (!this.wants(event, serverId, botIds)) return
    const { error } = await supabase.rpc('enqueue_outgoing_webhook_event', {
      p_event: event,
      p_server_id: serverId,
      p_channel_id: channelId,
      p_bot_ids: this.botsTaking(event, botIds),
      p_payload: { ...payload, server_id: serverId },
    })
    if (error) console.error(`enqueue_outgoing_webhook_event ${event}: ${error.message}`)
  }
}
