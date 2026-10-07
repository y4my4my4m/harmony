import { BridgeUnavailableError } from './bridgeApi'

/**
 * i18n key under discordBridge.errors for a failed bridge request. The RPC messages are
 * matched loosely: the contract fixes the conditions (permission, hosting off, hosting
 * full, guild absent from the snapshot), not their wording.
 */
export function bridgeErrorKey(error: unknown, fallback: string): string {
  if (error instanceof BridgeUnavailableError) return 'discordBridge.errors.unavailable'
  const code = (error as { code?: string } | null)?.code ?? ''
  const message = error instanceof Error ? error.message : String(error ?? '')
  // discord_bridge_instance_link raises these as bare codes.
  if (message === 'bridge_exists') return 'discordBridge.errors.bridgeExists'
  if (message === 'limit_reached') return 'discordBridge.errors.instanceFull'
  if (message === 'instance_bot_unavailable') return 'discordBridge.errors.instanceOff'
  if (code === '42501' || /permission|manage_server|not allowed|forbidden|unauthori[sz]ed/i.test(message)) {
    return 'discordBridge.errors.permission'
  }
  if (/hosting/i.test(message) && /limit|full|maximum|capacity/i.test(message)) return 'discordBridge.errors.hostingFull'
  if (/hosting/i.test(message)) return 'discordBridge.errors.hostingOff'
  if (/already exists|duplicate|unique/i.test(message)) return 'discordBridge.errors.alreadyExists'
  return fallback
}

export function errorDetail(error: unknown): string {
  if (error instanceof BridgeUnavailableError) return ''
  const message = error instanceof Error ? error.message : ''
  // A bare code (bridge_exists, limit_reached) is already said by the translated message.
  return /^[a-z_]+$/.test(message) ? '' : message
}
