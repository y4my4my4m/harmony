/**
 * A member's own relay preference per bridge platform in one server:
 * bridge_member_privacy(p_server_id) and set_bridge_member_optout(p_server_id, p_platform, p_opted_out),
 * both answering `{ discord: { bridged, opted_out }, matrix: { bridged, opted_out } }`.
 */
import { supabase } from '@/supabase'
import type { BridgePlatform } from '@/types'

export type { BridgePlatform }

export const BRIDGE_PLATFORMS: readonly BridgePlatform[] = ['discord', 'matrix']

export interface BridgePlatformPrivacy {
  /** The server has an active bridge of this platform. */
  bridged: boolean
  opted_out: boolean
}

export type BridgeMemberPrivacy = Record<BridgePlatform, BridgePlatformPrivacy>

export class InvalidBridgePrivacyResponse extends Error {
  constructor() {
    super('Invalid bridge privacy response')
  }
}

function platformPrivacy(value: unknown): BridgePlatformPrivacy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { bridged, opted_out } = value as Record<string, unknown>
  return typeof bridged === 'boolean' && typeof opted_out === 'boolean' ? { bridged, opted_out } : null
}

/** Both platforms with boolean bridged and opted_out, or null. Other platform keys are ignored. */
export function parseBridgeMemberPrivacy(data: unknown): BridgeMemberPrivacy | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const record = data as Record<string, unknown>
  const discord = platformPrivacy(record.discord)
  const matrix = platformPrivacy(record.matrix)
  return discord && matrix ? { discord, matrix } : null
}

export function bridgedPlatforms(privacy: BridgeMemberPrivacy): BridgePlatform[] {
  return BRIDGE_PLATFORMS.filter(platform => privacy[platform].bridged)
}

function settle(result: { data: unknown; error: unknown } | null | undefined): BridgeMemberPrivacy {
  if (!result || result.error) throw result?.error ?? new InvalidBridgePrivacyResponse()
  const privacy = parseBridgeMemberPrivacy(result.data)
  if (!privacy) throw new InvalidBridgePrivacyResponse()
  return privacy
}

export async function fetchBridgeMemberPrivacy(serverId: string): Promise<BridgeMemberPrivacy> {
  return settle(await supabase.rpc('bridge_member_privacy', { p_server_id: serverId }))
}

export async function setBridgeMemberOptout(serverId: string, platform: BridgePlatform, optedOut: boolean): Promise<BridgeMemberPrivacy> {
  return settle(await supabase.rpc('set_bridge_member_optout', {
    p_server_id: serverId,
    p_platform: platform,
    p_opted_out: optedOut,
  }))
}
