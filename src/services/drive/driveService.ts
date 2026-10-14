import { supabase } from '@/supabase'

/**
 * Drive calls (migrations 20261015100001_drive_core.sql, 20261015100002_drive_api.sql).
 *
 * Files are rows of drive_files; their bytes are message_media or user_media objects. Every
 * upload of the account to those buckets is a Drive file; the upload's storage metadata names
 * it (DriveUploadMetadata).
 */

export type DriveFileState = 'drive' | 'ephemeral' | 'trashed' | 'gone'
export type DriveFileKind = 'image' | 'video' | 'audio' | 'document' | 'other'
export type DriveView =
  | 'folder' | 'all' | 'recent' | 'ephemeral' | 'trash'
  | 'server' | 'channel' | 'conversation' | 'dms' | 'fediverse' | 'shared'
export type DriveSort = 'newest' | 'oldest' | 'name' | 'size'
export type DriveShareScope = 'user' | 'server' | 'channel' | 'link'

export interface DriveFile {
  id: string
  owner_id: string
  bucket: 'message_media' | 'user_media'
  path: string
  name: string | null
  mime_type: string | null
  kind: DriveFileKind
  size_bytes: number
  sha256: string | null
  folder_id: string | null
  state: DriveFileState
  gone_reason: 'expired' | 'deleted' | 'removed' | null
  expires_at: string | null
  trashed_at: string | null
  created_at: string
  updated_at: string
}

export interface DriveOwner {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  domain: string | null
}

export interface DriveListEntry {
  file: DriveFile
  owner: DriveOwner | null
}

export interface DriveFolder {
  id: string
  owner_id: string
  parent_id: string | null
  name: string
  created_at: string
  updated_at: string
}

export interface DriveUsage {
  used_bytes: number
  quota_bytes: number
  ephemeral_bytes: number
  ephemeral_recent_bytes: number
  ephemeral_daily_bytes: number
  ephemeral_days: number
  trash_bytes: number
  file_count: number
  link_sharing: boolean
}

export interface DriveContextTree {
  servers: Array<{
    id: string
    name: string
    icon: string | null
    files: number
    channels: Array<{ id: string; name: string; files: number }> | null
  }>
  conversations: Array<{ id: string; type: string; name: string | null; files: number }>
  fediverse: number
  shared: number
}

export interface DriveShare {
  id: string
  scope: DriveShareScope
  target_id: string | null
  token: string | null
  expires_at: string | null
  created_at: string
  target_name?: string | null
}

export interface DriveFileUsage {
  messages: Array<{
    message_id: string
    created_at: string
    channel_id: string | null
    channel_name: string | null
    server_id: string | null
    server_name: string | null
    conversation_id: string | null
    conversation_name: string | null
    thread_id: string | null
  }>
  posts: Array<{ post_id: string; created_at: string; visibility: string | null }>
  shares: DriveShare[]
}

export interface DriveLinkInfo {
  name: string
  mime_type: string | null
  kind: DriveFileKind
  size_bytes: number
  created_at: string
  expires_at: string | null
  owner: { username: string; display_name: string | null; avatar_url: string | null; domain: string | null }
}

/** storage-api user_metadata of a Drive upload. */
export interface DriveUploadMetadata {
  sha256?: string
  name?: string
  ephemeral?: boolean
  folder?: string
}

export interface DriveListQuery {
  view: DriveView
  folder?: string | null
  context?: string | null
  query?: string | null
  kind?: DriveFileKind | null
  sort?: DriveSort
  limit?: number
  offset?: number
}

/** PostgREST code for a function the schema cache does not hold. */
const MISSING_FUNCTION = 'PGRST202'

let available: Promise<boolean> | null = null

/** Whether the instance has Drive; asked once per session. */
export function driveAvailable(): Promise<boolean> {
  available ??= (async () => {
    try {
      const { error } = await supabase.rpc('get_my_drive_usage')
      return !error || error.code !== MISSING_FUNCTION
    } catch {
      return false
    }
  })()
  return available
}

/** Forgets the capability answer; sign-out and tests. */
export function resetDriveAvailability(): void {
  available = null
}

