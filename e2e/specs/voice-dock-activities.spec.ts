// Journey: one Activities entry. In a call the dock and the call view carry a single Activities
// button; its dialog offers watching or listening together above the games. Outside a call the
// chat header's Activities button opens the same dialog with the games alone. The dock keeps its
// primary controls in view and the rest (participants, spatial audio, voice settings) under More.
// View-size controls share one glyph pair: arrows out to grow, arrows in to shrink.
//
// No LiveKit runs in this stack: the voice store is set as a connected call leaves it.

import { test, expect, type Page } from '@playwright/test'
import { addMember, adminClient, createUser, deleteUser, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let owner: SpecUser
let friend: SpecUser
let server: SeededServer
let voiceId = ''
let dm = ''

async function must<T extends { error: { message: string } | null }>(what: string, result: PromiseLike<T>): Promise<T> {
  const r = await result
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'vdaown')
  friend = await createUser(admin, 'vdafri')
  await must('app on', admin.from('activity_apps').update({ enabled: true }).eq('id', 'drawinphone'))
  server = await seedServer(admin, owner, `Lounge ${owner.username}`)
  await addMember(admin, friend, server.id)
  const voice = await must('voice channel', admin.from('channels').insert({ server_id: server.id, name: 'lounge', type: 1 }).select('id').single())
  voiceId = voice.data!.id
  await must('in the call', admin.from('voice_channel_participants').insert([{ channel_id: voiceId, user_id: owner.id, server_id: server.id }]))
  const conversation = await must('dm', admin.from('conversations').insert({ type: 'direct', created_by: owner.id }).select('id').single())
  dm = conversation.data!.id
  await must('participants', admin.from('conversation_participants').insert([
    { conversation_id: dm, user_id: owner.id }, { conversation_id: dm, user_id: friend.id },
  ]))
})

test.afterAll(async () => {
  if (server) await admin.from('servers').delete().eq('id', server.id)
  if (dm) await admin.from('conversations').delete().eq('id', dm)
  for (const user of [owner, friend]) if (user) await deleteUser(admin, user)
})

async function enterCall(page: Page): Promise<void> {
  await page.evaluate(({ serverId, channelId, userId }) => {
    type Store = { $patch: (fn: (state: Record<string, any>) => void) => void }
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, Store> } } } }
    }
    const stores = root.__vue_app__.config.globalProperties.$pinia._s
    stores.get('unifiedVoiceChannel')!.$patch((state) => {
      state.isConnected = true
      state.currentServerId = serverId
      state.currentChannelId = channelId
      state.currentChannelName = 'lounge'
      state.localState.userId = userId
    })
    stores.get('serverUsers')?.$patch((state) => {
      state.usersInVoiceChannels = { ...state.usersInVoiceChannels, [channelId]: [userId] }
    })
  }, { serverId: server.id, channelId: voiceId, userId: owner.id })
}

const dock = (page: Page) => page.getByRole('region', { name: 'Voice connection' })
const glyph = (page: Page, testid: string) => page.getByTestId(testid).locator('.icon-wrap')

