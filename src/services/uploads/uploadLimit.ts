import { supabase } from '@/supabase'
import { i18n } from '@/i18n'
import { debug } from '@/utils/debug'
import { formatBytes } from '@/utils/uploadValidation'

/**
 * The signed-in account's upload limit: the largest object it may store in message_media or
 * user_media (db_schema/migrations/20261031100001_upload_limits.sql). get_my_upload_limit
 * returns its override, else its tier, clamped to the operator's ceiling, in bytes.
 *
 * Storage refuses a larger object whatever this module reads; the check here refuses before
 * any byte is sent. The value is cached per account for UPLOAD_LIMIT_TTL_MS and read again
 * after a refusal, since an admin may have changed it meanwhile.
 */

/** Buckets whose objects count against the account's limit; the others keep bucket limits. */
export const LIMITED_BUCKETS: ReadonlySet<string> = new Set(['message_media', 'user_media'])

export const UPLOAD_LIMIT_TTL_MS = 5 * 60 * 1000

/** A file over the account's limit; `message` is user-facing. */
export class UploadLimitError extends Error {
  constructor(message: string, readonly size: number, readonly limit: number) {
    super(message)
    this.name = 'UploadLimitError'
  }
}

interface Reading {
  account: string
  limit: number | null
  at: number
}

let reading: Reading | null = null
const pending = new Map<string, Promise<number | null>>()

async function signedInAccount(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession()
    return data.session?.user?.id ?? null
  } catch {
    return null
  }
}

async function readLimit(account: string): Promise<number | null> {
  let answer: { data: unknown; error: unknown }
  try {
    answer = await supabase.rpc('get_my_upload_limit')
  } catch (error) {
    answer = { data: null, error }
  }
  const { data, error } = answer
  if (error) {
    // A server without the function (before 1.9.2) has bucket limits only.
    debug.warn('Could not read the upload limit', error)
    return reading?.account === account ? reading.limit : null
  }
  const limit = data === null || data === undefined ? null : Number(data)
  const value = limit !== null && Number.isFinite(limit) && limit >= 0 ? limit : null
  reading = { account, limit: value, at: Date.now() }
  return value
}

/** Bytes; null when signed out or unknown. `fresh` skips the cache. */
export async function getUploadLimit(options: { fresh?: boolean } = {}): Promise<number | null> {
  const account = await signedInAccount()
  if (!account) return null
  if (!options.fresh && reading?.account === account && Date.now() - reading.at < UPLOAD_LIMIT_TTL_MS) {
    return reading.limit
  }
  let read = pending.get(account)
  if (!read) {
    read = readLimit(account).finally(() => pending.delete(account))
    pending.set(account, read)
  }
  return read
}

export function uploadLimitMessage(size: number, limit: number, name?: string): string {
  const values = { name, size: formatBytes(size), limit: formatBytes(limit) }
  return name
    ? i18n.global.t('uploadLimits.tooLarge', values)
    : i18n.global.t('uploadLimits.tooLargeFile', values)
}

/**
 * Throws UploadLimitError when `file` would go over the account's limit in `bucket`. A copy
 * into the bucket counts as an upload of its size.
 */
export async function checkUploadLimit(bucket: string, file: { size: number }, name?: string): Promise<void> {
  if (!LIMITED_BUCKETS.has(bucket)) return
  const limit = await getUploadLimit()
  if (limit !== null && file.size > limit) {
    throw new UploadLimitError(uploadLimitMessage(file.size, limit, name), file.size, limit)
  }
}

/**
 * Storage refused `file`: the limit as it is now, when the file exceeds it. Storage words a
 * limit refusal as a row-level security refusal (42501), or 413 past the ceiling.
 */
export async function limitRefusal(bucket: string, file: { size: number }, name?: string): Promise<UploadLimitError | null> {
  if (!LIMITED_BUCKETS.has(bucket)) return null
  const limit = await getUploadLimit({ fresh: true }).catch(() => null)
  return limit !== null && file.size > limit
    ? new UploadLimitError(uploadLimitMessage(file.size, limit, name), file.size, limit)
    : null
}

/** Test hook. */
export function resetUploadLimit(): void {
  reading = null
  pending.clear()
}
