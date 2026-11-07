// Journey: a link to an account of this instance, or one it knows, shows a profile card in chat:
// avatar, display name, full handle @user@domain, bio and counts, with Follow and Open profile.
// /@user, /social/profile/<name> and /@user@domain each show one. The database previews the
// instance's own domain (fetch_link_preview, migration 20261107200001); a link on another host
// of the instance, the browser's origin here, gets the card from the account the app reads.
// /@user/<post id> is a post card. A suspended account shows no profile, only that it is
// unavailable.
//
// E2E instance_config domain is localhost and the app is served from localhost:<port>: an
// http://localhost/ link is the domain the database previews, the origin's link is not.

import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
const REMOTE_DOMAIN = 'remote.example'
let owner: SpecUser
let reader: SpecUser
let alice: SpecUser
let gone: SpecUser
let server: SeededServer
let postId = ''
const bob = { id: randomUUID(), username: `bob${Date.now().toString(36)}` }

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

async function seedMessage(text: string, url: string, minutes: number): Promise<void> {
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: owner.id,
    content: [{ type: 'text', text: `${text} ` }, { type: 'url', url, preview: true }],
    created_at: minutesAgo(minutes),
  })
  if (error) throw new Error(`message ${text}: ${error.message}`)
}

const row = (page: Page, text: string) => messageList(page).locator('.message-item').filter({ hasText: text }).last()
const card = (page: Page, text: string) => row(page, text).getByTestId('profile-embed')

test.beforeAll(async () => {
  test.setTimeout(120_000)
  owner = await createUser(admin, 'ple')
  reader = await createUser(admin, 'plr')
  alice = await createUser(admin, 'pla')
  gone = await createUser(admin, 'plg')
  server = await seedServer(admin, owner, `Profile links ${owner.username}`)
  await addMember(admin, reader, server.id)

  const profile = await admin.from('profiles')
    .update({ display_name: 'Ada Profile', bio: 'Painter of <b>night</b> skies over the harbour.' })
    .eq('id', alice.id)
  if (profile.error) throw new Error(`alice: ${profile.error.message}`)
  const suspended = await admin.from('profiles').update({ is_suspended: true, suspended_at: new Date().toISOString() }).eq('id', gone.id)
  if (suspended.error) throw new Error(`gone: ${suspended.error.message}`)

  const actor = `https://${REMOTE_DOMAIN}/users/${bob.username}`
  const remote = await admin.from('profiles').insert({
    id: bob.id,
    username: bob.username,
    display_name: 'Bob Faraway',
    bio: '<p>Writes from the <a href="https://remote.example">coast</a>.</p>',
    domain: REMOTE_DOMAIN,
    is_local: false,
    federated_id: actor,
    inbox_url: `${actor}/inbox`,
    outbox_url: `${actor}/outbox`,
  })
  if (remote.error) throw new Error(`bob: ${remote.error.message}`)

  const post = await admin.from('posts').insert({
    author_id: alice.id,
    is_local: true,
    visibility: 'public',
    content: [{ type: 'text', text: 'Card post from Ada' }],
  }).select('id').single()
  if (post.error) throw new Error(`post: ${post.error.message}`)
  postId = post.data!.id
})

test.afterAll(async () => {
  await admin.from('follows').delete().eq('follower_id', reader?.id ?? '')
  await admin.from('posts').delete().eq('author_id', alice?.id ?? '')
  await admin.from('profiles').delete().eq('id', bob.id)
  for (const user of [owner, reader, alice, gone]) if (user) await deleteUser(admin, user)
})

test('profile links show a profile card; a post link a post card; a suspended account none', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, reader)
  const origin = new URL(page.url()).origin
  await seedMessage('stored card', `http://localhost/@${alice.username}`, 5)
  await seedMessage('earlier address', `${origin}/social/profile/${alice.username}`, 4)
  await seedMessage('remote card', `${origin}/@${bob.username}@${REMOTE_DOMAIN}`, 3)
  await seedMessage('post card', `http://localhost/@${alice.username}/${postId}`, 2)
  await seedMessage('gone card', `${origin}/@${gone.username}`, 1)

  await test.step('the database previews the instance domain\'s link', async () => {
    const { data } = await admin.from('messages').select('metadata')
      .eq('channel_id', server.generalChannelId).filter('content->1->>url', 'eq', `http://localhost/@${alice.username}`).single()
    const embed = (data?.metadata as any)?.embeds?.[`http://localhost/@${alice.username}`]
    expect([embed?.provider, embed?.profile?.username, embed?.profile?.id]).toEqual(['harmony-profile', alice.username, alice.id])
  })

  await openChannel(page, server.id, server.generalChannelId)

  for (const text of ['stored card', 'earlier address']) {
    await test.step(`${text}: a local account`, async () => {
      const shown = card(page, text)
      await expect(shown).toBeVisible({ timeout: 30000 })
      await expect(shown.getByTestId('profile-embed-name')).toContainText('Ada Profile')
      await expect(shown.getByTestId('profile-embed-handle')).toHaveText(`@${alice.username}@localhost`)
      await expect(shown.getByTestId('profile-embed-bio')).toHaveText('Painter of night skies over the harbour.')
      await expect(shown.getByTestId('profile-embed-follow')).toHaveText('Follow')
    })
  }

  await test.step('a remote account by /@user@domain', async () => {
    const shown = card(page, 'remote card')
    await expect(shown).toBeVisible({ timeout: 30000 })
    await expect(shown.getByTestId('profile-embed-handle')).toHaveText(`@${bob.username}@${REMOTE_DOMAIN}`)
    await expect(shown.getByTestId('profile-embed-bio')).toHaveText('Writes from the coast.')
  })

  await test.step('a post under its author is a post card', async () => {
    const post = row(page, 'post card')
    await expect(post.locator('.provider-embed__post')).toContainText('Card post from Ada', { timeout: 30000 })
    await expect(post.getByTestId('profile-embed')).toHaveCount(0)
  })

  await test.step('a suspended account shows no profile', async () => {
    const shown = card(page, 'gone card')
    await expect(shown.getByTestId('profile-embed-unavailable')).toBeVisible({ timeout: 30000 })
    await expect(shown.getByTestId('profile-embed-unavailable')).toContainText(`@${gone.username}@localhost`)
    await expect(shown.getByTestId('profile-embed-follow')).toHaveCount(0)
    await expect(shown.getByTestId('profile-embed-name')).toHaveCount(0)
  })

  await test.step('Follow follows the account', async () => {
    const follow = card(page, 'stored card').getByTestId('profile-embed-follow')
    await follow.click()
    await expect(follow).toHaveText('Following', { timeout: 15000 })
    await expect.poll(async () => {
      const { data } = await admin.from('follows').select('status').eq('follower_id', reader.id).eq('following_id', alice.id).maybeSingle()
      return data?.status
    }, { timeout: 15000 }).toBe('accepted')
    await expect(card(page, 'earlier address').getByTestId('profile-embed-follow')).toHaveText('Following')
  })

  await test.step('Open profile opens /@user', async () => {
    await card(page, 'stored card').getByTestId('profile-embed-open').click()
    await expect(page).toHaveURL(new RegExp(`/@${alice.username}$`), { timeout: 30000 })
    await expect(page.getByTestId('profile-handle')).toHaveText(`@${alice.username}@localhost`, { timeout: 30000 })
  })
})
