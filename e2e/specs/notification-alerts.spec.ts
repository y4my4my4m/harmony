// Journey: one alert per notification, on the surface the window's state calls for.
//
//   - focused and shown: the in-app toast and the app's sound, no system notification;
//   - shown but not focused, or hidden: one system notification, no toast, and still one sound;
//   - the first notification of a session sounds, from audio decoded before it arrived: no sound
//     file is requested once the notification is in, even over a slow link;
//   - the per-type sound setting holds the sound back, in the app and in the system notification;
//     on a phone's hidden page the system notification carries the sound;
//   - the chat category's switch does not turn off Fediverse system notifications;
//   - a reply or a mention in the thread shown full page writes no notification, as a message in
//     the open channel does, and one delivered anyway alerts nothing; opening the thread reads its
//     notifications.
//
// The notification is real: a second user favourites the reader's post and the database
// writes the activitypub_favorite row, as for a like from another instance. The stack has no
// Realtime: the row is handed to the client's user event channel as notification:new, the
// payload broadcast_notification_event sends.
//
// Window focus and visibility are the page's own answers (document.hasFocus,
// document.visibilityState), set from the test. System notifications are read back from the
// service worker registration, which shows them whether the page or a push asked; sounds are
// counted where they start: AudioBufferSourceNode.start and HTMLMediaElement.play.

import { test, expect, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import {
  addMember, adminClient, createUser, deleteUser, dismissAnnouncements, seedServer, signIn, userClient, type SpecUser,
} from './harness'

test.use({
  permissions: ['notifications'],
  ...(process.env.PW_BUNDLED ? { channel: 'chromium' } : {}),
})

const admin = adminClient()
const readers: SpecUser[] = []
let liker: SpecUser

test.beforeAll(async () => {
  liker = await createUser(admin, 'alrl')
})

test.afterAll(async () => {
  for (const reader of readers) await deleteUser(admin, reader)
  await deleteUser(admin, liker)
})

/** Attention stubs and alert counters, installed before the app's scripts run. */
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as any
    const state = { focused: true, hidden: false }
    w.__alerts = { sounds: [] as Array<{ at: number; via: string }>, constructed: [] as string[], toasts: 0 }
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.classList.contains('notification-toast')) w.__alerts.toasts++
        }
      }
    }).observe(document, { childList: true, subtree: true })
    Document.prototype.hasFocus = function () { return state.focused }
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => (state.hidden ? 'hidden' : 'visible') })
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => state.hidden })
    w.__setAttention = (focused: boolean, hidden: boolean) => {
      state.focused = focused
      state.hidden = hidden
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event(focused ? 'focus' : 'blur'))
    }

    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      const result = play.call(this)
      result.then(() => w.__alerts.sounds.push({ at: performance.now(), via: 'media' })).catch(() => {})
      return result
    }
    if (typeof AudioBufferSourceNode !== 'undefined') {
      const start = AudioBufferSourceNode.prototype.start
      AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...args: any[]) {
        if (this.context.state === 'running') w.__alerts.sounds.push({ at: performance.now(), via: 'webaudio' })
        return (start as any).apply(this, args)
      }
    }
    const Native = window.Notification
    if (Native) {
      const Wrapped = function (this: unknown, title: string, options?: NotificationOptions) {
        w.__alerts.constructed.push(title)
        return new Native(title, options)
      } as unknown as typeof Notification
      Object.defineProperty(Wrapped, 'permission', { get: () => Native.permission })
      Wrapped.requestPermission = Native.requestPermission.bind(Native)
      w.Notification = Wrapped
    }
  })
}

const setAttention = (page: Page, focused: boolean, hidden: boolean) =>
  page.evaluate(([f, h]) => (window as any).__setAttention(f, h), [focused, hidden] as const)

const sounds = (page: Page) => page.evaluate(() => (window as any).__alerts.sounds as Array<{ at: number; via: string }>)

/** System notifications this origin shows, by notification id, with their silent flag. */
const systemNotifications = (page: Page) => page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready
  const shown = (await reg.getNotifications()).map((n) => ({ id: n.data?.notification_id as string, silent: n.silent }))
  return [...shown, ...((window as any).__alerts.constructed as string[]).map(() => ({ id: '', silent: null }))]
})

