/**
 * InstanceEmojiAdminService: admin_list_emojis paging and row mapping, the remote emoji listing,
 * its source instances and the import name preview, rename_emoji, remove_emoji, restore_emoji,
 * admin_purge_emoji with removal of the file it reports, and the federation backend's import
 * and re-host routes with their { error: <code> } answers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { supabase } from '@/supabase'
import {
  AdminEmojiRequestError,
  importRemoteEmoji,
  listAdminEmojis,
  listRemoteEmojiSources,
  listRemoteEmojis,
  previewEmojiImports,
  purgeEmoji,
  rehostEmoji,
  removeEmoji,
  renameEmoji,
  restoreEmoji,
} from '@/services/InstanceEmojiAdminService'

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>
const storageFrom = supabase.storage.from as unknown as ReturnType<typeof vi.fn>
const getSession = supabase.auth.getSession as unknown as ReturnType<typeof vi.fn>
const remove = vi.fn()
const fetchMock = vi.fn()

beforeEach(() => {
  rpc.mockReset()
  remove.mockReset().mockResolvedValue({ data: [], error: null })
  storageFrom.mockReturnValue({ remove })
  getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } }, error: null })
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response

describe('listAdminEmojis', () => {
  it('passes the filters and maps rows and the total', async () => {
    rpc.mockResolvedValue({
      data: [{
        id: 'e1', kind: 'server', name: 'blob', url: 'https://db.test/storage/v1/object/public/emojis/a.png',
        domain: null, scope: 'server', server_id: 's1', server_name: 'Hub', uploader: 'p1',
        uploader_username: 'ann', created_at: '2026-11-07T00:00:00Z', usage_count: null,
        reaction_count: '4', deleted_at: '2026-11-07T01:00:00Z', deleted_by_username: 'mod',
        imported_from: null, hotlinked: false, is_ai_generated: false, total_count: '120',
      }],
      error: null,
    })
    const page = await listAdminEmojis({ search: '  blob ', kind: 'server', status: 'removed', sort: 'usage', limit: 50, offset: 50 })
    expect(rpc).toHaveBeenCalledWith('admin_list_emojis', {
      p_search: 'blob', p_kind: 'server', p_status: 'removed', p_sort: 'usage', p_limit: 50, p_offset: 50,
    })
    expect(page.total).toBe(120)
    expect(page.rows[0]).toMatchObject({
      id: 'e1', kind: 'server', server_name: 'Hub', usage_count: 0, reaction_count: 4,
      deleted_by_username: 'mod', hotlinked: false, license: null, source_domain: null,
    })
  })

  it('maps licence and origin instance', async () => {
    rpc.mockResolvedValue({
      data: [{ id: 'e2', kind: 'imported', name: 'blob', url: 'u', created_at: '2026-11-07T00:00:00Z',
               license: 'CC BY 4.0', source_domain: 'misskey.test', total_count: 1 }],
      error: null,
    })
    const page = await listAdminEmojis({ limit: 50, offset: 0 })
    expect(page.rows[0]).toMatchObject({ kind: 'imported', license: 'CC BY 4.0', source_domain: 'misskey.test' })
  })

  it('sends a blank search as null and reads an empty page as total 0', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    const page = await listAdminEmojis({ search: '   ', limit: 50, offset: 0 })
    expect(rpc).toHaveBeenCalledWith('admin_list_emojis', expect.objectContaining({
      p_search: null, p_kind: 'all', p_status: 'active', p_sort: 'newest',
    }))
    expect(page).toEqual({ rows: [], total: 0 })
  })

  it('rethrows the RPC error', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'Instance admins only' } })
    await expect(listAdminEmojis({ limit: 50, offset: 0 })).rejects.toMatchObject({ code: '42501' })
  })
})

describe('remote emojis', () => {
  it('lists rows not imported as not_imported rows, filtered by name and instance', async () => {
    rpc.mockResolvedValue({
      data: [{
        id: 'c1', name: 'blob', url: 'https://media.misskey.test/blob.png', domain: 'misskey.test',
        license: 'CC0', first_seen_at: '2026-11-08T00:00:00Z', usage_count: 7, import_name: 'blob',
        name_taken: true, total_count: '31',
      }],
      error: null,
    })
    const page = await listRemoteEmojis({ search: ' blob ', domain: 'misskey.test', sort: 'usage', limit: 50, offset: 0 })
    expect(rpc).toHaveBeenCalledWith('admin_list_remote_emojis', {
      p_search: 'blob', p_domain: 'misskey.test', p_sort: 'usage', p_limit: 50, p_offset: 0,
    })
    expect(page.total).toBe(31)
    expect(page.rows[0]).toMatchObject({
      id: 'c1', kind: 'not_imported', name: 'blob', domain: 'misskey.test', license: 'CC0',
      created_at: '2026-11-08T00:00:00Z', usage_count: 7, name_taken: true, hotlinked: false,
    })
  })

  it('sends no instance and no search as null', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    expect(await listRemoteEmojis({ search: '', domain: '', limit: 50, offset: 0 })).toEqual({ rows: [], total: 0 })
    expect(rpc).toHaveBeenCalledWith('admin_list_remote_emojis', expect.objectContaining({ p_search: null, p_domain: null, p_sort: 'newest' }))
  })

  it('reads the source instances with their counts', async () => {
    rpc.mockResolvedValue({ data: [{ domain: 'misskey.test', emoji_count: '12' }, { domain: 'other.test', emoji_count: 1 }], error: null })
    expect(await listRemoteEmojiSources()).toEqual([{ domain: 'misskey.test', count: 12 }, { domain: 'other.test', count: 1 }])
    expect(rpc).toHaveBeenCalledWith('admin_remote_emoji_sources')
  })

  it('previews import names for at most 200 ids', async () => {
    rpc.mockResolvedValue({
      data: [{ id: 'c1', name: 'blob', taken: false, suggested: 'blob' }, { id: 'c2', name: 'party', taken: true, suggested: 'party_1' }],
      error: null,
    })
    const ids = Array.from({ length: 230 }, (_, i) => `c${i}`)
    expect(await previewEmojiImports(ids)).toEqual([
      { id: 'c1', name: 'blob', taken: false, suggested: 'blob' },
      { id: 'c2', name: 'party', taken: true, suggested: 'party_1' },
    ])
    expect(rpc.mock.calls[0][0]).toBe('admin_preview_emoji_imports')
    expect(rpc.mock.calls[0][1].p_ids).toHaveLength(200)
  })

  it('rethrows a refused listing', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501' } })
    await expect(listRemoteEmojis({ limit: 50, offset: 0 })).rejects.toMatchObject({ code: '42501' })
    await expect(listRemoteEmojiSources()).rejects.toMatchObject({ code: '42501' })
    await expect(previewEmojiImports(['c1'])).rejects.toMatchObject({ code: '42501' })
  })
})

describe('row writes', () => {
  it('rename, remove and restore call their RPCs and rethrow refusals', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    await renameEmoji('e1', '  cat ')
    await removeEmoji('e1')
    await restoreEmoji('e1')
    expect(rpc.mock.calls).toEqual([
      ['rename_emoji', { p_emoji_id: 'e1', p_name: 'cat' }],
      ['remove_emoji', { p_emoji_id: 'e1' }],
      ['restore_emoji', { p_emoji_id: 'e1' }],
    ])
    rpc.mockResolvedValue({ data: null, error: { code: '23505' } })
    await expect(restoreEmoji('e1')).rejects.toMatchObject({ code: '23505' })
  })

  it('purge removes the reported file from bucket emojis', async () => {
    rpc.mockResolvedValue({ data: '00000000-0000-0000-0000-000000000000/a.png', error: null })
    expect(await purgeEmoji('e1')).toBe(true)
    expect(rpc).toHaveBeenCalledWith('admin_purge_emoji', { p_emoji_id: 'e1' })
    expect(storageFrom).toHaveBeenCalledWith('emojis')
    expect(remove).toHaveBeenCalledWith(['00000000-0000-0000-0000-000000000000/a.png'])
  })

  it('purge without a path removes nothing; a failed file removal reads false', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    expect(await purgeEmoji('e1')).toBe(true)
    expect(remove).not.toHaveBeenCalled()

    rpc.mockResolvedValue({ data: 'p/a.png', error: null })
    remove.mockResolvedValue({ data: null, error: { message: 'denied' } })
    expect(await purgeEmoji('e2')).toBe(false)
  })
})

describe('backend routes', () => {
  it('import posts the cache id and name with the session token', async () => {
    fetchMock.mockResolvedValue(json(201, { emoji: { id: 'n1', name: 'party', url: 'u', imported_from: 'https://r.test/p.png' } }))
    const emoji = await importRemoteEmoji('c1', ' party ')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/federation/admin/emojis/import')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body)).toEqual({ remoteEmojiId: 'c1', name: 'party' })
    expect(emoji).toEqual({ id: 'n1', name: 'party', url: 'u', imported_from: 'https://r.test/p.png' })
  })

  it('import without a name sends the cache id only', async () => {
    fetchMock.mockResolvedValue(json(201, { emoji: { id: 'n1', name: 'orig', url: 'u' } }))
    await importRemoteEmoji('c1', '  ')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ remoteEmojiId: 'c1' })
  })

  it('re-host posts to the emoji route', async () => {
    fetchMock.mockResolvedValue(json(200, { emoji: { id: 'e1', name: 'cat', url: 'u2', imported_from: 'https://x.test/c.png' } }))
    await rehostEmoji('e1')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/federation/admin/emojis/e1/rehost')
  })

  it('an error answer throws its code and status', async () => {
    fetchMock.mockResolvedValue(json(409, { error: 'name_taken' }))
    await expect(importRemoteEmoji('c1')).rejects.toEqual(new AdminEmojiRequestError('name_taken', 409))
    fetchMock.mockResolvedValue(json(502, null))
    await expect(rehostEmoji('e1')).rejects.toMatchObject({ code: 'internal_error', status: 502 })
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(rehostEmoji('e1')).rejects.toMatchObject({ code: 'network_error' })
  })

  it('the hourly limit reads as rate_limited whatever the body says', async () => {
    fetchMock.mockResolvedValue(json(429, { error: 'Too Many Requests', message: 'Too many emoji imports; try again later.' }))
    await expect(importRemoteEmoji('c1', 'blob')).rejects.toEqual(new AdminEmojiRequestError('rate_limited', 429))
  })
})
