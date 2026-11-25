/** RPCs behind Instance admin → Config → General → Matrix bridge; each needs an instance admin. */
import { supabase } from '@/supabase'
import { raise } from '@/components/settings/discord-bridge/bridgeApi'
import type { MatrixConnection } from '@/utils/matrixBridgeSetup'

/** matrix_bridge_instance_limit's default. */
export const DEFAULT_MATRIX_INSTANCE_LIMIT = 100

/** matrix_bridge_instance_status(): never carries a secret. */
export interface MatrixInstanceStatus {
  enabled: boolean
  configured: boolean
  connection: MatrixConnection | null
  homeserverUrl: string
  serverName: string
  senderLocalpart: string
  appserviceUrl: string
  hasAccessToken: boolean
  /** The AS and HS tokens of the registration file. */
  hasServiceTokens: boolean
  linkedCount: number
  limit: number
  hostedCount: number
}

export interface MatrixInstanceInput {
  connection: MatrixConnection
  homeserverUrl: string
  accessToken: string
  serverName: string
  senderLocalpart: string
  appserviceUrl: string
}

function statusOf(raw: unknown): MatrixInstanceStatus {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  const count = (value: unknown, fallback: number) => {
    const n = Number(value)
    return value != null && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
  }
  return {
    enabled: row.enabled === true,
    configured: row.configured === true,
    connection: row.connection === 'application_service' || row.connection === 'account' ? row.connection : null,
    homeserverUrl: text(row.homeserver_url),
    serverName: text(row.server_name),
    senderLocalpart: text(row.sender_localpart),
    appserviceUrl: text(row.appservice_url),
    hasAccessToken: row.has_access_token === true,
    hasServiceTokens: row.has_service_tokens === true,
    linkedCount: count(row.linked_count, 0),
    limit: count(row.limit, DEFAULT_MATRIX_INSTANCE_LIMIT),
    hostedCount: count(row.hosted_count, 0),
  }
}

export async function fetchMatrixInstanceStatus(): Promise<MatrixInstanceStatus> {
  const { data, error } = await supabase.rpc('matrix_bridge_instance_status')
  raise(error)
  return statusOf(data)
}

/** Empty values keep the stored ones; the token goes to Vault and never comes back. */
export async function saveMatrixInstance(input: MatrixInstanceInput): Promise<MatrixInstanceStatus> {
  const { data, error } = await supabase.rpc('matrix_bridge_instance_set', {
    p_connection: input.connection,
    p_homeserver_url: input.homeserverUrl || null,
    p_access_token: input.accessToken || null,
    p_server_name: input.serverName || null,
    p_sender_localpart: input.senderLocalpart || null,
    p_appservice_url: input.appserviceUrl || null,
  })
  raise(error)
  return statusOf(data)
}

/** New tokens, and the registration that carries them, once. The earlier ones stop working. */
export async function createMatrixRegistration(): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('matrix_bridge_instance_registration')
  raise(error)
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('matrix_bridge_instance_registration returned no registration')
  return data as Record<string, unknown>
}

/** Deletes the stored tokens and turns the instance's bridge off; communities' bridges stay. */
export async function clearMatrixInstance(): Promise<void> {
  const { error } = await supabase.rpc('matrix_bridge_instance_clear')
  raise(error)
}
