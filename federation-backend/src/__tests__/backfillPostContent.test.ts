import { describe, it, expect, vi } from 'vitest'
import type { FetchedDocument } from '../utils/apOrigin.js'

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', VERSION: 'test', NODE_ENV: 'test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))

const { backfillPostContent } = await import('../activitypub/backfillPostContent.js')

const AUTHOR = 'https://mastodon.test/users/kiwi'
const OTHER = 'https://mastodon.test/users/mallory'
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'

type Row = Record<string, any>

/** posts rows carry `author` as the embedded profile the select names. */
function fakeSupabase(rows: Row[]) {
  return {
    from() {
      const filters: Array<(row: Row) => boolean> = []
      let patch: Row | null = null
      let window: [number, number] = [0, Infinity]
      const builder: any = {
        select() { return builder },
        update(p: Row) { patch = p; return builder },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder },
        not(col: string, op: string, val: any) {
          if (op === 'is' && val === null) filters.push((row) => row[col] != null)
          return builder
        },
        order() { return builder },
        range(from: number, to: number) { window = [from, to]; return builder },
        then(resolve: any) {
          const matched = rows.filter((row) => filters.every((f) => f(row)))
          if (patch) {
            matched.forEach((row) => Object.assign(row, patch))
            return resolve({ data: matched, error: null })
          }
          return resolve({ data: matched.slice(window[0], window[1] + 1), error: null })
        },
      }
      return builder
    },
  } as any
}

const note = (id: string, attributedTo: string, text: string) =>
  ({ id, type: 'Note', attributedTo, to: [PUBLIC], content: `<p>${text}</p>` })

const post = (id: string, apId: string, extra: Row = {}) => ({
  id, ap_id: apId, is_local: false, is_deleted: false, content: [{ type: 'text', text: 'stored' }],
  metadata: {}, author: { federated_id: AUTHOR }, ...extra,
})

function run(rows: Row[], docs: Record<string, FetchedDocument>) {
  return backfillPostContent(fakeSupabase(rows), {
    dryRun: false,
    limit: 0,
    delayMs: 0,
    fetchDoc: async (url) => docs[url] ?? null,
  })
}

const text = (row: Row) => row.content.map((p: any) => p.text ?? '').join('')

describe('backfillPostContent', () => {
  it('rewrites a post its origin serves at its own id under its author', async () => {
    const id = `${AUTHOR}/statuses/1`
    const rows = [post('p1', id)]
    const totals = await run(rows, { [id]: { doc: note(id, AUTHOR, 'edited'), finalUrl: id } })
    expect(text(rows[0])).toBe('edited')
    expect(totals).toMatchObject({ processed: 1, updated: 1, failed: 0 })
  })

  it('leaves a moderator-deleted post deleted', async () => {
    const id = `${AUTHOR}/statuses/2`
    const rows = [post('p2', id, { is_deleted: true, content: [{ type: 'text', text: '[Deleted]' }] })]
    await run(rows, { [id]: { doc: note(id, AUTHOR, 'removed content'), finalUrl: id } })
    expect(text(rows[0])).toBe('[Deleted]')
  })

  it('refuses a document whose id is another post', async () => {
    const id = `${AUTHOR}/statuses/3`
    const rows = [post('p3', id)]
    const forged = `${AUTHOR}/statuses/999`
    await run(rows, { [id]: { doc: note(forged, AUTHOR, 'forged'), finalUrl: id } })
    expect(text(rows[0])).toBe('stored')
  })

  it('refuses a document served from another URL', async () => {
    const id = `${AUTHOR}/statuses/4`
    const rows = [post('p4', id)]
    await run(rows, { [id]: { doc: note(id, AUTHOR, 'redirected'), finalUrl: 'https://mastodon.test/uploads/x.json' } })
    expect(text(rows[0])).toBe('stored')
  })

  it('refuses a document attributed to another actor', async () => {
    const id = `${AUTHOR}/statuses/5`
    const rows = [post('p5', id)]
    await run(rows, { [id]: { doc: note(id, OTHER, 'hijacked'), finalUrl: id } })
    expect(text(rows[0])).toBe('stored')
  })

  it('refuses a document that is not a post', async () => {
    const id = `${AUTHOR}/statuses/6`
    const rows = [post('p6', id)]
    await run(rows, { [id]: { doc: { id, type: 'Person', content: '<p>actor</p>', attributedTo: AUTHOR }, finalUrl: id } })
    expect(text(rows[0])).toBe('stored')
  })
})