/** Toasts shown since the page loaded, expired ones included. */
const toastsShown = (page: Page) => page.evaluate(() => (window as any).__alerts.toasts as number)

let postSeq = 0

/** A post by the reader, favourited by the liker: the database writes the notification. */
async function favouriteNotification(reader: SpecUser): Promise<Record<string, unknown>> {
  postSeq++
  const { data: post, error } = await admin.from('posts')
    .insert({ author_id: reader.id, visibility: 'public', is_local: true, content: [{ type: 'text', text: `alert post ${postSeq}` }] })
    .select('id').single()
  if (error || !post) throw new Error(`post: ${error?.message}`)
  const client = await userClient(liker)
  const liked = await client.from('post_interactions').insert({ post_id: post.id, user_id: liker.id, interaction_type: 'favorite' })
  if (liked.error) throw new Error(`favourite: ${liked.error.message}`)
  let row: Record<string, unknown> | null = null
  await expect.poll(async () => {
    const { data } = await admin.from('notifications')
      .select('id, type, data, is_read, is_clicked, created_at, updated_at, user_id, expires_at')
      .eq('user_id', reader.id).eq('type', 'activitypub_favorite')
      .eq('data->>post_id', post.id).maybeSingle()
    row = data
    return row !== null
  }, { timeout: 15000 }).toBe(true)
  return row!
}

/** What Realtime would deliver on user:<reader>: the module instance the app loaded. */
const handlerCount = (page: Page, notification: Record<string, unknown> | null, dispatch: boolean) =>
  page.evaluate(async ({ notification, dispatch }) => {
    const url = performance.getEntriesByType('resource').map((e) => e.name)
      .find((name) => name.includes('/src/services/UserEventChannel.ts'))
    if (!url) return 0
    const channel = (await import(/* @vite-ignore */ url)).userEventChannel as any
    const handlers = channel.handlers.get('notification:new')?.size ?? 0
    if (dispatch && handlers > 0) {
      ;(window as any).__deliveredAt = performance.now()
      channel.dispatch({ type: 'notification:new', notification })
    }
    return handlers
  }, { notification, dispatch })

async function waitForHandler(page: Page): Promise<void> {
  await expect.poll(() => handlerCount(page, null, false), { timeout: 30000, message: 'a notification:new handler' }).toBeGreaterThan(0)
}

async function deliver(page: Page, notification: Record<string, unknown>): Promise<void> {
  await waitForHandler(page)
  await handlerCount(page, notification, true)
}

const deliveredAt = (page: Page) => page.evaluate(() => (window as any).__deliveredAt as number)

async function setPreferences(reader: SpecUser, values: Record<string, boolean>) {
  const { error } = await admin.from('notification_preferences').update(values).eq('user_id', reader.id)
  if (error) throw new Error(`preferences: ${error.message}`)
}

/**
 * A reader whose favourites alert on every surface, signed in on a reloaded page: the reload
 * leaves no user activation, and the click that follows gives it, as a person's first click does.
 */
async function openAsReader(page: Page, tag: string): Promise<SpecUser> {
  const reader = await createUser(admin, tag)
  readers.push(reader)
  await setPreferences(reader, { activitypub_desktop_favorites: true, activitypub_sound_favorites: true })
  await instrument(page)
  await signIn(page, reader)
  await page.goto('/social/home')
  await dismissAnnouncements(page)
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  await waitForHandler(page)
  await page.waitForLoadState('networkidle')
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  return reader
}

test('focused: the first notification of a session shows a toast and sounds at once, with no system notification', async ({ page, context }) => {
  test.setTimeout(120_000)
  const reader = await openAsReader(page, 'alrf')

  // A link as slow as the owner's to the origin: every request waits 400 ms.
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: -1, uploadThroughput: -1 })
  const soundRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/assets/sounds/')) soundRequests.push(request.url())
  })

  await deliver(page, await favouriteNotification(reader))
  await expect.poll(() => toastsShown(page), { timeout: 10000 }).toBe(1)
  await expect.poll(async () => (await sounds(page)).length, { timeout: 5000 }).toBe(1)
  const [first] = await sounds(page)
  const delay = first.at - (await deliveredAt(page))
  console.log(`first sound ${Math.round(delay)} ms after delivery via ${first.via}; sound requests after delivery: ${soundRequests.length}`)
  expect(soundRequests, 'no sound file is fetched to play the first notification').toEqual([])
  expect(delay).toBeLessThan(300)
  await page.waitForTimeout(1000)
  expect(await systemNotifications(page)).toEqual([])
  expect((await sounds(page)).length).toBe(1)
})

