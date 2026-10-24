// Encrypted rooms with history from before a member joined, for the key relay and history
// visibility journeys.
//
// Ava posts while Ben is in the channel, so Ben holds Ava's session. Both go offline: their
// pages close, their browser profiles (IndexedDB keys) stay. Cleo joins, sets up encryption
// and has asked for the sessions on screen. The stack runs no realtime: requests and answers
// travel through the unlock sweeps.

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  addMember,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  openChannel,
  seedServer,
  sendMessage,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'
import { setUpEncryption } from './encryption'

export type HistoryVisibility = 'all' | 'pinned' | 'none'

/** Users and browser profiles of one spec file, removed in afterAll. */
export class Cast {
  private users: SpecUser[] = []
  private contexts: BrowserContext[] = []

  constructor(private admin: SupabaseClient) {}

  async actor(tag: string): Promise<SpecUser> {
    const user = await createUser(this.admin, tag)
    this.users.push(user)
    return user
  }

  async profile(browser: Browser, options?: BrowserContextOptions): Promise<BrowserContext> {
    const context = await browser.newContext(options)
    this.contexts.push(context)
    return context
  }

  async cleanup(): Promise<void> {
    for (const context of this.contexts) await context.close().catch(() => {})
    for (const user of this.users) await deleteUser(this.admin, user)
  }
}

export const item = (page: Page, text: string) =>
  messageList(page).locator('.message-item').filter({ hasText: text })

// Columns past sender_user_id are absent on a server before 20261028100001.
export interface KeyRequestRow {
  id: string
  sender_user_id: string
  session_id: string
  status: string
  fulfilled_by_user_id?: string | null
  message_id?: string | null
  key_scope?: string | null
}

export async function requestsOf(admin: SupabaseClient, requester: SpecUser): Promise<KeyRequestRow[]> {
  const { data, error } = await admin
    .from('megolm_key_requests')
    .select('*')
    .eq('requester_user_id', requester.id)
    .order('created_at')
  if (error) throw new Error(`key requests: ${error.message}`)
  return (data ?? []) as KeyRequestRow[]
}

/** Requests the user may answer now, as their app's unlock sweep lists them. */
export async function relayableFor(user: SpecUser): Promise<Array<{ id: string; key_scope: string }>> {
  const client = await userClient(user)
  const { data, error } = await client.rpc('get_relayable_key_requests')
  if (error) throw new Error(`relayable requests: ${error.message}`)
  return data ?? []
}

export async function setHistoryVisibility(owner: SpecUser, channelId: string, value: HistoryVisibility): Promise<void> {
  const client = await userClient(owner)
  const { error } = await client.rpc('set_channel_history_visibility', {
    p_channel_id: channelId,
    p_history_visibility: value,
  })
  if (error) throw new Error(`history visibility: ${error.message}`)
}

export interface History {
  server: SeededServer
  ava: SpecUser
  ben: SpecUser
  cleo: SpecUser
  avaTexts: string[]
  avaMessageIds: string[]
  benText: string | null
  avaProfile: BrowserContext
  benProfile: BrowserContext
  cleoPage: Page
}

export interface HistoryOptions {
  visibility?: HistoryVisibility
  /** Ava's messages, sent in one session. Default: one message. */
  avaTexts?: (ava: SpecUser) => string[]
  /** Index into avaTexts of the message Ava pins. */
  pinned?: number
  benPosts?: boolean
  /** Browser profile options per actor, e.g. a baseURL serving another build of the app. */
  contexts?: Partial<Record<'ava' | 'ben' | 'cleo', BrowserContextOptions>>
}

/**
 * Ava posts (and pins) in an encrypted channel Ben is in, Ben reads it and, when `benPosts`,
 * posts too. Ava and Ben go offline. Cleo joins, sets up encryption and has asked for every
 * session on screen.
 */
