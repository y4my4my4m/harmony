import { describe, it, expect, vi, beforeEach } from 'vitest'

// POST /resolve-reply-parents (activitypub/replyParents.ts): which replies have their parent
// fetched, how a failure is remembered, and how replies are linked.

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../utils/ssrfProtection.js', () => ({
  validateExternalUrl: (url: string) => {
    if (!url.startsWith('https://')) throw new Error('disallowed')
    return new URL(url)
  },
}))

const { resolveReplyParents, resetReplyParentFailures, FAILURE_TTL_MS, MAX_REPLY_PARENT_POSTS } =
  await import('../activitypub/replyParents.js')

type Row = { id: string; in_reply_to: string | null; metadata: Record<string, unknown> }

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const PARENT = { id: id(900), conversation_root_id: null }

function reader(rows: Row[]) {
  const reads: string[][] = []
  return {
    reads,
    client: {
      from() {
        return {
          select() {
            return {
              in(_col: string, ids: string[]) {
                reads.push(ids)
                return Promise.resolve({ data: rows.filter((r) => ids.includes(r.id)), error: null })
              },
            }
          },
        }
      },
    } as any,
  }
}

function writer() {
  const updates: Array<{ values: Record<string, unknown>; ids: string[] }> = []
  return {
    updates,
    client: {
      from() {
        return {
          update(values: Record<string, unknown>) {
            return {
              in(_col: string, ids: string[]) {
                return {
                  is() {
                    updates.push({ values, ids })
                    return Promise.resolve({ error: null })
                  },
                }
              },
            }
          },
        }
      },
    } as any,
  }
}

const orphan = (n: number, url: string): Row => ({ id: id(n), in_reply_to: null, metadata: { in_reply_to_ap_url: url } })

beforeEach(() => resetReplyParentFailures())

describe('resolveReplyParents', () => {
  it('fetches each waiting parent once and links every reply naming it', async () => {
    const url = 'https://remote.example/users/a/statuses/1'
    const r = reader([orphan(1, url), orphan(2, url), { id: id(3), in_reply_to: id(800), metadata: {} }])
    const w = writer()
    const fetchParent = vi.fn(async () => PARENT)
    const results = await resolveReplyParents([id(1), id(2), id(3), id(4)], r.client, w.client, fetchParent)

    expect(fetchParent).toHaveBeenCalledTimes(1)
    expect(fetchParent).toHaveBeenCalledWith(url)
    expect(w.updates).toEqual([{ values: { in_reply_to: PARENT.id, conversation_root_id: PARENT.id }, ids: [id(1), id(2)] }])
    expect(results).toEqual({ [id(1)]: 'linked', [id(2)]: 'linked', [id(3)]: 'linked', [id(4)]: 'none' })
  })

  it('takes the root of a parent that is itself a reply', async () => {
    const r = reader([orphan(1, 'https://remote.example/n/2')])
    const w = writer()
    await resolveReplyParents([id(1)], r.client, w.client, async () => ({ id: id(901), conversation_root_id: id(902) }))
    expect(w.updates[0].values).toEqual({ in_reply_to: id(901), conversation_root_id: id(902) })
  })

  it('remembers a failed fetch for FAILURE_TTL_MS', async () => {
    const url = 'https://gone.example/users/a/statuses/1'
    const r = reader([orphan(1, url)])
    const w = writer()
    const fetchParent = vi.fn(async () => null)
    let clock = 1_000_000
    const now = () => clock

    expect(await resolveReplyParents([id(1)], r.client, w.client, fetchParent, now)).toEqual({ [id(1)]: 'unavailable' })
    clock += FAILURE_TTL_MS - 1
    expect(await resolveReplyParents([id(1)], r.client, w.client, fetchParent, now)).toEqual({ [id(1)]: 'unavailable' })
    expect(fetchParent).toHaveBeenCalledTimes(1)
    clock += 2
    await resolveReplyParents([id(1)], r.client, w.client, fetchParent, now)
    expect(fetchParent).toHaveBeenCalledTimes(2)
    expect(w.updates).toEqual([])
  })

  it('fetches nothing for a disallowed URL, an unreadable post or a post that is no reply', async () => {
    const r = reader([orphan(1, 'http://10.0.0.1/n/1'), { id: id(2), in_reply_to: null, metadata: {} }])
    const fetchParent = vi.fn(async () => PARENT)
    const results = await resolveReplyParents([id(1), id(2), id(3)], r.client, writer().client, fetchParent)
    expect(fetchParent).not.toHaveBeenCalled()
    expect(results).toEqual({ [id(1)]: 'unavailable', [id(2)]: 'none', [id(3)]: 'none' })
  })

  it('reads at most MAX_REPLY_PARENT_POSTS valid ids', async () => {
    const r = reader([])
    const ids = Array.from({ length: MAX_REPLY_PARENT_POSTS + 5 }, (_, i) => id(i + 1))
    const results = await resolveReplyParents([...ids, 'not-a-uuid', 7], r.client, writer().client, vi.fn())
    expect(r.reads).toEqual([ids.slice(0, MAX_REPLY_PARENT_POSTS)])
    expect(Object.keys(results)).toHaveLength(MAX_REPLY_PARENT_POSTS)
  })

  it('shares one fetch between concurrent requests', async () => {
    const url = 'https://slow.example/n/1'
    let release!: (p: typeof PARENT) => void
    const fetchParent = vi.fn(() => new Promise<typeof PARENT>((resolve) => { release = resolve }))
    const a = resolveReplyParents([id(1)], reader([orphan(1, url)]).client, writer().client, fetchParent)
    const b = resolveReplyParents([id(2)], reader([orphan(2, url)]).client, writer().client, fetchParent)
    await vi.waitFor(() => expect(fetchParent).toHaveBeenCalledTimes(1))
    release(PARENT)
    expect(await a).toEqual({ [id(1)]: 'linked' })
    expect(await b).toEqual({ [id(2)]: 'linked' })
    expect(fetchParent).toHaveBeenCalledTimes(1)
  })
})
