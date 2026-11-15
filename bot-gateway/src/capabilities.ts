/**
 * Features a bot may rely on, sent in READY and in GET /users/@me. A gateway that predates a
 * feature omits its name (and predates this list); its routes answer 404.
 */
export const GATEWAY_CAPABILITIES = [
  'bridge_sound_sync',
  'bridge_emoji_sync',
  'bridge_sticker_sync',
  'bridge_history_import',
  'bridge_privacy',
] as const