test('shown but not focused: one silent system notification, the app sound, no toast', async ({ page }) => {
  test.setTimeout(120_000)
  const reader = await openAsReader(page, 'alru')
  await setAttention(page, false, false)
  await deliver(page, await favouriteNotification(reader))
  await expect.poll(async () => (await systemNotifications(page)).length, { timeout: 10000 }).toBe(1)
  expect((await systemNotifications(page))[0].silent).toBe(true)
  await expect.poll(async () => (await sounds(page)).length, { timeout: 5000 }).toBe(1)
  await page.waitForTimeout(1500)
  expect(await toastsShown(page)).toBe(0)
  expect(await systemNotifications(page)).toHaveLength(1)
  expect((await sounds(page)).length).toBe(1)
})

test('hidden: one system notification and one sound, no toast', async ({ page }) => {
  test.setTimeout(120_000)
  const reader = await openAsReader(page, 'alrh')
  await setAttention(page, false, true)
  await deliver(page, await favouriteNotification(reader))
  await expect.poll(async () => (await systemNotifications(page)).length, { timeout: 10000 }).toBe(1)
  await expect.poll(async () => (await sounds(page)).length, { timeout: 5000 }).toBe(1)
  await page.waitForTimeout(1500)
  await setAttention(page, true, false)
  expect(await toastsShown(page)).toBe(0)
  expect(await systemNotifications(page)).toHaveLength(1)
  expect((await sounds(page)).length).toBe(1)
})

test('the per-type sound setting holds the sound back, in the app and in the system notification', async ({ page }) => {
  test.setTimeout(120_000)
  const reader = await openAsReader(page, 'alrs')
  await setPreferences(reader, { activitypub_sound_favorites: false })
  await page.evaluate(async () => {
    const root = document.querySelector('#app') as any
    const store = root.__vue_app__.config.globalProperties.$pinia._s.get('notification')
    await store.loadPreferences(store.cachedProfileId)
  })

  await test.step('sound off for favourites: the toast, no sound', async () => {
    await deliver(page, await favouriteNotification(reader))
    await expect.poll(() => toastsShown(page), { timeout: 10000 }).toBe(1)
    await page.waitForTimeout(1500)
    expect((await sounds(page)).length).toBe(0)
  })

  await test.step('sound off for favourites, window not focused: the system notification is silent too', async () => {
    await setAttention(page, false, true)
    await deliver(page, await favouriteNotification(reader))
    await expect.poll(async () => (await systemNotifications(page)).length, { timeout: 10000 }).toBe(1)
    expect((await systemNotifications(page))[0].silent).toBe(true)
    expect((await sounds(page)).length).toBe(0)
  })
})

test('the chat category switch leaves Fediverse system notifications on', async ({ page }) => {
  test.setTimeout(120_000)
  const reader = await openAsReader(page, 'alrc')
  await setPreferences(reader, { desktop_notifications: false })
  await page.evaluate(async () => {
    const root = document.querySelector('#app') as any
    const store = root.__vue_app__.config.globalProperties.$pinia._s.get('notification')
    await store.loadPreferences(store.cachedProfileId)
  })
  await setAttention(page, false, true)
  await deliver(page, await favouriteNotification(reader))
  await expect.poll(async () => (await systemNotifications(page)).length, { timeout: 10000 }).toBe(1)
  await page.waitForTimeout(1000)
  expect(await toastsShown(page)).toBe(0)
})

/** Waits until a device of `reader` reports `threadId` shown full page. */
async function threadViewSynced(reader: SpecUser, threadId: string): Promise<void> {
  await expect.poll(async () => {
    const { data } = await admin.from('device_view_contexts').select('view_type, thread_id').eq('user_id', reader.id)
    return (data ?? []).some((row) => row.view_type === 'thread' && row.thread_id === threadId)
  }, { timeout: 15000, message: 'the thread view is synced' }).toBe(true)
}

