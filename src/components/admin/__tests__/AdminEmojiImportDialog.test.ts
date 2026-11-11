/**
 * AdminEmojiImportDialog.vue: names come from previewEmojiImports. A held name is listed first
 * with a free name filled in; the held name typed back, an invalid name or a name two rows share
 * blocks the import until the row is renamed or skipped. Each planned row is one
 * importRemoteEmoji call with an explicit name. Every row ends with its own result; the hourly
 * limit fails the rest without further requests; Stop leaves the rest untouched.
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

vi.mock('@/components/common/BaseModal.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'BaseModal',
      props: ['show', 'title', 'closeOnOverlay', 'closeOnEscape', 'showCloseButton'],
      emits: ['close'],
      render() {
        const self = this as any
        if (!self.show) return null
        return h('div', { role: 'dialog' }, [h('h2', self.title), self.$slots.default?.(), h('footer', self.$slots.footer?.())])
      },
    }),
  }
})
vi.mock('@/components/common/LoadingSpinner.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'LoadingSpinner', render: () => h('span') }) }
})

const polite = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useAnnouncer', () => ({ useAnnouncer: () => ({ polite, assertive: vi.fn() }) }))

const svc = vi.hoisted(() => ({ previewEmojiImports: vi.fn(), importRemoteEmoji: vi.fn() }))
vi.mock('@/services/InstanceEmojiAdminService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/InstanceEmojiAdminService')>()),
  ...svc,
}))

import AdminEmojiImportDialog from '../AdminEmojiImportDialog.vue'
import { AdminEmojiRequestError } from '@/services/InstanceEmojiAdminService'

enableAutoUnmount(afterEach)

const remote = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, kind: 'not_imported', name, url: `https://remote.test/${name}.png`, domain: 'remote.test', scope: null,
  server_id: null, server_name: null, uploader: null, uploader_username: null, created_at: '2026-11-01T00:00:00Z',
  usage_count: 1, reaction_count: 0, deleted_at: null, deleted_by_username: null, imported_from: null,
  hotlinked: false, is_ai_generated: false, license: null, source_domain: null, ...extra,
})

const ROWS = [
  remote('c1', 'blob', { license: 'CC BY 4.0' }),
  remote('c2', 'party'),
  remote('c3', 'Party', { domain: 'other.test' }),
]
const PREVIEW = [
  { id: 'c1', name: 'blob', taken: false, suggested: 'blob' },
  { id: 'c2', name: 'party', taken: true, suggested: 'party_1' },
  { id: 'c3', name: 'Party', taken: true, suggested: 'Party_2' },
]

beforeEach(() => {
  for (const fn of [svc.previewEmojiImports, svc.importRemoteEmoji, polite]) fn.mockReset()
  svc.previewEmojiImports.mockResolvedValue(PREVIEW)
  svc.importRemoteEmoji.mockImplementation(async (id: string, name: string) => ({ id: `new-${id}`, name, url: 'u', imported_from: 'x' }))
})

async function open(rows: any[] = ROWS) {
  const w = mount(AdminEmojiImportDialog, { props: { show: true, rows }, attachTo: document.body })
  await flushPromises()
  return w
}

const item = (w: any, id: string) => w.find(`[data-testid="admin-emoji-import-item"][data-emoji-id="${id}"]`)
const nameOf = (w: any, id: string) => item(w, id).find('[data-testid="admin-emoji-import-name"]')
const confirm = (w: any) => w.find('[data-testid="admin-emoji-import-confirm"]')

describe('AdminEmojiImportDialog', () => {
  it('lists held names first with a free name filled in, the rest under their own', async () => {
    const w = await open()
    expect(svc.previewEmojiImports).toHaveBeenCalledWith(['c1', 'c2', 'c3'])
    expect(w.find('h2').text()).toBe('Import 3 emojis')
    expect(w.findAll('[data-testid="admin-emoji-import-item"]').map((i) => i.attributes('data-emoji-id'))).toEqual(['c2', 'c3', 'c1'])
    expect((nameOf(w, 'c2').element as HTMLInputElement).value).toBe('party_1')
    expect((nameOf(w, 'c3').element as HTMLInputElement).value).toBe('Party_2')
    expect((nameOf(w, 'c1').element as HTMLInputElement).value).toBe('blob')
    expect(item(w, 'c2').text()).toContain('name in use')
    expect(item(w, 'c1').text()).not.toContain('name in use')
    expect(item(w, 'c1').text()).toContain('Licence: CC BY 4.0')
    expect(item(w, 'c3').text()).toContain('from other.test')
    expect(w.find('[data-testid="admin-emoji-import-clashes"]').text()).toContain('2 names are already used')
    expect(nameOf(w, 'c2').attributes('aria-label')).toBe('Name for :party:')
    expect(confirm(w).text()).toBe('Import 3 emojis')
    expect(confirm(w).attributes('disabled')).toBeUndefined()
  })

  it('the held name typed back, an invalid name and a repeated name block the import until fixed or skipped', async () => {
    const w = await open()
    await nameOf(w, 'c2').setValue('party')
    expect(item(w, 'c2').find('[data-testid="admin-emoji-import-problem"]').text()).toBe('An instance emoji already uses this name.')
    expect(nameOf(w, 'c2').attributes('aria-invalid')).toBe('true')
    expect(confirm(w).attributes('disabled')).toBeDefined()

    await nameOf(w, 'c2').setValue('no spaces')
    expect(item(w, 'c2').find('[data-testid="admin-emoji-import-problem"]').text()).toBe('Names are 2 to 64 letters, digits, _ or -.')

    await nameOf(w, 'c2').setValue('BLOB')
    expect(item(w, 'c2').find('[data-testid="admin-emoji-import-problem"]').text()).toBe('Another emoji in this import uses this name.')
    expect(item(w, 'c1').find('[data-testid="admin-emoji-import-problem"]').text()).toBe('Another emoji in this import uses this name.')
    expect(confirm(w).attributes('disabled')).toBeDefined()

    await item(w, 'c2').find('[data-testid="admin-emoji-import-skip"]').setValue(true)
    expect(item(w, 'c2').find('[data-testid="admin-emoji-import-problem"]').exists()).toBe(false)
    expect(item(w, 'c1').find('[data-testid="admin-emoji-import-problem"]').exists()).toBe(false)
    expect(nameOf(w, 'c2').attributes('disabled')).toBeDefined()
    expect(confirm(w).text()).toBe('Import 2 emojis')
    expect(confirm(w).attributes('disabled')).toBeUndefined()
  })

  it('imports each planned row under its explicit name, skips the skipped, and reports every row', async () => {
    const w = await open()
    await nameOf(w, 'c2').setValue('party_remote')
    await item(w, 'c3').find('[data-testid="admin-emoji-import-skip"]').setValue(true)
    await confirm(w).trigger('click')
    await flushPromises()

    expect(svc.importRemoteEmoji.mock.calls).toEqual([['c2', 'party_remote'], ['c1', 'blob']])
    expect(item(w, 'c2').attributes('data-status')).toBe('imported')
    expect(item(w, 'c2').find('[data-testid="admin-emoji-import-status"]').text()).toBe('Imported as :party_remote:')
    expect(item(w, 'c3').find('[data-testid="admin-emoji-import-status"]').text()).toBe('Skipped')
    expect(item(w, 'c1').find('[data-testid="admin-emoji-import-status"]').text()).toBe('Imported as :blob:')
    expect(w.find('[data-testid="admin-emoji-import-summary"]').text()).toBe('2 emojis imported · 1 skipped')
    expect(polite).toHaveBeenCalledWith('2 emojis imported · 1 skipped')
    expect(w.find('[data-testid="admin-emoji-import-name"]').exists()).toBe(false)

    await w.find('[data-testid="admin-emoji-import-close"]').trigger('click')
    expect(w.emitted('close')).toEqual([[2]])
  })

  it('a refused row shows its reason and the others still import', async () => {
    svc.importRemoteEmoji.mockImplementation(async (id: string, name: string) => {
      if (id === 'c2') throw new AdminEmojiRequestError('name_taken', 409)
      if (id === 'c3') throw new AdminEmojiRequestError('too_large', 413)
      return { id: `new-${id}`, name, url: 'u', imported_from: 'x' }
    })
    const w = await open()
    await confirm(w).trigger('click')
    await flushPromises()
    expect(item(w, 'c2').find('[data-testid="admin-emoji-import-status"]').text()).toBe('An instance emoji already uses that name.')
    expect(item(w, 'c3').find('[data-testid="admin-emoji-import-status"]').text()).toBe('The remote image is larger than the emoji size limit.')
    expect(item(w, 'c1').attributes('data-status')).toBe('imported')
    expect(w.find('[data-testid="admin-emoji-import-summary"]').text()).toBe('1 emoji imported · 2 failed')
  })

  it('the hourly limit fails the rows not yet sent without sending them', async () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => remote(`r${n}`, `emoji_${n}`))
    svc.previewEmojiImports.mockResolvedValue(rows.map((r) => ({ id: r.id, name: r.name, taken: false, suggested: r.name })))
    svc.importRemoteEmoji.mockRejectedValue(new AdminEmojiRequestError('rate_limited', 429))
    const w = await open(rows)
    await confirm(w).trigger('click')
    await flushPromises()
    expect(svc.importRemoteEmoji).toHaveBeenCalledTimes(3)
    expect(w.findAll('[data-status="failed"]')).toHaveLength(6)
    expect(item(w, 'rf').find('[data-testid="admin-emoji-import-status"]').text()).toBe('The hourly import limit is reached. Try again later.')
    expect(w.find('[data-testid="admin-emoji-import-summary"]').text()).toBe('No emoji imported · 6 failed')
  })

  it('Stop lets the requests in flight finish and leaves the rest not started', async () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((n) => remote(`r${n}`, `emoji_${n}`))
    svc.previewEmojiImports.mockResolvedValue(rows.map((r) => ({ id: r.id, name: r.name, taken: false, suggested: r.name })))
    const release: Array<() => void> = []
    svc.importRemoteEmoji.mockImplementation((id: string, name: string) => new Promise((resolve) => {
      release.push(() => resolve({ id: `new-${id}`, name, url: 'u', imported_from: 'x' }))
    }))
    const w = await open(rows)
    await confirm(w).trigger('click')
    await flushPromises()
    expect(svc.importRemoteEmoji).toHaveBeenCalledTimes(3)
    expect(w.find('[data-testid="admin-emoji-import-summary"]').text()).toBe('Importing… 0 of 5 done')
    expect(w.find('[data-testid="admin-emoji-import-close"]').exists()).toBe(false)

    await w.find('[data-testid="admin-emoji-import-stop"]').trigger('click')
    release.forEach((done) => done())
    await flushPromises()
    expect(svc.importRemoteEmoji).toHaveBeenCalledTimes(3)
    expect(w.findAll('[data-status="imported"]')).toHaveLength(3)
    expect(w.findAll('[data-status="stopped"]')).toHaveLength(2)
    expect(w.find('[data-testid="admin-emoji-import-summary"]').text()).toBe('3 emojis imported · 2 not started')
  })

  it('a row the preview no longer returns is reported and not imported', async () => {
    svc.previewEmojiImports.mockResolvedValue(PREVIEW.slice(0, 1))
    const w = await open(ROWS.slice(0, 2))
    expect(item(w, 'c2').find('[data-testid="admin-emoji-import-status"]').text()).toBe('No longer available: already imported or removed')
    expect(confirm(w).text()).toBe('Import 1 emoji')
    await confirm(w).trigger('click')
    await flushPromises()
    expect(svc.importRemoteEmoji.mock.calls).toEqual([['c1', 'blob']])
    expect(w.find('[data-testid="admin-emoji-import-summary"]').text()).toBe('1 emoji imported · 1 skipped')
  })

  it('a failed preview imports nothing and closes with zero', async () => {
    svc.previewEmojiImports.mockRejectedValue(new Error('down'))
    const w = await open()
    expect(w.find('[role="alert"]').text()).toBe('Could not check the names. Close and try again.')
    expect(confirm(w).attributes('disabled')).toBeDefined()
    w.findComponent({ name: 'BaseModal' }).vm.$emit('close')
    expect(w.emitted('close')).toEqual([[0]])
    expect(svc.importRemoteEmoji).not.toHaveBeenCalled()
  })
})