function fail(error: { message: string; code?: string } | null): void {
  if (error) throw Object.assign(new Error(error.message), { code: error.code })
}

export async function getDriveUsage(): Promise<DriveUsage> {
  const { data, error } = await supabase.rpc('get_my_drive_usage')
  fail(error)
  return data as DriveUsage
}

export async function listDriveFiles(q: DriveListQuery): Promise<{ entries: DriveListEntry[]; total: number }> {
  const { data, error } = await supabase.rpc('drive_list_files', {
    p_view: q.view,
    p_folder: q.folder ?? null,
    p_context: q.context ?? null,
    p_query: q.query ?? null,
    p_kind: q.kind ?? null,
    p_sort: q.sort ?? 'newest',
    p_limit: q.limit ?? 100,
    p_offset: q.offset ?? 0,
  })
  fail(error)
  const rows = (data as Array<{ file: DriveFile; owner: DriveOwner | null; total_count: number }> | null) ?? []
  return { entries: rows.map(({ file, owner }) => ({ file, owner })), total: rows[0]?.total_count ?? 0 }
}

export async function listDriveFolders(): Promise<DriveFolder[]> {
  const { data, error } = await supabase.rpc('drive_list_folders')
  fail(error)
  return (data as DriveFolder[] | null) ?? []
}

export async function getDriveContextTree(): Promise<DriveContextTree> {
  const { data, error } = await supabase.rpc('drive_context_tree')
  fail(error)
  return data as DriveContextTree
}

export async function getDriveFileUsage(fileId: string): Promise<DriveFileUsage> {
  const { data, error } = await supabase.rpc('drive_file_usage', { p_file: fileId })
  fail(error)
  return data as DriveFileUsage
}

export async function findDriveFilesByHash(sha256: string): Promise<DriveFile[]> {
  const { data, error } = await supabase.rpc('drive_find_by_hash', { p_sha256: sha256 })
  fail(error)
  return ((data as Array<DriveFile | { drive_find_by_hash: DriveFile }> | null) ?? [])
    .map((row) => ('drive_find_by_hash' in row ? row.drive_find_by_hash : row))
}

/** Whether instance staff blocked the bytes with this SHA-256. */
export async function isDriveHashBlocked(sha256: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('drive_hash_blocked', { p_sha256: sha256 })
  fail(error)
  return data === true
}

export async function getDriveFileStatus(paths: string[]): Promise<Array<{
  path: string
  state: DriveFileState
  gone_reason: DriveFile['gone_reason']
  expires_at: string | null
}>> {
  if (paths.length === 0) return []
  const { data, error } = await supabase.rpc('drive_file_status', { p_paths: paths })
  fail(error)
  return (data as any[] | null) ?? []
}

export async function createDriveFolder(name: string, parentId: string | null): Promise<DriveFolder> {
  const { data, error } = await supabase.rpc('drive_create_folder', { p_name: name, p_parent: parentId })
  fail(error)
  return data as DriveFolder
}

export async function renameDriveFolder(folderId: string, name: string): Promise<DriveFolder> {
  const { data, error } = await supabase.rpc('drive_rename_folder', { p_folder: folderId, p_name: name })
  fail(error)
  return data as DriveFolder
}

export async function moveDriveFolder(folderId: string, parentId: string | null): Promise<DriveFolder> {
  const { data, error } = await supabase.rpc('drive_move_folder', { p_folder: folderId, p_parent: parentId })
  fail(error)
  return data as DriveFolder
}

export async function deleteDriveFolder(folderId: string): Promise<number> {
  const { data, error } = await supabase.rpc('drive_delete_folder', { p_folder: folderId })
  fail(error)
  return (data as number) ?? 0
}

export async function renameDriveFile(fileId: string, name: string): Promise<DriveFile> {
  const { data, error } = await supabase.rpc('drive_rename_file', { p_file: fileId, p_name: name })
  fail(error)
  return data as DriveFile
}

async function countCall(fn: string, args: Record<string, unknown>): Promise<number> {
  const { data, error } = await supabase.rpc(fn, args)
  fail(error)
  return (data as number) ?? 0
}

