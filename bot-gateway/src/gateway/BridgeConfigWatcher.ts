import { supabase, config } from '../config/supabase.js'
import type { WebSocketGateway } from './WebSocketGateway.js'
import { BRIDGE_COLUMNS, type BridgeRow, buildBridgeConfig, configuredBaseUrl } from '../bridge/bridgeConfig.js'
import { MATRIX_BRIDGE_COLUMNS, type MatrixBridgeRow, buildMatrixBridgeConfig } from '../bridge/matrixBridgeConfig.js'
import { upstream } from '../utils/upstreamBackoff.js'

// Bot ids per lookup; 36 characters each in the query string.
const LOOKUP_CHUNK = 100

interface ConfigSource<T extends { bot_id: string | null; updated_at: string }> {
  table: string
  columns: string
  build: (row: T) => Promise<object | null>
}

const DISCORD: ConfigSource<BridgeRow> = {
  table: 'discord_bridges',
  columns: BRIDGE_COLUMNS,
  build: (row) => buildBridgeConfig(row, configuredBaseUrl()),
}

const MATRIX: ConfigSource<MatrixBridgeRow> = {
  table: 'matrix_bridges',
  columns: MATRIX_BRIDGE_COLUMNS,
  build: (row) => buildMatrixBridgeConfig(row.bot_id!, configuredBaseUrl()),
}

/**
 * Sends BRIDGE_CONFIG_UPDATE (op 0, d: the GET /bridge/v2/config or GET /bridge/v2/matrix/config
 * body) to a connected bridge bot when updated_at of its discord_bridges or matrix_bridges row
 * changes. base_url is null when no instance URL is configured: there is no request origin to fall
 * back to. updated_at moves on configuration changes only: mode, bot, guild, settings, pairs and
 * opt-outs (20261008300001_discord_bridges.sql, 20261126100001_matrix_bridges.sql); heartbeats do
 * not move it.
 *
 * Polled, as EventDispatcher polls messages: one indexed lookup per table and interval over the
 * connected bots, no Realtime publication. Tracked per gateway session, so a session's first poll
 * sends the current configuration; that covers a change between IDENTIFY and the bridge's first
 * GET of its configuration. A failed lookup or build sends nothing and is retried on the next poll.
 */
export class BridgeConfigWatcher {
  // gateway session id -> updated_at last sent to it.
  private sent = new Map<string, string>()
  private timer: NodeJS.Timeout | null = null
  private polling = false

  constructor(
    private gateway: WebSocketGateway,
    private intervalMs: number = config.bridge?.configPollMs ?? 5_000,
  ) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.poll().catch((err) => console.error('Bridge config poll failed:', err))
    }, this.intervalMs)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.sent.clear()
  }

  async poll(): Promise<void> {
    if (this.polling || !upstream.ready()) return
    this.polling = true
    try {
      const sessionsByBot = new Map<string, string[]>()
      for (const conn of this.gateway.getConnectedBots()) {
        const list = sessionsByBot.get(conn.botId) ?? []
        list.push(conn.sessionId)
        sessionsByBot.set(conn.botId, list)
      }
      const live = new Set(Array.from(sessionsByBot.values()).flat())
      for (const sessionId of this.sent.keys()) {
        if (!live.has(sessionId)) this.sent.delete(sessionId)
      }
      const botIds = Array.from(sessionsByBot.keys())
      if (botIds.length === 0) return

      await this.pollSource(DISCORD, botIds, sessionsByBot)
      await this.pollSource(MATRIX, botIds, sessionsByBot)
    } finally {
      this.polling = false
    }
  }

  private async pollSource<T extends { bot_id: string | null; updated_at: string }>(
    source: ConfigSource<T>,
    botIds: string[],
    sessionsByBot: Map<string, string[]>,
  ): Promise<void> {
    const bridges: T[] = []
    for (let i = 0; i < botIds.length; i += LOOKUP_CHUNK) {
      const { data, error } = await supabase
        .from(source.table)
        .select(source.columns)
        .in('bot_id', botIds.slice(i, i + LOOKUP_CHUNK))
      if (error || !Array.isArray(data)) {
        console.error(`Bridge config poll: ${source.table} lookup failed:`, error?.message)
        return
      }
      bridges.push(...(data as unknown as T[]))
    }

    for (const bridge of bridges) {
      const sessions = bridge.bot_id ? sessionsByBot.get(bridge.bot_id) : undefined
      if (!sessions || sessions.every((s) => this.sent.get(s) === bridge.updated_at)) continue
      const built = await source.build(bridge)
      if (!built) continue
      this.gateway.sendToBot(bridge.bot_id!, { op: 0, t: 'BRIDGE_CONFIG_UPDATE', d: built })
      for (const s of sessions) this.sent.set(s, bridge.updated_at)
    }
  }
}
