/**
 * EmojiImporter.vue: an import through import_remote_emoji emits `imported`, so the admin panel
 * reloads the instance emoji lists beside it; a refused import does not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { supabase } from '@/supabase'

vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/EmptyState.vue', () => stub('EmptyState'))

import EmojiImporter from '../EmojiImporter.vue'

enableAutoUnmount(afterEach)

const remote = {
  id: 'r1',
  shortcode: 'blobcat',
  origin_domain: 'remote.example',
  full_code: ':blobcat@remote.example:',
  url: 'https://remote.example/blobcat.png',
  first_seen_at: '2026-10-01T00:00:00Z',
  last_seen_at: '2026-10-02T00:00:00Z',
  usage_count: 4,
  is_animated: false,
}

// Every query of remote_emojis_cache answers the one row.
function cacheQuery() {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'order', 'range', 'eq', 'is', 'not']) chain[method] = () => chain
  chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: [{ ...remote }], error: null, count: 1 })
  return chain
}

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.mocked(supabase.from).mockImplementation(() => cacheQuery() as never)
  rpc.mockReset()
})

async function importOne() {
  const w = mount(EmojiImporter, { global: { mocks: { $t: (key: string) => key } } })
  await flushPromises()
  await w.get('.import-btn').trigger('click')
  await w.get('.confirm-btn').trigger('click')
  await flushPromises()
  return w
}

describe('EmojiImporter', () => {
  it('emits imported after an import', async () => {
    rpc.mockResolvedValue({ data: 'local-id', error: null })
    const w = await importOne()
    expect(rpc).toHaveBeenCalledWith('import_remote_emoji', { p_remote_emoji_id: 'r1', p_new_name: null })
    expect(w.emitted('imported')).toHaveLength(1)
  })

  it('emits nothing when the import is refused', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'denied' } })
    const w = await importOne()
    expect(w.emitted('imported')).toBeUndefined()
  })
})