export async function historyBeforeJoin(
  admin: SupabaseClient,
  cast: Cast,
  browser: Browser,
  tag: string,
  options: HistoryOptions = {},
): Promise<History> {
  const ava = await cast.actor(`${tag}ava`)
  const ben = await cast.actor(`${tag}ben`)
  const cleo = await cast.actor(`${tag}cleo`)
  const server = await seedServer(admin, ava, `Key relay ${ava.username}`)
  await addMember(admin, ben, server.id)
  const { error } = await admin
    .from('server_encryption_settings')
    .upsert({ server_id: server.id, encryption_mode: 'required' }, { onConflict: 'server_id' })
  if (error) throw new Error(`encryption floor: ${error.message}`)
  if (options.visibility) await setHistoryVisibility(ava, server.generalChannelId, options.visibility)

  const avaTexts = options.avaTexts?.(ava) ?? [`ava pinned before cleo ${ava.username}`]
  const pinned = options.pinned ?? 0
  const benText = options.benPosts ? `ben before cleo ${ben.username}` : null
  const avaMessageIds: string[] = []

  const benProfile = await cast.profile(browser, options.contexts?.ben)
  const benPage = await benProfile.newPage()

  await test.step('Ben sets up encryption in the channel', async () => {
    await signIn(benPage, ben)
    await openChannel(benPage, server.id, server.generalChannelId)
    await setUpEncryption(benPage, ben)
  })

  const avaProfile = await cast.profile(browser, options.contexts?.ava)
  const avaPage = await avaProfile.newPage()

  await test.step('Ava posts encrypted messages and pins one', async () => {
    await signIn(avaPage, ava)
    await openChannel(avaPage, server.id, server.generalChannelId)
    await setUpEncryption(avaPage, ava)
    for (const text of avaTexts) {
      const posted = await sendMessage(avaPage, text)
      avaMessageIds.push((await posted.getAttribute('data-message-id'))!)
    }
    const { data, error: rowError } = await admin
      .from('messages')
      .select('encrypted, encryption_metadata')
      .in('id', avaMessageIds)
    if (rowError) throw new Error(`stored rows: ${rowError.message}`)
    expect(data!.every((row) => row.encrypted)).toBe(true)
    expect(new Set(data!.map((row) => row.encryption_metadata?.session_id)).size).toBe(1)
    const asAva = await userClient(ava)
    const { error: pinError } = await asAva.rpc('pin_message', { p_message_id: avaMessageIds[pinned] })
    if (pinError) throw new Error(`pin: ${pinError.message}`)
  })

  await test.step('Ava goes offline', async () => {
    await avaPage.close()
  })

  await test.step("Ben reads Ava's messages and goes offline", async () => {
    await benPage.reload()
    await dismissAnnouncements(benPage)
    for (const text of avaTexts) await expect(item(benPage, text)).toHaveCount(1, { timeout: 30000 })
    if (benText) await sendMessage(benPage, benText)
    await benPage.close()
  })

  const cleoProfile = await cast.profile(browser, options.contexts?.cleo)
  const cleoPage = await cleoProfile.newPage()

  await test.step('Cleo joins, sets up encryption and asks for the sessions on screen', async () => {
    await addMember(admin, cleo, server.id)
    await signIn(cleoPage, cleo)
    await openChannel(cleoPage, server.id, server.generalChannelId)
    await setUpEncryption(cleoPage, cleo)
    await cleoPage.reload()
    await dismissAnnouncements(cleoPage)
    await expect(messageList(cleoPage)).toBeVisible({ timeout: 30000 })
    for (const text of avaTexts) await expect(item(cleoPage, text)).toHaveCount(0)
    const senders = benText ? [ava.id, ben.id] : [ava.id]
    await expect
      .poll(async () => [...new Set((await requestsOf(admin, cleo)).map((r) => r.sender_user_id))].sort(), { timeout: 30000 })
      .toEqual(senders.sort())
  })

  return { server, ava, ben, cleo, avaTexts, avaMessageIds, benText, avaProfile, benProfile, cleoPage }
}

const swept = (page: Page) =>
  page.waitForResponse((r) => r.url().includes('/rpc/get_relayable_key_requests'), { timeout: 60000 })

/** Opens the user's app again in their profile; resolves once its unlock sweep has listed requests. */
export async function comeBack(profile: BrowserContext, path = '/chat'): Promise<Page> {
  const page = await profile.newPage()
  const listed = swept(page)
  await page.goto(path)
  await dismissAnnouncements(page)
  await listed
  return page
}

/** Reloads an open app; resolves once its unlock sweep has listed requests. */
export async function sweepAgain(page: Page): Promise<void> {
  const listed = swept(page)
  await page.reload()
  await dismissAnnouncements(page)
  await listed
}

export async function openPins(page: Page, count: number) {
  const label = count === 1 ? '1 pinned message' : `${count} pinned messages`
  await page.locator('.chat-header').getByRole('button', { name: label }).click()
  const pins = page.getByRole('dialog', { name: 'Pinned messages' })
  await expect(pins).toBeVisible({ timeout: 10000 })
  return pins
}
