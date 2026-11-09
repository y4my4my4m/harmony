/**
 * Reads a following list from a file on the device.
 *
 * Mastodon's following_accounts.csv: header `Account address,Show boosts,Notify on new posts,Languages`,
 * first column user@domain. Mastodon's parser takes a file without that header as data
 * (Form::Import KNOWN_FIRST_HEADERS), so this does as well.
 *
 * Harmony's export: a ZIP holding social.json, or social.json alone. social.json carries
 * { following: [{ username, domain, federated_id, deleted, status }] } (request_my_data_export).
 *
 * Only the handles leave the device. The server validates them (start_following_import).
 */

export type FollowingImportSource = 'mastodon_csv' | 'harmony_export'

export type FollowingFileError = 'file_too_large' | 'unrecognized_file' | 'wrong_list' | 'no_accounts'

export type FollowingFileResult =
  | { ok: true; source: FollowingImportSource; handles: string[] }
  | { ok: false; error: FollowingFileError }

/** Mastodon's FILE_SIZE_LIMIT for an import. */
const CSV_MAX_BYTES = 20 * 1024 * 1024
/** JSZip holds the archive in memory; an export with years of messages stays below this. */
const ARCHIVE_MAX_BYTES = 512 * 1024 * 1024
const SOCIAL_JSON_MAX_BYTES = 100 * 1024 * 1024

/** blocked_accounts.csv has the same shape as a following list and no header to tell them apart. */
const OTHER_MASTODON_LIST = /(block|mute|bookmark|(^|[^a-z])lists\.)/i
const ADDRESS_HEADER = 'account address'
const MUTES_SECOND_HEADER = 'hide notifications'

/** First and second cells of each record of an RFC 4180 document. */
function csvLeadingCells(text: string): Array<[string, string]> {
  const rows: Array<[string, string]> = []
  let cell = 0
  let first = ''
  let second = ''
  let quoted = false
  const flush = () => {
    if (first.trim() || second.trim()) rows.push([first.trim(), second.trim()])
    first = ''
    second = ''
    cell = 0
  }
  const add = (ch: string) => {
    if (cell === 0) first += ch
    else if (cell === 1) second += ch
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch !== '"') add(ch)
      else if (text[i + 1] === '"') {
        add('"')
        i++
      } else quoted = false
    } else if (ch === '"') quoted = true
    else if (ch === ',') cell++
    else if (ch === '\n') flush()
    else if (ch !== '\r') add(ch)
  }
  flush()
  return rows
}

export function parseFollowingCsv(text: string): FollowingFileResult {
  const rows = csvLeadingCells(text.replace(/^\uFEFF/, ''))
  const hasHeader = rows[0]?.[0].toLowerCase() === ADDRESS_HEADER
  if (hasHeader && rows[0][1].toLowerCase() === MUTES_SECOND_HEADER) return { ok: false, error: 'wrong_list' }
  const handles = (hasHeader ? rows.slice(1) : rows).map(([address]) => address)
  if (handles.length === 0) return { ok: false, error: 'no_accounts' }
  return { ok: true, source: 'mastodon_csv', handles }
}

export function parseHarmonySocialJson(text: string): FollowingFileResult {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return { ok: false, error: 'unrecognized_file' }
  }
  const following = (doc as { following?: unknown } | null)?.following
  if (!Array.isArray(following)) return { ok: false, error: 'unrecognized_file' }

  const handles: string[] = []
  for (const entry of following) {
    if (!entry || typeof entry !== 'object') continue
    const { username, domain, federated_id: uri, deleted, status } = entry as Record<string, unknown>
    // A follow turned down stays turned down.
    if (deleted === true || status === 'rejected' || typeof username !== 'string' || !username) continue
    let host = typeof domain === 'string' ? domain : ''
    if (!host && typeof uri === 'string') {
      try {
        host = new URL(uri).host
      } catch {
        host = ''
      }
    }
    handles.push(host ? `${username}@${host}` : username)
  }
  if (handles.length === 0) return { ok: false, error: 'no_accounts' }
  return { ok: true, source: 'harmony_export', handles }
}

async function readExportArchive(file: Blob): Promise<FollowingFileResult> {
  const { default: JSZip } = await import('jszip')
  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer())
  } catch {
    return { ok: false, error: 'unrecognized_file' }
  }
  const social = zip.file('social.json') ?? zip.file(/(^|\/)social\.json$/)[0]
  if (!social) return { ok: false, error: 'unrecognized_file' }
  return parseHarmonySocialJson(await social.async('string'))
}

export async function readFollowingFile(file: File): Promise<FollowingFileResult> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.zip')) {
    if (file.size > ARCHIVE_MAX_BYTES) return { ok: false, error: 'file_too_large' }
    return readExportArchive(file)
  }
  if (name.endsWith('.json')) {
    if (file.size > SOCIAL_JSON_MAX_BYTES) return { ok: false, error: 'file_too_large' }
    return parseHarmonySocialJson(await file.text())
  }
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    if (OTHER_MASTODON_LIST.test(name)) return { ok: false, error: 'wrong_list' }
    if (file.size > CSV_MAX_BYTES) return { ok: false, error: 'file_too_large' }
    return parseFollowingCsv(await file.text())
  }
  return { ok: false, error: 'unrecognized_file' }
}
