/**
 * AdminEmojiLibrary.vue: one list over admin_list_emojis. Kind chips and the status and sort
 * filters reload from the first page. Import switches to remote emojis (admin_list_remote_emojis)
 * with an instance filter; a row's Import and Import selected hand rows to
 * AdminEmojiImportDialog, and a close that imported something reloads. Remove and Purge confirm
 * first, Restore does not; the image copy appears on hotlinked rows only, one at a time or for
 * a selection. A failed image becomes the broken-image icon. Bulk selection removes several rows
 * after one confirmation. Every change expires the picker caches.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

vi.mock('vue-i18n', async (importOriginal) => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, params: Record<string, unknown> = {}, plural?: number) => {
    let message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    if (typeof message !== 'string') return key
    if (plural !== undefined) {
      const forms = message.split(' | ')
      message = forms.length === 3 ? forms[Math.min(plural, 2)] : forms[plural === 1 ? 0 : 1] ?? forms[0]
    }
    return message.replace(/\{(\w+)\}/g, (_: string, name: string) => String(params[name] ?? `{${name}}`))
  }
  return { ...(await importOriginal<typeof import('vue-i18n')>()), useI18n: () => ({ t, locale: { value: 'en' } }) }
})

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, props: ['title'], render() { return h('span', { class: name }, (this as any).title) } }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/LoadingSpinner.vue', () => stub('LoadingSpinner'))
vi.mock('@/components/common/EmptyState.vue', () => stub('EmptyState'))

vi.mock('@/components/admin/AdminEmojiImportDialog.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'AdminEmojiImportDialog',
      props: ['show', 'rows'],
      emits: ['close'],
      render() { return (this as any).show ? h('div', { 'data-testid': 'import-dialog-stub' }) : null },
    }),
  }
})

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

const dialog = vi.hoisted(() => ({ confirm: vi.fn() }))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => dialog }))

const polite = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useAnnouncer', () => ({ useAnnouncer: () => ({ polite, assertive: vi.fn() }) }))

const invalidate = vi.hoisted(() => vi.fn())
vi.mock('@/services/emojiShortcodeResolver', () => ({ invalidateEmojiResolverCache: invalidate }))

const expirePersonalEmojis = vi.hoisted(() => vi.fn())
vi.mock('@/stores/useEmojiCache', () => ({ useEmojiCacheStore: () => ({ expirePersonalEmojis }) }))

const uploadInstanceEmoji = vi.hoisted(() => vi.fn())
vi.mock('@/services/instanceEmojiUpload', () => ({ uploadInstanceEmoji }))

const svc = vi.hoisted(() => ({
  listAdminEmojis: vi.fn(),
  listRemoteEmojis: vi.fn(),
  listRemoteEmojiSources: vi.fn(),
  renameEmoji: vi.fn(async () => {}),
  removeEmoji: vi.fn(async () => {}),
  restoreEmoji: vi.fn(async () => {}),
  purgeEmoji: vi.fn(async () => true),
  rehostEmoji: vi.fn(async () => ({ id: 'e3', name: 'hot', url: 'u', imported_from: 'x' })),
}))
vi.mock('@/services/InstanceEmojiAdminService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/InstanceEmojiAdminService')>()),
  ...svc,
}))

import AdminEmojiLibrary from '../AdminEmojiLibrary.vue'

enableAutoUnmount(afterEach)

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'instance',
  name: `emoji_${id}`,
  url: `https://db.test/storage/v1/object/public/emojis/${id}.png`,
  domain: null,
  scope: 'instance',
  server_id: null,
  server_name: null,
  uploader: null,
  uploader_username: 'ann',
  created_at: '2026-11-01T00:00:00Z',
  usage_count: 2,
  reaction_count: 1,
  deleted_at: null,
  deleted_by_username: null,
  imported_from: null,
  hotlinked: false,
  is_ai_generated: false,
  license: null,
  source_domain: null,
  ...extra,
})

let pages: Record<string, any[]>

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockClear()
  for (const fn of [toast.success, toast.error, toast.warning, dialog.confirm, invalidate, expirePersonalEmojis, polite]) fn.mockReset()
  pages = {
    all: [row('e1'), row('e2', { kind: 'server', scope: 'server', server_id: 's1', server_name: 'Hub' }), row('e3', { hotlinked: true, url: 'https://elsewhere.test/hot.png' })],
    not_imported: [
      row('c1', { kind: 'not_imported', name: 'party', domain: 'remote.test', scope: null, url: 'https://remote.test/p.png', license: 'CC BY 4.0', name_taken: false }),
      row('c2', { kind: 'not_imported', name: 'emoji_e1', domain: 'other.test', scope: null, url: 'https://other.test/e.png', name_taken: true }),
    ],
    removed: [row('e9', { deleted_at: '2026-11-06T00:00:00Z', deleted_by_username: 'mod' })],
  }
  svc.listAdminEmojis.mockImplementation(async (params: any) => {
    const rows = params.status === 'removed' ? pages.removed : pages.all
    return { rows, total: rows.length }
  })
  svc.listRemoteEmojis.mockImplementation(async (params: any) => {
    const rows = pages.not_imported.filter((r) => !params.domain || r.domain === params.domain)
    return { rows, total: rows.length }
  })
  svc.listRemoteEmojiSources.mockResolvedValue([{ domain: 'remote.test', count: 1 }, { domain: 'other.test', count: 1 }])
})

async function mountList() {
  const w = mount(AdminEmojiLibrary, { attachTo: document.body })
  await flushPromises()
  return w
}

const rowEl = (w: any, id: string) => w.find(`[data-emoji-id="${id}"]`)

describe('AdminEmojiLibrary', () => {
  it('lists every kind from the first page, active, newest first', async () => {
    const w = await mountList()
    expect(svc.listAdminEmojis).toHaveBeenCalledWith({ search: '', kind: 'all', status: 'active', sort: 'newest', limit: 50, offset: 0 })
    expect(w.findAll('[data-testid="admin-emoji-row"]')).toHaveLength(3)
    expect(rowEl(w, 'e2').text()).toContain('in Hub')
    expect(rowEl(w, 'e2').find('.badge.kind').text()).toBe('Server')
    expect(w.find('[data-testid="admin-emoji-kind-all"]').attributes('aria-pressed')).toBe('true')
  })

  it('Import lists remote emojis, filtered by source instance, with licence and held names', async () => {
    const w = await mountList()
    await w.find('[data-testid="admin-emoji-import-open"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="admin-emoji-kind-not_imported"]').attributes('aria-pressed')).toBe('true')
    expect(svc.listRemoteEmojis).toHaveBeenLastCalledWith({ search: '', domain: null, sort: 'newest', limit: 50, offset: 0 })
    expect(svc.listRemoteEmojiSources).toHaveBeenCalledTimes(1)
    expect(w.find('[data-testid="admin-emoji-status"]').exists()).toBe(false)
    expect(w.find('[data-testid="admin-emoji-import-hint"]').text()).toContain('everyone here can use it')
    expect(document.activeElement).toBe(w.find('[data-testid="admin-emoji-search"]').element)

    const source = w.find('[data-testid="admin-emoji-source"]')
    expect(source.findAll('option').map((o) => o.text())).toEqual(['All instances', 'remote.test (1)', 'other.test (1)'])
    expect(rowEl(w, 'c1').text()).toContain('from remote.test')
    expect(rowEl(w, 'c1').find('[data-testid="admin-emoji-license"]').text()).toBe('Licence: CC BY 4.0')
    expect(rowEl(w, 'c1').find('[data-testid="admin-emoji-name-taken"]').exists()).toBe(false)
    expect(rowEl(w, 'c2').find('[data-testid="admin-emoji-name-taken"]').text()).toBe('name in use')

    await source.setValue('other.test')
    await flushPromises()
    expect(svc.listRemoteEmojis).toHaveBeenLastCalledWith(expect.objectContaining({ domain: 'other.test', offset: 0 }))
    expect(w.findAll('[data-testid="admin-emoji-row"]')).toHaveLength(1)
  })

  it('the Available to import chip opens the same list; Import pressed again returns to All', async () => {
    const w = await mountList()
    await w.find('[data-testid="admin-emoji-kind-not_imported"]').trigger('click')
    await flushPromises()
    expect(svc.listRemoteEmojis).toHaveBeenCalledTimes(1)
    expect(w.find('[data-testid="admin-emoji-import-open"]').attributes('aria-pressed')).toBe('true')

    await w.find('[data-testid="admin-emoji-import-open"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="admin-emoji-import-open"]').attributes('aria-pressed')).toBe('false')
    expect(w.find('[data-testid="admin-emoji-kind-all"]').attributes('aria-pressed')).toBe('true')
    expect(svc.listAdminEmojis).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'all', offset: 0 }))
  })

  it('a row\'s Import opens the dialog with that row; a close that imported reloads and expires the pickers', async () => {
    const w = await mountList()
    await w.find('[data-testid="admin-emoji-import-open"]').trigger('click')
    await flushPromises()
    const importDialog = w.findComponent({ name: 'AdminEmojiImportDialog' })
    expect(importDialog.props('show')).toBe(false)

    await rowEl(w, 'c1').find('[data-action="import"]').trigger('click')
    expect(importDialog.props('show')).toBe(true)
    expect(importDialog.props('rows').map((r: any) => r.id)).toEqual(['c1'])

    pages.not_imported = pages.not_imported.slice(1)
    importDialog.vm.$emit('close', 1)
    await flushPromises()
    expect(importDialog.props('show')).toBe(false)
    expect(toast.success).toHaveBeenCalledWith('1 emoji imported')
    expect(invalidate).toHaveBeenCalled()
    expect(expirePersonalEmojis).toHaveBeenCalled()
    expect(svc.listRemoteEmojis).toHaveBeenCalledTimes(2)
    expect(svc.listRemoteEmojiSources).toHaveBeenCalledTimes(2)
    expect(rowEl(w, 'c1').exists()).toBe(false)
    expect(document.activeElement).toBe(rowEl(w, 'c2').find('[data-action="import"]').element)
  })

  it('Import selected hands the selection to the dialog; a close that imported nothing changes nothing', async () => {
    const w = await mountList()
    await w.find('[data-testid="admin-emoji-import-open"]').trigger('click')
    await flushPromises()
    await w.find('[data-testid="admin-emoji-select"]').trigger('click')
    expect(w.find('[data-testid="admin-emoji-bulk-remove"]').exists()).toBe(false)
    expect(w.find('[data-testid="admin-emoji-bulk-purge"]').exists()).toBe(false)
    expect(w.find('[data-testid="admin-emoji-bulk-import"]').attributes('disabled')).toBeDefined()
    await w.find('[data-testid="admin-emoji-select-page"]').trigger('click')
    expect(w.find('.bulk-count').text()).toBe('2 selected')
    await w.find('[data-testid="admin-emoji-bulk-import"]').trigger('click')

    const importDialog = w.findComponent({ name: 'AdminEmojiImportDialog' })
    expect(importDialog.props('rows').map((r: any) => r.id)).toEqual(['c1', 'c2'])
    importDialog.vm.$emit('close', 0)
    await flushPromises()
    expect(toast.success).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
    expect(svc.listRemoteEmojis).toHaveBeenCalledTimes(1)
    expect(w.find('.bulk-count').text()).toBe('2 selected')
  })

  it('Remove confirms, soft-deletes and moves focus to the next row', async () => {
    const w = await mountList()
    dialog.confirm.mockResolvedValueOnce(false)
    await rowEl(w, 'e1').find('[data-action="remove"]').trigger('click')
    await flushPromises()
    expect(svc.removeEmoji).not.toHaveBeenCalled()

    dialog.confirm.mockResolvedValueOnce(true)
    svc.removeEmoji.mockImplementationOnce(async () => { pages.all = pages.all.slice(1) })
    await rowEl(w, 'e1').find('[data-action="remove"]').trigger('click')
    await flushPromises()
    expect(dialog.confirm.mock.calls[1][0].message).toContain('Earlier messages and reactions keep showing it')
    expect(svc.removeEmoji).toHaveBeenCalledWith('e1')
    expect(toast.success).toHaveBeenCalledWith('Removed :emoji_e1:')
    expect(rowEl(w, 'e1').exists()).toBe(false)
    expect(document.activeElement).toBe(rowEl(w, 'e2').find('[data-action="remove"]').element)
  })

  it('Purge confirms with the broken-image consequence and warns when the file stays', async () => {
    const w = await mountList()
    dialog.confirm.mockResolvedValue(true)
    svc.purgeEmoji.mockResolvedValueOnce(false)
    await rowEl(w, 'e2').find('[data-action="purge"]').trigger('click')
    await flushPromises()
    expect(dialog.confirm.mock.calls[0][0]).toMatchObject({ dangerAction: true, confirmButtonText: 'Purge' })
    expect(dialog.confirm.mock.calls[0][0].message).toContain('broken-image icon')
    expect(svc.purgeEmoji).toHaveBeenCalledWith('e2')
    expect(toast.warning).toHaveBeenCalledWith(':emoji_e2: is purged, but its file could not be deleted.')
  })

  it('Removed rows offer Restore without a confirmation', async () => {
    const w = await mountList()
    await w.find('[data-testid="admin-emoji-status"]').setValue('removed')
    await flushPromises()
    expect(svc.listAdminEmojis).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'removed', offset: 0 }))
    const removed = rowEl(w, 'e9')
    expect(removed.text()).toContain('removed by @mod')
    expect(removed.find('[data-action="remove"]').exists()).toBe(false)
    await removed.find('[data-action="restore"]').trigger('click')
    await flushPromises()
    expect(dialog.confirm).not.toHaveBeenCalled()
    expect(svc.restoreEmoji).toHaveBeenCalledWith('e9')
  })

  it('a restore refused for a taken name says so', async () => {
    const w = await mountList()
    await w.find('[data-testid="admin-emoji-status"]').setValue('removed')
    await flushPromises()
    svc.restoreEmoji.mockRejectedValueOnce({ code: '23505' })
    await rowEl(w, 'e9').find('[data-action="restore"]').trigger('click')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith('Another active emoji already uses that name.')
  })

  it('renames inline and refuses an invalid name before calling the RPC', async () => {
    const w = await mountList()
    await rowEl(w, 'e1').find('[data-action="rename"]').trigger('click')
    const input = rowEl(w, 'e1').find('input.rename-input')
    expect(document.activeElement).toBe(input.element)
    await input.setValue('bad name')
    await rowEl(w, 'e1').find('form').trigger('submit')
    expect(svc.renameEmoji).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Names are 2 to 64 letters, digits, _ or -.')

    await input.setValue('good_name')
    await rowEl(w, 'e1').find('form').trigger('submit')
    await flushPromises()
    expect(svc.renameEmoji).toHaveBeenCalledWith('e1', 'good_name')
    expect(rowEl(w, 'e1').find('.emoji-name').text()).toBe(':good_name:')
    expect(document.activeElement).toBe(rowEl(w, 'e1').find('[data-action="rename"]').element)
  })

  it('the image copy is offered on hotlinked rows only', async () => {
    const w = await mountList()
    expect(rowEl(w, 'e1').find('[data-action="rehost"]').exists()).toBe(false)
    expect(rowEl(w, 'e3').find('.badge.hotlinked').exists()).toBe(true)
    expect(rowEl(w, 'e3').text()).toContain('from elsewhere.test')
    await rowEl(w, 'e3').find('[data-action="rehost"]').trigger('click')
    await flushPromises()
    expect(svc.rehostEmoji).toHaveBeenCalledWith('e3')
    expect(toast.success).toHaveBeenCalledWith(':emoji_e3: is now hosted on this instance')
    expect(rowEl(w, 'e3').find('[data-action="rehost"]').attributes('aria-label')).toBe('Copy the image of :emoji_e3: to this instance')
    expect(rowEl(w, 'e3').find('.badge.hotlinked').attributes('title')).toContain('Nothing else about the emoji changes')
  })

  it('a selection with hotlinked rows offers the image copy for those rows alone', async () => {
    const w = await mountList()
    await w.find('[data-testid="admin-emoji-select"]').trigger('click')
    await rowEl(w, 'e1').find('[data-action="select"]').setValue(true)
    expect(w.find('[data-testid="admin-emoji-bulk-rehost"]').exists()).toBe(false)
    await rowEl(w, 'e3').find('[data-action="select"]').setValue(true)
    await w.find('[data-testid="admin-emoji-bulk-rehost"]').trigger('click')
    await flushPromises()
    expect(svc.rehostEmoji.mock.calls).toEqual([['e3']])
    expect(toast.success).toHaveBeenCalledWith('1 image copied to this instance')
    expect(invalidate).toHaveBeenCalled()
    expect(w.find('[data-testid="admin-emoji-bulk-rehost"]').exists()).toBe(false)
  })

  it('a failed image becomes the broken-image icon and is not requested again', async () => {
    const w = await mountList()
    await rowEl(w, 'e1').find('img').trigger('error')
    expect(rowEl(w, 'e1').find('img').exists()).toBe(false)
    const icon = rowEl(w, 'e1').find('[data-testid="admin-emoji-broken"]')
    expect(icon.attributes('role')).toBe('img')
    expect(icon.attributes('aria-label')).toBe(':emoji_e1:')
    await w.find('[data-testid="admin-emoji-refresh"]').trigger('click')
    await flushPromises()
    expect(rowEl(w, 'e1').find('img').exists()).toBe(false)
  })

  it('bulk remove confirms once and removes every selected row', async () => {
    const w = await mountList()
    await w.find('[data-testid="admin-emoji-select"]').trigger('click')
    await rowEl(w, 'e1').find('[data-action="select"]').setValue(true)
    await rowEl(w, 'e3').find('[data-action="select"]').setValue(true)
    expect(w.find('.bulk-count').text()).toBe('2 selected')
    dialog.confirm.mockResolvedValue(true)
    await w.find('[data-testid="admin-emoji-bulk-remove"]').trigger('click')
    await flushPromises()
    expect(dialog.confirm).toHaveBeenCalledTimes(1)
    expect(dialog.confirm.mock.calls[0][0].message).toContain('Remove 2 emojis?')
    expect(svc.removeEmoji.mock.calls).toEqual([['e1'], ['e3']])
    expect(toast.success).toHaveBeenCalledWith('2 emojis removed')
    expect(w.find('[data-testid="admin-emoji-bulk-remove"]').exists()).toBe(false)
  })

  it('uploads into the instance kind and reloads', async () => {
    const w = await mountList()
    await w.find('[data-testid="admin-emoji-kind-server"]').trigger('click')
    await flushPromises()
    uploadInstanceEmoji.mockResolvedValue(row('n2', { name: 'fresh' }))
    const input = w.find('[data-testid="admin-emoji-upload-input"]')
    const file = new File([new Uint8Array([1])], 'fresh.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
    await input.trigger('change')
    await flushPromises()
    expect(uploadInstanceEmoji).toHaveBeenCalledWith(file)
    expect(toast.success).toHaveBeenCalledWith('Uploaded :fresh:')
    expect(svc.listAdminEmojis).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'instance' }))
    expect(w.find('[data-testid="admin-emoji-kind-instance"]').attributes('aria-pressed')).toBe('true')
  })
})
