/**
 * Metadata a bridge bot records on a message it did not write (bridge 2.2): the Discord message ids
 * of its copy, whether a webhook posted it, and the files uploaded with it. bridge_source is
 * accepted only as 'harmony', which marks the message as Harmony-origin; the bridge reads the
 * persisted ids back only when it is set.
 */
const BRIDGE_MAPPING_KEYS = new Set([
  'discord_message_id', 'discord_message_ids', 'discord_via_webhook', 'discord_uploaded_files',
])

export function isBridgeMappingEntry([key, value]: [string, unknown]): boolean {
  return BRIDGE_MAPPING_KEYS.has(key) || (key === 'bridge_source' && value === 'harmony')
}

/** The mapping alone of a message's metadata; null for metadata that is no object. */
export function bridgeMappingOf(metadata: unknown): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  return Object.fromEntries(Object.entries(metadata).filter(isBridgeMappingEntry))
}