export const moveDriveFiles = (ids: string[], folderId: string | null) =>
  countCall('drive_move_files', { p_files: ids, p_folder: folderId })
export const trashDriveFiles = (ids: string[]) => countCall('drive_trash_files', { p_files: ids })
export const restoreDriveFiles = (ids: string[]) => countCall('drive_restore_files', { p_files: ids })
export const deleteDriveFiles = (ids: string[]) => countCall('drive_delete_files', { p_files: ids })
export const keepDriveFiles = (ids: string[]) => countCall('drive_keep_files', { p_files: ids })
export const emptyDriveTrash = () => countCall('drive_empty_trash', {})
/** Temporary (true) or kept in Drive (false), by object name; the composer's toggle. */
export const setDriveTemporary = (paths: string[], temporary: boolean) =>
  countCall('drive_set_temporary', { p_paths: paths, p_temporary: temporary })

export async function shareDriveFile(
  fileId: string,
  scope: Exclude<DriveShareScope, 'link'>,
  targetId: string,
  expiresAt: string | null = null,
): Promise<DriveShare> {
  const { data, error } = await supabase.rpc('drive_share_file', {
    p_file: fileId, p_scope: scope, p_target: targetId, p_expires_at: expiresAt,
  })
  fail(error)
  return data as DriveShare
}

export async function unshareDriveFile(shareId: string): Promise<void> {
  const { error } = await supabase.rpc('drive_unshare', { p_share: shareId })
  fail(error)
}

export async function createDriveLink(fileId: string, expiresAt: string | null = null): Promise<DriveShare> {
  const { data, error } = await supabase.rpc('drive_link_create', { p_file: fileId, p_expires_at: expiresAt })
  fail(error)
  return data as DriveShare
}

export async function resolveDriveLink(token: string): Promise<DriveLinkInfo | null> {
  const { data, error } = await supabase.rpc('drive_link_resolve', { p_token: token })
  fail(error)
  return (data as DriveLinkInfo | null) ?? null
}

/** A URL that downloads the file under its Drive name. */
export async function driveDownloadUrl(file: Pick<DriveFile, 'bucket' | 'path' | 'name'>): Promise<string> {
  const download = file.name || file.path.split('/').pop() || 'file'
  if (file.bucket === 'user_media') {
    return supabase.storage.from('user_media').getPublicUrl(file.path, { download }).data.publicUrl
  }
  const { data, error } = await supabase.storage.from('message_media').createSignedUrl(file.path, 120, { download })
  if (error || !data?.signedUrl) throw error ?? new Error('No download URL')
  return data.signedUrl
}

/** Public URL of a user_media (post media) object. */
export function postMediaPublicUrl(path: string): string {
  return supabase.storage.from('user_media').getPublicUrl(path).data.publicUrl
}

/** A viewable URL of a Drive file: public for post media, signed for an hour otherwise. */
export async function driveViewUrl(file: Pick<DriveFile, 'bucket' | 'path'>): Promise<string> {
  if (file.bucket === 'user_media') return postMediaPublicUrl(file.path)
  const { data, error } = await supabase.storage.from('message_media').createSignedUrl(file.path, 3600)
  if (error || !data?.signedUrl) throw error ?? new Error('No URL for the file')
  return data.signedUrl
}

/**
 * Copies a private message_media file into the account's public post media
 * (user_media `<auth uid>/posts/<uuid>.<ext>`), server-side, and returns the copy's public URL.
 * A post federates with public URLs; the Drive original stays private.
 */
export async function copyDriveFileToPostMedia(path: string, authUserId: string): Promise<string> {
  const ext = (path.split('/').pop() ?? '').split('.').pop() || 'bin'
  const dest = `${authUserId}/posts/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('message_media').copy(path, dest, { destinationBucket: 'user_media' })
  if (error) throw error
  return postMediaPublicUrl(dest)
}

/** Hex SHA-256 of a file's bytes. */
export async function sha256OfBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Display name of a file: its Drive name, else `unnamedLabel` (files sent in encrypted rooms carry none). */
export function driveFileDisplayName(file: Pick<DriveFile, 'name'>, unnamedLabel: string): string {
  return file.name || unnamedLabel
}
