/** Rows of one tick are read together, once, and only those with custom emojis are kept. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ calls: [] as { table: string; ids: string[]; filters: unknown[] }[], answer: (_table: string, _ids: string[]): { data: unknown; error: unknown } => ({ data: [], error: null }) }))
vi.mock('@/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const call = { table, ids: [] as string[], filters: [] as unknown[] }
      const query = {
        select: (columns: string) => { call.filters.push(columns); return query },
        in: (_column: string, ids: string[]) => { call.ids = ids; return query },
        eq: (...args: unknown[]) => { call.filters.push(args); return query },
        contains: (...args: unknown[]) => {
          call.filters.push(args)
          mocks.calls.push(call)
          return Promise.resolve(mocks.answer(table, call.ids))
        },
      }
      return query
    },
  },
}))
vi.mock('@/utils/debug', () => ({ debug: { warn: vi.fn() } }))

import { previewContent, requestPreviewContent, resetPreviewContent } from '../previewContent'

const content = [{ type: 'emoji', emoji: { id: 'e', name: 'pog', url: 'https://remote.example/pog.png' } }]
const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 5)) }

beforeEach(() => {
  resetPreviewContent()
  mocks.calls.length = 0
  mocks.answer = (_table, ids) => ({ data: ids.filter((id) => id.startsWith('m')).map((id) => ({ id, content })), error: null })
})

describe('previewContent', () => {
  it('reads the rows of one tick in one request per table, not the deleted ones nor those without emojis', async () => {
    for (const id of ['m1', 'm2', 'm1']) requestPreviewContent('message', id)
    requestPreviewContent('post', 'p1')
    expect(mocks.calls).toEqual([])
    await settle()
    expect(mocks.calls.map(({ table, ids }) => [table, ids])).toEqual([['messages', ['m1', 'm2']], ['posts', ['p1']]])
    expect(mocks.calls[0].filters).toEqual(['id, content', ['is_deleted', false], ['content', '[{"type":"emoji"}]']])
    expect(previewContent('message', 'm1')).toEqual(content)
    expect(previewContent('post', 'p1')).toBeNull()
  })

  it('asks for no row twice, found or not', async () => {
    requestPreviewContent('message', 'm1')
    requestPreviewContent('message', 'x1')
    await settle()
    requestPreviewContent('message', 'm1')
    requestPreviewContent('message', 'x1')
    await settle()
    expect(mocks.calls).toHaveLength(1)
  })

  it('asks for no row that is being read', async () => {
    let answer!: () => void
    const held = new Promise<void>((resolve) => { answer = resolve })
    mocks.answer = ((_table: string, ids: string[]) => held.then(() => ({ data: ids.map((id) => ({ id, content })), error: null }))) as unknown as typeof mocks.answer
    requestPreviewContent('message', 'm1')
    await settle()
    requestPreviewContent('message', 'm1')
    await settle()
    expect(mocks.calls).toHaveLength(1)
    answer()
    await settle()
    expect(previewContent('message', 'm1')).toEqual(content)
  })

  it('splits many rows into requests of forty', async () => {
    for (let i = 0; i < 95; i++) requestPreviewContent('message', `m${i}`)
    await settle()
    expect(mocks.calls.map((call) => call.ids.length)).toEqual([40, 40, 15])
  })

  it('asks again after a failed read', async () => {
    mocks.answer = () => ({ data: null, error: { message: 'offline' } })
    requestPreviewContent('message', 'm1')
    await settle()
    expect(previewContent('message', 'm1')).toBeNull()
    mocks.answer = (_table, ids) => ({ data: ids.map((id) => ({ id, content })), error: null })
    requestPreviewContent('message', 'm1')
    await settle()
    expect(previewContent('message', 'm1')).toEqual(content)
  })
})