test('the dock has one Activities button, and More holds the rest', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await enterCall(page)

  await test.step('one Activities button; no separate watch, play, spatial, settings or participants buttons', async () => {
    await expect(dock(page).getByTestId('dock-activities-button')).toBeVisible({ timeout: 15_000 })
    await expect(glyph(page, 'dock-activities-button')).toHaveClass(/icon-popcorn/)
    await expect(dock(page).locator('.control-btn.soundboard-btn .icon-wrap')).toHaveClass(/icon-music/)
    for (const gone of ['activity-button', 'dock-play-together-button']) await expect(page.getByTestId(gone)).toHaveCount(0)
    for (const gone of ['.spatial-btn', '.settings-btn', '.participants-btn', '.popout-btn']) {
      await expect(dock(page).locator(`.control-btn${gone}`)).toHaveCount(0)
    }
  })

  await test.step('separators part the call controls, what plays in the call, and the view of the call', async () => {
    await expect(dock(page).getByTestId('dock-sep')).toHaveCount(2)
    // Read in one frame: the dock's entrance animation moves everything together.
    const order = await page.evaluate(() => {
      const x = (el: Element) => el.getBoundingClientRect().x
      const at = (id: string) => x(document.querySelector(`[data-testid="${id}"]`)!)
      const seps = [...document.querySelectorAll('[data-testid="dock-sep"]')].map(x)
      return [at('dock-share'), seps[0], at('dock-activities-button'), at('dock-more'), seps[1], at('dock-open-call-view')]
    })
    expect([...order].sort((p, q) => p - q)).toEqual(order)
  })

  await test.step('in a call, the dialog offers watching together above the games', async () => {
    await dock(page).getByTestId('dock-activities-button').click()
    const launcher = page.getByTestId('activities-launcher')
    await expect(launcher).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Activities' })).toBeVisible()
    await expect(launcher.getByTestId('activities-watch').getByTestId('activity-link')).toBeVisible()
    await expect(launcher.getByTestId('activities-watch').getByTestId('activity-from-drive')).toBeVisible()
    await expect(launcher.getByTestId('activities-play').getByTestId('play-together-app-drawinphone')).toBeVisible()
    const watchBox = await launcher.getByTestId('activities-watch').boundingBox()
    const playBox = await launcher.getByTestId('activities-play').boundingBox()
    expect(watchBox!.y).toBeLessThan(playBox!.y)
    await expect(dock(page).getByTestId('dock-activities-button')).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(launcher).toHaveCount(0)
  })

  await test.step('More lists participants, spatial audio and voice settings, and opens each', async () => {
    const more = dock(page).getByTestId('dock-more')
    await expect(more).toHaveAttribute('aria-haspopup', 'menu')
    await more.click()
    const menu = page.getByRole('menu', { name: 'More options' })
    await expect(menu).toBeVisible()
    const menuBox = (await menu.boundingBox())!
    const moreBox = (await more.boundingBox())!
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(moreBox.y)
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Participants' })).toHaveAttribute('aria-checked', 'false')
    await expect(menu.getByRole('menuitem', { name: /Spatial audio/ })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Voice settings' })).toBeVisible()

    await menu.getByRole('menuitemcheckbox', { name: 'Participants' }).click()
    await expect(menu).toHaveCount(0)
    await expect(dock(page).locator('.dock-participants-dropdown .participants-dropdown')).toBeVisible()
    await more.click()
    await expect(page.getByRole('menuitemcheckbox', { name: 'Participants' })).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('menuitemcheckbox', { name: 'Participants' }).click()
    await expect(dock(page).locator('.dock-participants-dropdown .participants-dropdown')).toHaveCount(0)

    await more.click()
    await page.getByRole('menuitem', { name: 'Voice settings' }).click()
    await expect(page.getByTestId('input-sensitivity-manual')).toBeAttached({ timeout: 10_000 })
    await page.keyboard.press('Escape')
  })

  await test.step('view size: arrows out grow the view, arrows in shrink it', async () => {
    await expect(glyph(page, 'dock-open-call-view')).toHaveClass(/icon-maximize-2/)
    await expect(glyph(page, 'dock-minimize')).toHaveClass(/icon-minimize-2/)
    await dock(page).getByTestId('dock-minimize').click()
    await expect(glyph(page, 'mini-expand')).toHaveClass(/icon-maximize-2/)
    await page.getByTestId('mini-expand').click()
    await dock(page).getByTestId('dock-open-call-view').click()
    await expect(page.getByTestId('overlay-activities-button')).toBeVisible()
    await expect(page.locator('.voice-overlay [title="Minimize call view"] .icon-wrap')).toHaveClass(/icon-minimize-2/)
    for (const gone of ['overlay-activity-button', 'overlay-play-together-button']) await expect(page.getByTestId(gone)).toHaveCount(0)
    await expect(glyph(page, 'overlay-activities-button')).toHaveClass(/icon-popcorn/)
    const sep = (await page.getByTestId('overlay-sep').boundingBox())!
    expect(sep.x).toBeLessThan((await page.getByTestId('overlay-activities-button').boundingBox())!.x)
  })
})

test('a DM header keeps Call, Search and More; More holds Add people, video and Activities', async ({ page }) => {
  test.setTimeout(90_000)
  await signIn(page, owner)
  await page.goto(`/dm/${dm}`)
  // The actions of this conversation's header: the Call button's own row.
  const header = page.getByTestId('dm-call').locator('..')
  await expect(page.getByTestId('dm-call')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('dm-call')).toHaveAttribute('aria-label', 'Start voice call')

  await test.step('the header holds Call, Search and More only', async () => {
    const buttons = header.locator(':scope > button, :scope > .more-options-container > button')
    await expect(buttons).toHaveCount(3)
    await expect(header.locator('.add-user-btn, .video-btn, .play-btn')).toHaveCount(0)
    await expect(page.getByTestId('activities-button')).toHaveCount(0)
  })

  await test.step('More lists Add people, Start video call and Activities', async () => {
    await page.getByTestId('dm-more').click()
    await expect(page.getByTestId('dm-menu-add-people')).toHaveText('Add people')
    await expect(page.getByTestId('dm-menu-video')).toHaveText('Start video call')
    const item = page.getByTestId('activities-menu-item')
    await expect(item).toHaveText('Activities')
    await expect(item.locator('.icon-wrap')).toHaveClass(/icon-popcorn/)
  })

  await test.step('outside a call, Activities opens the dialog with the games alone', async () => {
    await page.getByTestId('activities-menu-item').click()
    const launcher = page.getByTestId('activities-launcher')
    await expect(page.getByRole('dialog', { name: 'Activities' })).toBeVisible()
    await expect(launcher.getByTestId('play-together-app-drawinphone')).toBeVisible()
    await expect(launcher.getByTestId('activities-watch')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(launcher).toHaveCount(0)
  })

  await test.step('Add people opens the add-people dialog', async () => {
    await page.getByTestId('dm-more').click()
    await page.getByTestId('dm-menu-add-people').click()
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 })
  })
})
