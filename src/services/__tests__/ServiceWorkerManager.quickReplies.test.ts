import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Quick replies the service worker queued: each is sent only as the account it was typed for,
// and a sign-out empties the queue.

const h = vi.hoisted(() => ({
  profileId: 'p-b',
  token: '',
  sent: [] as Array<{ conversationId: string; text: string }>,
}))

vi.mock('@/router', () => ({ default: { push: vi.fn() } }))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    isLoggedIn: true,
    get session() { return { access_token: h.token } },
    decodeJWT: (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()),
  }),
}))
vi.mock('@/services', () => ({
  messageService: {
    sendDMMessage: vi.fn(async (conversationId: string, content: Array<{ text: string }>) => {
      h.sent.push({ conversationId, text: content[0].text })
    }),
    sendChannelMessage: vi.fn(),
  },
}))
vi.mock('@/services/AuthContextService', () => ({
  authContextService: { getCurrentProfileId: async () => h.profileId },
}))
// The signed-in user's data, which messageService sends as; it loads after sign-in.
const userData = vi.hoisted(() => {
  const target = new EventTarget() as EventTarget & { current: { id: string } | null; getCurrentUser: () => { id: string } | null }
  target.current = { id: 'p-b' }
  target.getCurrentUser = () => target.current
  return target
})
vi.mock('@/services/userDataService', () => ({ userDataService: userData }))
vi.mock('@/stores/useNotification', () => ({
  useNotificationStore: () => ({ notifications: [], markManyAsRead: vi.fn(), markAsRead: vi.fn() }),
}))

import { forgetQuickReplies, serviceWorkerManager } from '@/services/ServiceWorkerManager'

/** An access token whose session signed in at `seconds` (GoTrue's amr timestamp). */
const tokenSignedInAt = (seconds: number) =>
  ['e30', Buffer.from(JSON.stringify({ amr: [{ method: 'password', timestamp: seconds }] })).toString('base64url'), 'sig'].join('.')

function store<T>(mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('harmony-sw', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('pending-quick-replies', { keyPath: 'id', autoIncrement: true })
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const request = work(db.transaction('pending-quick-replies', mode).objectStore('pending-quick-replies'))
      request.onsuccess = () => { db.close(); resolve(request.result) }
      request.onerror = () => reject(request.error)
    }
  })
}

const queue = async (...entries: Array<Record<string, unknown>>) => {
  for (const entry of entries) await store('readwrite', (s) => s.add(entry))
}
const queued = () => store<any[]>('readonly', (s) => s.getAll())
const reply = (text: string, extra: Record<string, unknown>) =>
  ({ replyText: text, data: { conversation_id: 'c1' }, queuedAt: 5_000_000, ...extra })

beforeEach(async () => {
  await forgetQuickReplies()
  h.sent.length = 0
  h.profileId = 'p-b'
  h.token = tokenSignedInAt(1000)
  userData.current = { id: 'p-b' }
})

describe('quick reply queue', () => {
  it('sends a reply only as the account its notification was for', async () => {
    await queue(reply('mine', { account: 'p-b' }), reply('theirs', { account: 'p-a' }))
    await serviceWorkerManager.drainQuickReplyQueue()
    expect(h.sent).toEqual([{ conversationId: 'c1', text: 'mine' }])
    expect(await queued()).toEqual([])
  })

  it('sends a reply naming no account only when it was queued during this session', async () => {
    // Signed in during second 1000: a reply queued within that second may predate the sign-in.
    await queue(reply('before sign-in', { queuedAt: 999_000 }), reply('same second', { queuedAt: 1_000_500 }),
      reply('during', { queuedAt: 1_001_000 }))
    await serviceWorkerManager.drainQuickReplyQueue()
    expect(h.sent.map(s => s.text)).toEqual(['during'])
    expect(await queued()).toEqual([])
  })

  it('a session whose sign-in time is unknown sends no reply naming no account', async () => {
    h.token = ['e30', Buffer.from('{}').toString('base64url'), 'sig'].join('.')
    await queue(reply('unknown', {}), reply('mine', { account: 'p-b' }))
    await serviceWorkerManager.drainQuickReplyQueue()
    expect(h.sent.map(s => s.text)).toEqual(['mine'])
  })

  it('a reply drained before the user data loads is sent once it loads, with no other trigger', async () => {
    userData.current = null
    await queue(reply('early', { account: 'p-b' }), reply('theirs', { account: 'p-a' }))
    await serviceWorkerManager.drainQuickReplyQueue()
    expect(h.sent).toEqual([])
    expect((await queued()).map(e => e.replyText)).toEqual(['early'])

    userData.current = { id: 'p-b' }
    userData.dispatchEvent(new Event('initialized'))
    await vi.waitFor(() => expect(h.sent.map(s => s.text)).toEqual(['early']))
    expect(await queued()).toEqual([])
  })

  it('a drain asked for while one runs runs once more when it ends', async () => {
    await queue(reply('first', { account: 'p-b' }))
    const running = serviceWorkerManager.drainQuickReplyQueue()
    await queue(reply('second', { account: 'p-b' }))
    await serviceWorkerManager.drainQuickReplyQueue()
    await running
    expect(h.sent.map(s => s.text)).toEqual(['first', 'second'])
  })

  it('a sign-out empties the queue', async () => {
    await queue(reply('mine', { account: 'p-b' }))
    await forgetQuickReplies()
    expect(await queued()).toEqual([])
  })
})
