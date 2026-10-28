/**
 * InstanceEmojiLibrary.vue: lists every local instance emoji through admin_list_instance_emojis
 * past one 200-row page and hands EmojiLibraryManager an adapter that uploads through
 * uploadInstanceEmoji, renames and deletes through the admin RPCs, audits, and refreshes the picker.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { supabase } from '@/supabase'
import InstanceEmojiLibrary from '../InstanceEmojiLibrary.vue'
import type { EmojiLibraryAdapter, EmojiLibraryTexts } from '@/components/settings/emojiLibrary'
import type { InstanceEmojiRow } from '@/services/InstanceEmojiAdminService'

vi.mock('vue-i18n', async () => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, params: Record<string, unknown> = {}, plural?: number) => {
    let message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    if (typeof message !== 'string') return key
    if (plural !== undefined) {
      const forms = message.split(' | ')
      message = forms[plural === 1 ? 0 : forms.length - 1]
    }
    return message.replace(/\{(\w+)\}/g, (_: string, name: string) => String(params[name] ?? `{${name}}`))
  }
  return { useI18n: () => ({ t, locale: { value: 'en' } }) }
})

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/LoadingSpinner.vue', () => stub('LoadingSpinner'))

interface ManagerProps {
  emojis: InstanceEmojiRow[]
  adapter: EmojiLibraryAdapter<InstanceEmojiRow>
  max: number | null
  texts: EmojiLibraryTexts
}
const manager = vi.hoisted(() => ({ props: null as ManagerProps | null }))
vi.mock('@/components/settings/EmojiLibraryManager.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'EmojiLibraryManager',
      props: ['emojis', 'adapter', 'max', 'texts'],
      emits: ['uploaded', 'renamed', 'deleted'],
      setup(props) {
        manager.props = props as unknown as ManagerProps
        return () => h('div', { class: 'manager-stub' }, (props.emojis as InstanceEmojiRow[]).map((e) => e.name).join(','))
      },
    }),
  }
})

const uploadInstanceEmoji = vi.hoisted(() => vi.fn())
vi.mock('@/services/instanceEmojiUpload', () => ({ uploadInstanceEmoji }))

const logAdminAction = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/services/AdminService', () => ({ adminService: { logAdminAction } }))

const invalidate = vi.hoisted(() => vi.fn())
vi.mock('@/services/emojiShortcodeResolver', () => ({ invalidateEmojiResolverCache: invalidate }))

const expirePersonalEmojis = vi.hoisted(() => vi.fn())
vi.mock('@/stores/useEmojiCache', () => ({ useEmojiCacheStore: () => ({ expirePersonalEmojis }) }))

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>

const row = (n: number, total: number, extra: Partial<InstanceEmojiRow> = {}): InstanceEmojiRow => ({
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
  total_count: total,
  is_ai_generated: false,
  ...extra,
})

const TOTAL = 205

beforeEach(() => {
  rpc.mockReset()
  uploadInstanceEmoji.mockReset()
  logAdminAction.mockClear()
  invalidate.mockReset()
  expirePersonalEmojis.mockReset()
  manager.props = null
  rpc.mockImplementation(async (fn: string, args: Record<string, number>) => {
    if (fn === 'admin_list_instance_emojis') {
      const rows = []
      for (let n = args.p_offset + 1; n <= Math.min(args.p_offset + args.p_limit, TOTAL); n++) {
        rows.push(row(n, TOTAL, n === 3 ? { reaction_count: 2 } : {}))
      }
      return { data: rows, error: null }
    }
    return { data: null, error: null }
  })
})

async function render() {
  const w = mount(InstanceEmojiLibrary)
  await flushPromises()
  return w
}

describe('InstanceEmojiLibrary', () => {
  it('loads every local instance emoji across pages into the shared library', async () => {
    await render()
    const calls = rpc.mock.calls.filter(([fn]) => fn === 'admin_list_instance_emojis').map(([, a]) => a)
    expect(calls).toEqual([
      { p_search: null, p_source: 'local', p_sort: 'newest', p_limit: 200, p_offset: 0 },
      { p_search: null, p_source: 'local', p_sort: 'newest', p_limit: 200, p_offset: 200 },
    ])
    expect(manager.props!.emojis).toHaveLength(TOTAL)
    expect(manager.props!.max).toBeNull()
    expect(manager.props!.texts.title).toBe('Local instance emojis')
  })

  it('uploads through uploadInstanceEmoji and puts the new emoji first', async () => {
    const created = row(999, 0, { name: 'party' })
    uploadInstanceEmoji.mockResolvedValue(created)
    const w = await render()
    const file = new File(['x'], 'party.png', { type: 'image/png' })
    const onProgress = vi.fn()
    await expect(manager.props!.adapter.upload(file, { onProgress })).resolves.toBe(created)
    expect(uploadInstanceEmoji).toHaveBeenCalledWith(file, { onProgress })

    w.findComponent({ name: 'EmojiLibraryManager' }).vm.$emit('uploaded', created)
    await flushPromises()
    expect(manager.props!.emojis[0].name).toBe('party')
    expect(invalidate).toHaveBeenCalled()
    expect(expirePersonalEmojis).toHaveBeenCalled()
  })

  it('renames and deletes through the admin RPCs and audits both', async () => {
    await render()
    const target = manager.props!.emojis[0]
    await manager.props!.adapter.rename(target, 'renamed')
    expect(rpc).toHaveBeenCalledWith('admin_rename_instance_emoji', { p_emoji_id: target.id, p_name: 'renamed' })
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'instance_emoji_rename', targetId: target.id }))

    const result = await manager.props!.adapter.removeMany(manager.props!.emojis.slice(0, 2))
    expect(result).toEqual({ success: ['e1', 'e2'], failed: [] })
    expect(rpc).toHaveBeenCalledWith('admin_delete_instance_emoji', { p_emoji_id: 'e2' })
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'instance_emoji_delete', targetId: 'e2' }))
  })

  it('names the reactions a delete removes and maps refusals to messages', async () => {
    await render()
    const { texts, adapter } = manager.props!
    expect(texts.confirmDelete('emoji_3')).toContain('Its 2 reactions are removed')
    expect(texts.confirmDelete('emoji_4')).toBe(
      'Delete :emoji_4:? Earlier messages that use it show the :emoji_4: text instead of the image.',
    )
    expect(adapter.describeError!('upload', { code: '42501' })).toBe('Only instance admins can upload instance emojis.')
    expect(adapter.describeError!('upload', { code: '23505' })).toBe('That file is already an instance emoji.')
    expect(adapter.describeError!('rename', { code: '23505' })).toBe('Another instance emoji already uses that name.')
    expect(adapter.describeError!('delete', { code: 'XX000' })).toBeNull()
  })

  it('offers a retry when the list fails to load', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } })
    const w = await render()
    expect(w.find('.manager-stub').exists()).toBe(false)
    expect(w.text()).toContain('Could not load instance emojis.')
    await w.get('button').trigger('click')
    await flushPromises()
    expect(w.find('.manager-stub').exists()).toBe(true)
  })
})
