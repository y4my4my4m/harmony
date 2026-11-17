import { parseBridgeLinkReturn } from '@/utils/discordBridgeSetup'

export const BRIDGES_SECTION = 'bridges'
export const BRIDGE_TABS = ['discord', 'matrix'] as const
export type BridgeTab = (typeof BRIDGE_TABS)[number]

/**
 * Section ids of the separate bridge sections before Bridges. Released bot gateways return
 * the Discord OAuth2 flow to `?section=discord-bridge`.
 */
const SECTION_ALIASES: Record<string, BridgeTab> = {
  'discord-bridge': 'discord',
  'matrix-bridge': 'matrix',
}

function isBridgeTab(value: unknown): value is BridgeTab {
  return typeof value === 'string' && (BRIDGE_TABS as readonly string[]).includes(value)
}

/**
 * The settings section and Bridges tab a URL asks for. An OAuth2 return (`linked`, `link_error`)
 * opens the Discord tab whatever `tab` says.
 */
export function requestedSettingsSection(query: Record<string, unknown>): { section: string | null; bridgeTab: BridgeTab } {
  const raw = typeof query.section === 'string' ? query.section : null
  const alias = raw ? SECTION_ALIASES[raw] : undefined
  const section = alias ? BRIDGES_SECTION : raw
  let bridgeTab: BridgeTab = alias ?? 'discord'
  if (!alias && section === BRIDGES_SECTION && isBridgeTab(query.tab)) bridgeTab = query.tab
  if (parseBridgeLinkReturn(query)) bridgeTab = 'discord'
  return { section, bridgeTab }
}
