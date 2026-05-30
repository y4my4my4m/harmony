import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

/**
 * Shared client-side validation + error humanization for storage uploads.
 *
 * Storage uploads (avatars, banners, server icons/banners, group icons, emojis)
 * are rejected by Supabase when a file exceeds the bucket's `file_size_limit` or
 * uses a disallowed MIME type, but the raw error ("The object exceeded the
 * maximum allowed size") never made it to the user - they just saw a generic
 * "upload failed". This module:
 *   1. Pre-validates a file against the bucket's limits (so we can fail fast
 *      with a precise, friendly message before hitting the network), and
 *   2. Translates a raw Supabase storage error into a human-readable reason.
 *
 * Per-instance limits can be customized in the Supabase dashboard, so we fetch
 * the live bucket metadata when possible and only fall back to these defaults
 * (which mirror db_schema/init/97_storage_buckets.sql) when it's unavailable.
 */

export interface BucketLimitConfig {
  maxBytes: number
  allowedMime: string[] | null
  label: string
}

const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/apng']

export const BUCKET_LIMITS: Record<string, BucketLimitConfig> = {
  avatars: { maxBytes: 5 * 1024 * 1024, allowedMime: IMAGE_MIME, label: 'profile picture' },
  banners: { maxBytes: 10 * 1024 * 1024, allowedMime: IMAGE_MIME, label: 'profile banner' },
  server_icons: { maxBytes: 5 * 1024 * 1024, allowedMime: IMAGE_MIME, label: 'server icon' },
  server_banners: { maxBytes: 10 * 1024 * 1024, allowedMime: IMAGE_MIME, label: 'server banner' },
  'group-icons': { maxBytes: 5 * 1024 * 1024, allowedMime: IMAGE_MIME, label: 'group icon' },
  // Emoji intentionally excludes SVG: see note below + sanitize concerns.
  emojis: { maxBytes: 1 * 1024 * 1024, allowedMime: ['image/png', 'image/gif', 'image/webp', 'image/apng', 'image/jpeg'], label: 'emoji' },
  user_media: { maxBytes: 50 * 1024 * 1024, allowedMime: null, label: 'file' },
}

const FRIENDLY_MIME: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/gif': 'GIF',
  'image/webp': 'WebP',
  'image/apng': 'APNG',
  'image/svg+xml': 'SVG',
}

// Live limits fetched from the bucket metadata (authoritative for this instance).
const liveLimits = new Map<string, BucketLimitConfig>()
const liveBuckets = new Set<string>()

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb >= 1) {
    const rounded = mb < 10 ? mb.toFixed(1) : String(Math.round(mb))
    return `${rounded.replace(/\.0$/, '')} MB`
  }
  const kb = bytes / 1024
  return `${Math.max(1, Math.round(kb))} KB`
}

function describeMimeList(mimes: string[]): string {
  return mimes.map(m => FRIENDLY_MIME[m] || m.replace('image/', '').toUpperCase()).join(', ')
}

/**
 * Resolve the effective limits for a bucket, preferring the live bucket
 * metadata (which reflects per-instance dashboard overrides) and falling back
 * to the bundled defaults. Result is cached per session.
 */
async function getBucketLimits(bucket: string): Promise<BucketLimitConfig> {
  const fallback = BUCKET_LIMITS[bucket] || { maxBytes: 0, allowedMime: null, label: 'file' }
  if (liveLimits.has(bucket)) return liveLimits.get(bucket)!

  try {
    const { data, error } = await supabase.storage.getBucket(bucket)
    if (!error && data) {
      const resolved: BucketLimitConfig = {
        maxBytes: typeof data.file_size_limit === 'number' && data.file_size_limit > 0
          ? data.file_size_limit
          : fallback.maxBytes,
        allowedMime: Array.isArray(data.allowed_mime_types) && data.allowed_mime_types.length > 0
          ? data.allowed_mime_types
          : fallback.allowedMime,
        label: fallback.label,
      }
      liveLimits.set(bucket, resolved)
      liveBuckets.add(bucket)
      return resolved
    }
  } catch (e) {
    debug.warn(`Could not fetch live limits for bucket "${bucket}", using defaults`, e)
  }

  liveLimits.set(bucket, fallback)
  return fallback
}

/**
 * Validate a file against a bucket's size/type limits BEFORE uploading.
 * Returns a friendly error message, or null if the file is acceptable.
 */
export async function validateImageUpload(file: File, bucket: string): Promise<string | null> {
  const limits = await getBucketLimits(bucket)

  if (limits.allowedMime && file.type && !limits.allowedMime.includes(file.type)) {
    const typeName = FRIENDLY_MIME[file.type] || file.type || 'this file type'
    return `That ${limits.label} is a ${typeName} file, which isn't allowed. Supported types: ${describeMimeList(limits.allowedMime)}.`
  }

  if (limits.maxBytes > 0 && file.size > limits.maxBytes) {
    return `That ${limits.label} is too large (${formatBytes(file.size)}). The maximum allowed size is ${formatBytes(limits.maxBytes)}.`
  }

  return null
}

function extractMessage(error: unknown): string {
  if (!error) return ''
  if (typeof error === 'string') return error
  const e = error as Record<string, any>
  return e.message || e.error || e.msg || ''
}

function extractStatus(error: unknown): number | undefined {
  const e = error as Record<string, any> | null
  const raw = e?.statusCode ?? e?.status ?? e?.originalError?.status
  const n = typeof raw === 'string' ? parseInt(raw, 10) : raw
  return typeof n === 'number' && !isNaN(n) ? n : undefined
}

/**
 * Turn a raw Supabase storage error into a human-readable explanation. We only
 * quote a specific size/type limit when we have the authoritative live value
 * for that bucket, so we never show a misleading number.
 */
export function humanizeUploadError(error: unknown, bucket?: string): string {
  const fallback = bucket ? BUCKET_LIMITS[bucket] : undefined
  const label = fallback?.label || 'file'
  const raw = extractMessage(error).toLowerCase()
  const status = extractStatus(error)
  const live = bucket && liveBuckets.has(bucket) ? liveLimits.get(bucket) : undefined

  const isTooLarge =
    status === 413 ||
    raw.includes('exceeded the maximum allowed size') ||
    raw.includes('payload too large') ||
    raw.includes('maximum allowed size') ||
    raw.includes('too large')
  if (isTooLarge) {
    return live?.maxBytes
      ? `That ${label} is too large. The maximum allowed size is ${formatBytes(live.maxBytes)}.`
      : `That ${label} is too large. Please upload a smaller file.`
  }

  const isBadType =
    status === 415 ||
    raw.includes('mime type') ||
    raw.includes('not supported') ||
    raw.includes('invalid_mime') ||
    raw.includes('content type')
  if (isBadType) {
    const allowed = live?.allowedMime || fallback?.allowedMime
    return allowed
      ? `That file type isn't allowed for your ${label}. Supported types: ${describeMimeList(allowed)}.`
      : `That file type isn't supported for your ${label}.`
  }

  if (status === 403 || raw.includes('row-level security') || raw.includes('not authorized') || raw.includes('permission')) {
    return `You don't have permission to change this ${label}.`
  }

  return extractMessage(error) || `Failed to upload ${label}.`
}
