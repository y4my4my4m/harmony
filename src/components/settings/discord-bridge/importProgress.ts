import type { BridgePairRow } from '@/utils/discordBridgeSetup'
import type { ImportJob } from './bridgeApi'

/** Oldest bridge release that serves the history import endpoints. */
export const IMPORT_MIN_BRIDGE_VERSION = '2.6.0'
/** Oldest bridge release that imports through the instance bot and own-bot hosted bridges. */
export const HOSTED_IMPORT_MIN_BRIDGE_VERSION = '2.8.0'

/**
 * Share of the channel's history already imported. The importer walks from start_at back
 * towards channel_created_at, so progress is how far reached_at has moved along that span.
 */
export function importPercent(job: ImportJob): number | null {
  if (job.state === 'done') return 100
  if (!job.start_at || !job.reached_at || !job.channel_created_at) return null
  const start = Date.parse(job.start_at)
  const reached = Date.parse(job.reached_at)
  const created = Date.parse(job.channel_created_at)
  if (![start, reached, created].every(Number.isFinite)) return null
  const span = start - created
  if (span <= 0) return null
  return Math.min(100, Math.max(0, Math.round((100 * (start - reached)) / span)))
}

function parseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/** True when the bridge reports semver >= min (default 2.6.0). */
export function bridgeSupportsImport(version: string | null, min: string = IMPORT_MIN_BRIDGE_VERSION): boolean {
  if (!version) return false
  const have = parseVersion(version)
  const need = parseVersion(min)
  if (!have || !need) return false
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] > need[i]
  }
  return true
}

/**
 * Whether the bridge may import at all, as discord_bridge_import_block decides it: the instance
 * switch (bridge_history_import) self_run admits bridges of mode self, all admits every bridge;
 * then a bridge release that imports in its mode.
 */
export type ImportAvailability = 'ok' | 'bridge_mode' | 'instance_off' | 'needs_update'

export function importAvailability(
  bridge: { mode: string; bridge_version: string | null },
  importMode: string | null | undefined,
): ImportAvailability {
  if (importMode !== 'self_run' && importMode !== 'all') return 'instance_off'
  if (importMode === 'self_run' && bridge.mode !== 'self') return 'bridge_mode'
  const min = bridge.mode === 'self' ? IMPORT_MIN_BRIDGE_VERSION : HOSTED_IMPORT_MIN_BRIDGE_VERSION
  return bridgeSupportsImport(bridge.bridge_version, min) ? 'ok' : 'needs_update'
}

export type ImportBlock = 'direction' | 'encrypted'

/** Why a pair cannot import, or null when it can: it brings Discord messages in and the channel is not encrypted. */
export function importBlock(pair: BridgePairRow, channel: { encrypted?: boolean } | null): ImportBlock | null {
  if (pair.direction !== 'both' && pair.direction !== 'to_harmony') return 'direction'
  if (channel?.encrypted) return 'encrypted'
  return null
}

export function isImportablePair(pair: BridgePairRow, channel: { encrypted?: boolean } | null): boolean {
  return importBlock(pair, channel) === null
}
