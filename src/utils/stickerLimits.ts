/**
 * Sticker caps: instance_config max_stickers_per_server, max_instance_stickers and
 * max_personal_stickers_per_user, enforced on every stickers row (20261031200001_custom_stickers.sql,
 * sticker_limit and enforce_sticker_limit).
 */

export type StickerScope = 'server' | 'instance' | 'user'

export const STICKER_CAP_KEYS: Record<StickerScope, string> = {
  server: 'max_stickers_per_server',
  instance: 'max_instance_stickers',
  user: 'max_personal_stickers_per_user',
}

export const DEFAULT_STICKER_CAPS: Record<StickerScope, number> = { server: 15, instance: 50, user: 0 }
export const MAX_STICKER_CAPS: Record<StickerScope, number> = { server: 100, instance: 500, user: 100 }

/** Mirrors sticker_limit(): 0 turns the scope off; above the ceiling reads as it; anything else unusable as the default. */
export function parseStickerCap(scope: StickerScope, value: unknown): number {
  const num = typeof value === 'number' ? value : parseInt(String(value), 10)
  if (num === 0) return 0
  if (!Number.isInteger(num) || num < 1) return DEFAULT_STICKER_CAPS[scope]
  return Math.min(num, MAX_STICKER_CAPS[scope])
}

/** The cap a STICKER_LIMIT refusal (SQLSTATE 23514) names; null for any other error. */
export function stickerLimitOf(error: unknown): number | null {
  const e = error as { code?: string; message?: string } | null
  if (e?.code !== '23514') return null
  const match = /STICKER_LIMIT: at most (\d+)/.exec(e.message ?? '')
  return match ? Number(match[1]) : null
}
