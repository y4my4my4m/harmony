/**
 * Newcomer alerts (20261006100001_newcomer_message_alerts.sql): a member's first message in a
 * server notifies its owner and moderators. The switch is per server, with an instance default.
 */
import { supabase } from '@/supabase'

/** instance_config key holding the default for servers that have not chosen. */
export const NEWCOMER_ALERTS_DEFAULT_KEY = 'newcomer_alerts_default'

export interface NewcomerAlertState {
  /** Effective switch. */
  enabled: boolean
  /** The server's own choice; null follows instance_default. */
  server_value: boolean | null
  instance_default: boolean
}

function unwrap(result: { data: unknown; error: unknown }): NewcomerAlertState {
  if (result.error) throw result.error
  return result.data as NewcomerAlertState
}

/** Requires MANAGE_SERVER on a local server. */
export async function getServerNewcomerAlerts(serverId: string): Promise<NewcomerAlertState> {
  return unwrap(await supabase.rpc('get_server_newcomer_alerts', { p_server_id: serverId }))
}

/** Requires MANAGE_SERVER on a local server. null returns the server to the instance default. */
export async function setServerNewcomerAlerts(
  serverId: string,
  enabled: boolean | null,
): Promise<NewcomerAlertState> {
  return unwrap(await supabase.rpc('set_server_newcomer_alerts', {
    p_server_id: serverId,
    p_enabled: enabled,
  }))
}

/** instance_config values are stored both as JSON booleans and as strings; absent reads as on. */
export function parseNewcomerAlertsDefault(value: unknown): boolean {
  return !(value === false || value === 'false')
}

/** Readable by instance admins only (instance_config RLS). */
export async function getInstanceNewcomerAlertsDefault(): Promise<boolean> {
  const { data, error } = await supabase
    .from('instance_config')
    .select('config_value')
    .eq('config_key', NEWCOMER_ALERTS_DEFAULT_KEY)
    .maybeSingle()
  if (error) throw error
  return parseNewcomerAlertsDefault(data?.config_value)
}

/** set_instance_config requires an instance admin. */
export async function setInstanceNewcomerAlertsDefault(enabled: boolean): Promise<void> {
  const { data, error } = await supabase.rpc('set_instance_config', {
    p_key: NEWCOMER_ALERTS_DEFAULT_KEY,
    p_value: enabled,
    p_description: 'Newcomer alerts for servers whose server_settings.newcomer_alerts is NULL',
  })
  if (error) throw error
  if (data === false) throw new Error('set_instance_config refused the newcomer alert default')
}
