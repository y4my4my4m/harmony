import { supabase } from '../config/supabase.js'

const NOTE_EVERY_MS = 60_000

const noted = new Map<string, number>()

/**
 * Records in bridge_hosts that the platform's bridge host called, at most once a minute. The caller
 * waits for nothing; a failure is logged and the next call records again.
 */
export function noteBridgeHost(platform: 'discord' | 'matrix'): void {
  const now = Date.now()
  if (now - (noted.get(platform) ?? -NOTE_EVERY_MS) < NOTE_EVERY_MS) return
  noted.set(platform, now)
  const failed = (reason: unknown) => {
    if (noted.get(platform) === now) noted.delete(platform)
    console.warn(`bridge_host_report for ${platform} failed:`, reason instanceof Error ? reason.message : reason)
  }
  void (async () => {
    const { error } = await supabase.rpc('bridge_host_report', { p_platform: platform })
    if (error) failed(error.message)
  })().catch(failed)
}

/** For tests: forgets when each host was recorded. */
export function forgetBridgeHosts(): void {
  noted.clear()
}