test('a reply in the thread shown full page writes no notification; one delivered anyway alerts nothing', async ({ page }) => {
  test.setTimeout(120_000)
  const reader = await openAsReader(page, 'alrt')
  const server = await seedServer(admin, reader, `Alerts ${reader.username}`)
  await addMember(admin, liker, server.id)
  const parentId = crypto.randomUUID()
  const threadId = crypto.randomUUID()
  const parent = await admin.from('messages').insert({
    id: parentId, channel_id: server.generalChannelId, user_id: reader.id, content: [{ type: 'text', text: 'thread parent' }],
  })
  if (parent.error) throw new Error(`parent: ${parent.error.message}`)
  const thread = await admin.from('threads').insert({
    id: threadId, channel_id: server.generalChannelId, parent_message_id: parentId, name: `Thread ${reader.username}`, created_by: reader.id,
  })
  if (thread.error) throw new Error(`thread: ${thread.error.message}`)

  await page.goto(`/chat/${server.id}/thread/${threadId}`)
  await waitForHandler(page)
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await threadViewSynced(reader, threadId)

  const client = await userClient(liker)
  const reply = await client.from('messages').insert({
    channel_id: server.generalChannelId, thread_id: threadId, user_id: liker.id, content: [{ type: 'text', text: 'a reply here' }],
  }).select('id').single()
  if (reply.error || !reply.data) throw new Error(`reply: ${reply.error?.message}`)
  await page.waitForTimeout(1500)
  // The liker's first message also alerts the owner as newcomer_message, a server alert that no
  // viewed channel or thread holds back.
  const written = await admin.from('notifications').select('type')
    .eq('user_id', reader.id).eq('data->>message_id', reply.data.id).neq('type', 'newcomer_message')
  expect(written.data ?? [], 'notifications for a reply in the shown thread').toEqual([])

  // A row written before the view reached the database, as handle_thread_reply_notification writes it.
  const late = await admin.from('notifications').insert({
    user_id: reader.id, type: 'thread_reply', is_read: false,
    data: { thread: { id: threadId }, thread_id: threadId, message_id: reply.data.id, server_id: server.id, channel_id: server.generalChannelId },
  }).select('id, type, data, is_read, is_clicked, created_at, updated_at, user_id, expires_at').single()
  if (late.error || !late.data) throw new Error(`late row: ${late.error?.message}`)
  await deliver(page, late.data)
  await expect.poll(async () => {
    const { data } = await admin.from('notifications').select('is_read').eq('id', late.data.id).single()
    return data?.is_read
  }, { timeout: 10000, message: 'the reply\'s notification is read' }).toBe(true)
  await page.waitForTimeout(1000)
  expect(await toastsShown(page)).toBe(0)
  expect((await sounds(page)).length).toBe(0)
  expect(await systemNotifications(page)).toEqual([])
})

