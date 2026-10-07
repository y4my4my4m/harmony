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
  return error instanceof Error ? error.message : ''
}
