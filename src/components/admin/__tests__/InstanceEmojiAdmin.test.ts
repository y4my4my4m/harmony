/**
 * InstanceEmojiAdmin.vue: pages admin_list_instance_emojis, filters and searches from the
 * first page, renames through admin_rename_instance_emoji and deletes through
 * admin_delete_instance_emoji after a confirmation naming the reactions it removes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { supabase } from '@/supabase'
import InstanceEmojiAdmin from '../InstanceEmojiAdmin.vue'

vi.mock('vue-i18n', async () => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, params: Record<string, unknown> = {}, plural?: number) => {
    let message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    if (typeof message !== 'string') return key
    if (plural !== undefined) {
      const forms = message.split(' | ')
      message = forms.length === 3 ? forms[Math.min(plural, 2)] : forms[plural === 1 ? 0 : 1]
    }
    return message.replace(/\{(\w+)\}/g, (_: string, name: string) => String(params[name] ?? `{${name}}`))
  }
  return { useI18n: () => ({ t }) }
})

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/LoadingSpinner.vue', () => stub('LoadingSpinner'))

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

const confirm = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm }) }))

const logAdminAction = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/services/AdminService', () => ({ adminService: { logAdminAction } }))

const invalidate = vi.hoisted(() => vi.fn())
vi.mock('@/services/emojiShortcodeResolver', () => ({ invalidateEmojiResolverCache: invalidate }))

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>

const row = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `e${n}`,
  name: `emoji_${n}`,
  url: `https://cdn.test/${n}.png`,
  domain: null,
  scope: 'instance',
  uploader: null,
  uploader_username: null,
  created_at: '2026-10-01T00:00:00Z',
  usage_count: 0,
  reaction_count: 0,
  total_count: 120,
  ...extra,
})

let listResult: { data: unknown; error: unknown }
let renameResult: { data: unknown; error: unknown }

beforeEach(() => {
  rpc.mockReset()
  toast.success.mockReset()
  toast.error.mockReset()
  confirm.mockReset()
  invalidate.mockReset()
  logAdminAction.mockClear()
  listResult = {
    data: [
      row(1, { domain: 'discord.com', reaction_count: '3', uploader_username: 'bridgebot' }),
      row(2),
    ],
    error: null,
  }
  renameResult = { data: null, error: null }
  rpc.mockImplementation(async (fn: string) => {
    if (fn === 'admin_list_instance_emojis') return listResult
    if (fn === 'admin_rename_instance_emoji') return renameResult
    return { data: null, error: null }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

const listCalls = () => rpc.mock.calls.filter(([fn]) => fn === 'admin_list_instance_emojis').map(([, args]) => args)

async function render() {
  const wrapper = mount(InstanceEmojiAdmin)
  await flushPromises()
  return wrapper
}

describe('InstanceEmojiAdmin', () => {
  it('loads the first page and renders each emoji with its source and reactions', async () => {
    const w = await render()
    expect(listCalls()).toEqual([{ p_search: null, p_source: 'all', p_sort: 'newest', p_limit: 50, p_offset: 0 }])
    const rows = w.findAll('.emoji-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].find('.emoji-name').text()).toBe(':emoji_1:')
    expect(rows[0].find('img').attributes('src')).toBe('https://cdn.test/1.png')
    expect(rows[0].text()).toContain('discord.com')
    expect(rows[0].text()).toContain('by @bridgebot')
    expect(rows[0].text()).toContain('3 reactions')
    expect(rows[1].find('.badge').text()).toBe('local')
    expect(rows[1].text()).toContain('no reactions')
    expect(w.find('.page-info').text()).toBe('1-50 of 120')
  })

  it('pages with offset and resets to the first page on a filter change', async () => {
    const w = await render()
    const [prev, next] = w.findAll('.emoji-pagination .action-btn')
    expect(prev.attributes('disabled')).toBeDefined()
    await next.trigger('click')
    await flushPromises()
    expect(listCalls().at(-1)).toMatchObject({ p_offset: 50 })

    await w.findAll('select')[0].setValue('remote')
    await flushPromises()
    expect(listCalls().at(-1)).toMatchObject({ p_source: 'remote', p_offset: 0 })

    await w.findAll('select')[1].setValue('name')
    await flushPromises()
    expect(listCalls().at(-1)).toMatchObject({ p_sort: 'name', p_offset: 0 })
  })

  it('debounces search into one request', async () => {
    vi.useFakeTimers()
    const w = mount(InstanceEmojiAdmin)
    await flushPromises()
    const input = w.find('input[type="search"]')
    await input.setValue('bl')
    await input.setValue('blob')
    vi.advanceTimersByTime(299)
    expect(listCalls()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    await flushPromises()
    expect(listCalls()).toHaveLength(2)
    expect(listCalls()[1]).toMatchObject({ p_search: 'blob', p_offset: 0 })
  })

  it('shows the empty state when nothing matches', async () => {
    listResult = { data: [], error: null }
    const w = await render()
    expect(w.find('.empty-state').text()).toBe('No instance emojis match.')
    expect(w.find('.emoji-pagination').exists()).toBe(false)
  })

  it('renames through the RPC and rejects an invalid name locally', async () => {
    const w = await render()
    await w.findAll('.emoji-row')[1].findAll('.emoji-actions .action-btn')[0].trigger('click')
    const input = w.find('.rename-input')
    await input.setValue('bad name')
    await w.find('.rename-form').trigger('submit')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith('Names are 2 to 64 letters, digits, _ or -.')
    expect(rpc).not.toHaveBeenCalledWith('admin_rename_instance_emoji', expect.anything())

    await input.setValue(' party_parrot ')
    await w.find('.rename-form').trigger('submit')
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('admin_rename_instance_emoji', { p_emoji_id: 'e2', p_name: 'party_parrot' })
    expect(invalidate).toHaveBeenCalled()
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'instance_emoji_rename', targetId: 'e2' }))
    expect(w.findAll('.emoji-row')[1].find('.emoji-name').text()).toBe(':party_parrot:')
    expect(w.find('.rename-form').exists()).toBe(false)
  })

  it('reports a name collision', async () => {
    renameResult = { data: null, error: { code: '23505', message: 'exists' } }
    const w = await render()
    await w.findAll('.emoji-row')[0].findAll('.emoji-actions .action-btn')[0].trigger('click')
    await w.find('.rename-input').setValue('emoji_2')
    await w.find('.rename-form').trigger('submit')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith('Another instance emoji already uses that name.')
    expect(w.find('.rename-form').exists()).toBe(true)
  })

  it('names the removed reactions in the confirmation and deletes only on confirm', async () => {
    const w = await render()
    confirm.mockResolvedValueOnce(false)
    await w.findAll('.emoji-row')[0].find('.action-btn.danger').trigger('click')
    await flushPromises()
    expect(confirm.mock.calls[0][0].message).toContain('Its 3 reactions are removed')
    expect(rpc).not.toHaveBeenCalledWith('admin_delete_instance_emoji', expect.anything())

    confirm.mockResolvedValueOnce(true)
    await w.findAll('.emoji-row')[1].find('.action-btn.danger').trigger('click')
    await flushPromises()
    expect(confirm.mock.calls[1][0].message).not.toContain('reaction')
    expect(rpc).toHaveBeenCalledWith('admin_delete_instance_emoji', { p_emoji_id: 'e2' })
    expect(invalidate).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('Emoji deleted')
    expect(listCalls()).toHaveLength(2)
  })

  it('steps back a page when a delete empties the last one', async () => {
    const w = await render()
    await w.findAll('.emoji-pagination .action-btn')[1].trigger('click')
    await flushPromises()
    const calls = listCalls().length
    confirm.mockResolvedValueOnce(true)
    // Page 2 is empty after the delete; page 1 still holds a row.
    rpc.mockImplementation(async (fn: string, args: any) => {
      if (fn === 'admin_list_instance_emojis') return args.p_offset === 50 ? { data: [], error: null } : { data: [row(3)], error: null }
      return { data: null, error: null }
    })
    await w.findAll('.emoji-row')[0].find('.action-btn.danger').trigger('click')
    await flushPromises()
    expect(listCalls().slice(calls).map((a: any) => a.p_offset)).toEqual([50, 0])
    expect(w.findAll('.emoji-row')).toHaveLength(1)
  })
})