test('the thread shown full page: opening it reads its notifications, and nothing there notifies', async ({ page }) => {
  test.setTimeout(150_000)
  const reader = await openAsReader(page, 'alrm')
  const server = await seedServer(admin, reader, `Mentions ${reader.username}`)
  await addMember(admin, liker, server.id)
  const parentId = crypto.randomUUID()
  const threadId = crypto.randomUUID()
  const parent = await admin.from('messages').insert({
    id: parentId, channel_id: server.generalChannelId, user_id: reader.id, content: [{ type: 'text', text: 'thread parent' }],
  })
  if (parent.error) throw new Error(`parent: ${parent.error.message}`)
  const thread = await admin.from('threads').insert({
    id: threadId, channel_id: server.generalChannelId, parent_message_id: parentId, name: `Thread ${reader.username}`, created_by: reader.id,
  })
  if (thread.error) throw new Error(`thread: ${thread.error.message}`)

  const client = await userClient(liker)
  const mentionReader = async (text: string) => {
    const sent = await client.from('messages').insert({
      channel_id: server.generalChannelId, thread_id: threadId, user_id: liker.id,
      content: [{ type: 'mention', userId: reader.id, username: reader.username }, { type: 'text', text: ` ${text}` }],
    }).select('id').single()
    if (sent.error || !sent.data) throw new Error(`mention: ${sent.error?.message}`)
    return sent.data.id as string
  }
  const rowsFor = async (messageId: string) => {
    const { data } = await admin.from('notifications')
      .select('id, type, data, is_read, is_clicked, created_at, updated_at, user_id, expires_at')
      .eq('user_id', reader.id).eq('data->>message_id', messageId)
    return (data ?? []) as Array<Record<string, any>>
  }

  let before: Array<Record<string, any>> = []
  await test.step('away from the thread, a mention there notifies and names the thread', async () => {
    const id = await mentionReader('before you came')
    await expect.poll(async () => (before = await rowsFor(id)).length, { timeout: 15000 }).toBeGreaterThan(0)
    const mention = before.find((row) => row.type === 'mention')
    expect(mention, 'a mention row').toBeTruthy()
    expect.soft(mention?.data?.thread_id, 'the mention names its thread').toBe(threadId)
  })

  await test.step('opening the thread full page reads them', async () => {
    await page.goto(`/chat/${server.id}/thread/${threadId}`)
    await waitForHandler(page)
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await threadViewSynced(reader, threadId)
    await expect.configure({ soft: true }).poll(async () => {
      const { data } = await admin.from('notifications').select('is_read').in('id', before.map((row) => row.id))
      return (data ?? []).every((row) => row.is_read)
    }, { timeout: 10000, message: 'the thread\'s notifications are read' }).toBe(true)
  })

  await test.step('while it is shown, a mention there writes no notification', async () => {
    const id = await mentionReader('while you read')
    await page.waitForTimeout(1500)
    expect.soft((await rowsFor(id)).map((row) => row.type), 'notifications for a mention in the shown thread').toEqual([])
  })

  // A row written before the view reached the database, with the data the mention above carries.
  await test.step('one delivered anyway alerts nothing and is read', async () => {
    const mention = before.find((row) => row.type === 'mention')!
    const late = await admin.from('notifications')
      .insert({ user_id: reader.id, type: 'mention', data: mention.data, is_read: false })
      .select('id, type, data, is_read, is_clicked, created_at, updated_at, user_id, expires_at').single()
    if (late.error || !late.data) throw new Error(`late row: ${late.error?.message}`)
    await deliver(page, late.data)
    await expect.configure({ soft: true }).poll(async () => {
      const { data } = await admin.from('notifications').select('is_read').eq('id', late.data.id).single()
      return data?.is_read
    }, { timeout: 10000, message: 'the delivered mention is read' }).toBe(true)
    await page.waitForTimeout(1000)
    expect.soft(await toastsShown(page), 'toasts').toBe(0)
    expect.soft((await sounds(page)).length, 'sounds').toBe(0)
    expect.soft(await systemNotifications(page), 'system notifications').toEqual([])
  })
})

test.describe('on a phone', () => {
  test.use({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  })

  test('hidden: the system notification carries the sound, and stays silent when the type\'s sound is off', async ({ page }) => {
    test.setTimeout(120_000)
    const reader = await openAsReader(page, 'alrp')
    await setAttention(page, false, true)

    await test.step('sound on: one audible system notification, no app sound', async () => {
      await deliver(page, await favouriteNotification(reader))
      await expect.poll(async () => (await systemNotifications(page)).length, { timeout: 10000 }).toBe(1)
      expect((await systemNotifications(page))[0].silent).toBe(false)
      await page.waitForTimeout(1000)
      expect((await sounds(page)).length).toBe(0)
    })

    await test.step('sound off for favourites: the system notification is silent', async () => {
      await setPreferences(reader, { activitypub_sound_favorites: false })
      await page.evaluate(async () => {
        const root = document.querySelector('#app') as any
        const store = root.__vue_app__.config.globalProperties.$pinia._s.get('notification')
        await store.loadPreferences(store.cachedProfileId)
      })
      const muted = await favouriteNotification(reader)
      await deliver(page, muted)
      await expect.poll(async () => (await systemNotifications(page)).length, { timeout: 10000 }).toBe(2)
      expect((await systemNotifications(page)).find((n) => n.id === muted.id)?.silent).toBe(true)
      expect((await sounds(page)).length).toBe(0)
      expect(await toastsShown(page)).toBe(0)
    })
  })
})
