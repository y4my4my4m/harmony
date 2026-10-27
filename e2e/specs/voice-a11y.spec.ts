// Journey: voice settings, voice shortcuts, the user panel's voice controls and
// voice-channel rosters, as a keyboard and screen-reader user meets them.
//
// The e2e stack runs no LiveKit, realtime service or federation backend, so no
// call connects here: the call view, the dock, incoming calls and the spoken
// join/leave/stream events are covered by unit tests. What renders without a
// call is driven here: input mode radios, labelled device and volume fields,
// the shortcut recorder with conflicts and per-shortcut switches, the defaults
// for new and existing installs, the user panel toggles and their
// announcements, the roster of a voice channel, and axe on each.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  addMember,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'
import { expectNoAxeViolations } from './a11y'

const admin = adminClient()
let owner: SpecUser
let member: SpecUser
let server: SeededServer
let loungeId: string
let stageId: string

test.beforeAll(async () => {
  owner = await createUser(admin, 'vcao')
  member = await createUser(admin, 'vcam')
  server = await seedServer(admin, owner, `Voice A11y ${owner.username}`)
  await addMember(admin, member, server.id)

  const { data: general } = await admin.from('channels').select('category').eq('id', server.generalChannelId).single()
  const voiceChannel = async (name: string) => {
    const { data, error } = await admin
      .from('channels')
      .insert({ server_id: server.id, name, type: 1, category: general?.category ?? null })
      .select('id')
      .single()
    if (error || !data) throw new Error(`voice channel ${name}: ${error?.message}`)
    return data.id as string
  }
  loungeId = await voiceChannel('lounge')
  stageId = await voiceChannel('stage')

  // An unread notification for the docked avatar's badge.
  const client = await userClient(member)
  const { error: followError } = await client
    .from('follows')
    .insert({ follower_id: member.id, following_id: owner.id, status: 'accepted' })
  if (followError) throw new Error(`follow: ${followError.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
  await deleteUser(admin, member)
})

const politeRegion = (page: Page) => page.locator('[data-testid="live-announcer-polite"]')

async function openSettings(page: Page, section: 'voice' | 'keybinds') {
  await page.goto(`/settings/${section}`)
  await expect(page.getByRole('heading', { name: section === 'voice' ? 'Voice & video' : 'Keybindings' }).first()).toBeVisible({ timeout: 20000 })
}

test('voice settings: input mode radios, labelled fields, slider values and axe', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, owner)
  await openSettings(page, 'voice')

  const modes = page.getByRole('group', { name: 'Input mode' })
  const voiceActivity = modes.getByRole('radio', { name: /Voice activity/ })
  const pushToTalk = modes.getByRole('radio', { name: /Push to talk/ })

  await test.step('input mode is a radio group operated with arrow keys', async () => {
    await expect(voiceActivity).toBeChecked()
    await voiceActivity.focus()
    await page.keyboard.press('ArrowDown')
    await expect(pushToTalk).toBeChecked()
    await expect(pushToTalk).toBeFocused()
  })

  await test.step('push to talk shows a labelled recorder and release-delay slider', async () => {
    const recorder = page.getByRole('textbox', { name: 'Push to talk shortcut' })
    await expect(recorder).toHaveAttribute('readonly', '')
    await expect(recorder).toHaveValue('V')
    const delay = page.getByRole('slider', { name: 'Release delay' })
    await expect(delay).toHaveAttribute('aria-valuetext', '200 milliseconds')
    await delay.focus()
    await page.keyboard.press('ArrowRight')
    await expect(delay).toHaveAttribute('aria-valuetext', '250 milliseconds')
  })

  await test.step('device and volume fields are named by their visible labels', async () => {
    for (const name of ['Input device', 'Output device', 'Camera', 'Video quality', 'Frame rate']) {
      await expect(page.getByRole('combobox', { name })).toBeVisible()
    }
    await expect(page.getByRole('slider', { name: 'Input volume' })).toHaveAttribute('aria-valuetext', '100 percent')
    await expect(page.getByRole('slider', { name: 'Output volume' })).toHaveAttribute('aria-valuetext', '100 percent')
    await expect(page.getByRole('button', { name: 'Test microphone' })).toHaveAttribute('aria-pressed', 'false')
  })

  await test.step('the chosen mode survives a reload', async () => {
    await page.reload()
    await expect(page.getByRole('group', { name: 'Input mode' }).getByRole('radio', { name: /Push to talk/ })).toBeChecked({ timeout: 20000 })
  })

  await expectNoAxeViolations(page, { include: '.voice-settings-inline', label: 'settings/voice' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.reload()
  await expect(page.getByRole('group', { name: 'Input mode' })).toBeVisible({ timeout: 20000 })
  await expectNoAxeViolations(page, { include: '.voice-settings-inline', label: 'settings/voice (dark)' })
})

test('keybinds: switches, an accessible recorder, conflicts not applied silently, and axe', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, owner)
  await openSettings(page, 'keybinds')

  const mute = page.getByRole('textbox', { name: 'Toggle mute shortcut' })
  const deafen = page.getByRole('textbox', { name: 'Toggle deafen shortcut' })

  await test.step('a new install has chorded mute and deafen', async () => {
    await expect(mute).toHaveValue('Ctrl + Shift + M')
    await expect(deafen).toHaveValue('Ctrl + Shift + D')
    await expect(page.locator('[data-testid="keybinds-single-key-note"]')).toHaveCount(0)
  })

  await test.step('each shortcut has a named switch that persists', async () => {
    const toggle = page.getByRole('switch', { name: 'Use the Toggle camera shortcut' })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await page.reload()
    await expect(page.getByRole('switch', { name: 'Use the Toggle camera shortcut' })).toHaveAttribute('aria-checked', 'false', { timeout: 20000 })
    await page.getByRole('switch', { name: 'Use the Toggle camera shortcut' }).click()
    await expect(page.getByRole('switch', { name: 'Use the Toggle camera shortcut' })).toHaveAttribute('aria-checked', 'true')
  })

  await test.step('Enter starts recording; the next combination is recorded and announced', async () => {
    await mute.focus()
    await page.keyboard.press('Enter')
    await expect(mute).toHaveValue('Press keys…')
    await expect(politeRegion(page)).toContainText('Recording a shortcut for Toggle mute', { timeout: 5000 })
    await page.keyboard.press('Control+Alt+KeyK')
    await expect(mute).toHaveValue('Ctrl + Alt + K')
    await expect(politeRegion(page)).toContainText('Toggle mute set to Ctrl + Alt + K', { timeout: 5000 })
  })

  await test.step('navigation keys are not recorded and Escape cancels without leaving settings', async () => {
    await page.keyboard.press('Enter')
    await expect(mute).toHaveValue('Press keys…')
    await page.keyboard.press('Space')
    await page.keyboard.press('ArrowDown')
    await expect(mute).toHaveValue('Press keys…')
    await page.keyboard.press('Escape')
    await expect(mute).toHaveValue('Ctrl + Alt + K')
    await expect(mute).toBeFocused()
    await expect(page).toHaveURL(/\/settings\/keybinds/)
  })

  await test.step('Tab leaves the recorder instead of being recorded', async () => {
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    await expect(mute).not.toBeFocused()
    await expect(mute).toHaveValue('Ctrl + Alt + K')
  })

  await test.step('a conflicting combination waits in an alert for confirmation', async () => {
    await mute.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Control+Shift+KeyD')
    const alert = page.locator('[data-testid="keybind-conflict-toggle-mute"]')
    await expect(alert).toContainText('Ctrl + Shift + D is already used by Toggle deafen')
    await expect(page.getByRole('alert').filter({ hasText: 'already used by Toggle deafen' })).toBeVisible()
    await expect(mute).toHaveValue('Ctrl + Alt + K')
    await expect(mute).toHaveAttribute('aria-invalid', 'true')
    await expectNoAxeViolations(page, { include: '.keybind-settings', label: 'settings/keybinds with a conflict' })
    await alert.getByRole('button', { name: 'Assign anyway' }).click()
    await expect(mute).toHaveValue('Ctrl + Shift + D')
    await expect(alert).toHaveCount(0)
  })

  await test.step('reset restores the default', async () => {
    await page.getByRole('button', { name: 'Reset Toggle mute to default' }).click()
    await expect(mute).toHaveValue('Ctrl + Shift + M')
  })

  await expectNoAxeViolations(page, { include: '.keybind-settings', label: 'settings/keybinds' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.reload()
  await expect(mute).toBeVisible({ timeout: 20000 })
  await expectNoAxeViolations(page, { include: '.keybind-settings', label: 'settings/keybinds (dark)' })
})

test('an existing install keeps single-key mute and deafen and is offered the chorded pair', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  // A record from before the change carries no defaults version.
  await page.evaluate(() => localStorage.setItem('harmony-keybinds', JSON.stringify({ inputMode: 'voice_activity', releaseDelay: 200, keybinds: {} })))
  await openSettings(page, 'keybinds')

  const mute = page.getByRole('textbox', { name: 'Toggle mute shortcut' })
  const deafen = page.getByRole('textbox', { name: 'Toggle deafen shortcut' })
  await expect(mute).toHaveValue('M')
  await expect(deafen).toHaveValue('D')

  const note = page.locator('[data-testid="keybinds-single-key-note"]')
  await expect(note).toBeVisible()
  await note.getByRole('button', { name: 'Use Ctrl + Shift + M and Ctrl + Shift + D' }).click()
  await expect(mute).toHaveValue('Ctrl + Shift + M')
  await expect(deafen).toHaveValue('Ctrl + Shift + D')
  await expect(note).toHaveCount(0)
  await expect(politeRegion(page)).toContainText('Mute is Ctrl + Shift + M, deafen is Ctrl + Shift + D', { timeout: 5000 })
})

test('user panel: mute and deafen are toggle buttons that announce their state; axe on the panel', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  const panel = page.getByRole('region', { name: 'Your account' })
  const mute = panel.getByRole('button', { name: 'Mute', exact: true })
  const deafen = panel.getByRole('button', { name: 'Deafen', exact: true })

  await test.step('mute keeps its name and reports pressed', async () => {
    await expect(mute).toHaveAttribute('aria-pressed', 'false')
    await mute.click()
    await expect(mute).toHaveAttribute('aria-pressed', 'true')
    await expect(politeRegion(page)).toHaveText('Muted', { timeout: 5000 })
    await mute.click()
    await expect(mute).toHaveAttribute('aria-pressed', 'false')
    await expect(politeRegion(page)).toHaveText('Unmuted', { timeout: 5000 })
  })

  await test.step('deafen keeps its name and reports pressed', async () => {
    await deafen.click()
    await expect(deafen).toHaveAttribute('aria-pressed', 'true')
    await expect(politeRegion(page)).toHaveText('Deafened', { timeout: 5000 })
    await deafen.click()
    await expect(deafen).toHaveAttribute('aria-pressed', 'false')
  })

  await expectNoAxeViolations(page, { include: '.user-profile', label: 'user panel' })

  await test.step('the docked avatar names the unread count it shows', async () => {
    // Full-screen settings have no sidebar to hold the panel: it docks as the avatar.
    await page.goto('/settings/voice')
    const avatar = page.locator('.user-profile.is-docked .avatar-wrapper')
    await expect(avatar).toBeVisible({ timeout: 20000 })
    await expect(avatar).toHaveAttribute('role', 'button')
    // The follow and the server join each notify; the name carries whatever the badge shows.
    const badge = avatar.locator('.mobile-avatar-badge')
    await expect(badge).toHaveText(/^\d+$/, { timeout: 15000 })
    const count = (await badge.textContent())!.trim()
    await expect(avatar).toHaveAccessibleName(new RegExp(`^Your account and voice controls, ${count} unread notifications?$`))
    await expectNoAxeViolations(page, { include: '.user-profile', label: 'docked user panel' })
  })
})

// At 480 px and below the dock hides React (display: none); a desktop window that narrow, or one
// at 200% zoom, gets the same layout. 600 px to 420 px changes no layout flag, so nothing in the
// dock renders again when React hides.
test('a narrow dock: arrows pass the hidden React button and the toolbar keeps one Tab stop', async ({ page }) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 600, height: 800 })
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await enterVoice(page, { serverId: server.id, channelId: loungeId, channelName: 'lounge', selfId: owner.id, others: [member.id] })
  // Reactions are offered over video on LiveKit.
  await page.evaluate(() => {
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, StoreHandle> } } } }
    }
    root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')!.$patch((state) => {
      state.connectionMode = 'livekit'
      state.allUsers = state.allUsers.map((u: Record<string, unknown>) => ({ ...u, isVideoEnabled: true }))
    })
  })

  const controls = page.getByRole('region', { name: 'Voice connection' }).getByRole('toolbar', { name: 'Voice controls' })
  const share = controls.getByRole('button', { name: 'Share screen', exact: true })
  const react = controls.getByRole('button', { name: 'React', exact: true })
  const tabStops = controls.locator('button[tabindex="0"]:visible')

  await test.step('at 600 px React is a control and holds the Tab stop once reached', async () => {
    await expect(react).toBeVisible({ timeout: 20000 })
    await share.focus()
    await page.keyboard.press('ArrowRight')
    await expect(react).toBeFocused()
    await expect(react).toHaveAttribute('tabindex', '0')
  })

  await test.step('at 420 px React is hidden and the Tab stop moves to a control shown', async () => {
    await page.setViewportSize({ width: 420, height: 800 })
    await expect(react).toBeHidden()
    await expect(tabStops).toHaveCount(1)
  })

  await test.step('at 420 px arrows pass the hidden control and the Tab stop follows focus', async () => {
    await share.focus()
    await page.keyboard.press('ArrowRight')
    const focused = controls.locator('button:focus')
    await expect(focused).toHaveCount(1)
    await expect(focused).toBeVisible()
    await expect(focused).toHaveAttribute('tabindex', '0')
    await expect(tabStops).toHaveCount(1)
    await page.keyboard.press('ArrowLeft')
    await expect(share).toBeFocused()
    await expect(share).toHaveAttribute('tabindex', '0')
  })
})

type StoreHandle = { $patch: (fn: (state: Record<string, any>) => void) => void; [key: string]: any }

/**
 * The voice store as a joined call leaves it, with `others` in the call. No
 * transport exists: toggles change local state only and nothing is sent.
 */
async function enterVoice(page: Page, opts: { serverId: string; channelId: string; channelName: string; selfId: string; others: string[] }) {
  await page.evaluate((o) => {
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, StoreHandle> } } } }
    }
    const voice = root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')
    if (!voice) throw new Error('voice store not created')
    const member = (userId: string) => ({
      userId, isAudioEnabled: true, isVideoEnabled: false, isScreenSharing: false,
      isMuted: false, isDeafened: false, isSpeaking: false, audioLevel: 0,
    })
    voice.$patch((state) => {
      state.isConnected = true
      state.currentServerId = o.serverId
      state.currentChannelId = o.channelId
      state.currentChannelName = o.channelName
      state.localState = member(o.selfId)
      state.allUsers = o.others.map(member)
    })
    // Registers the voice shortcuts as a join does.
    voice.setupPushToTalk()
  }, opts)
}

/** A voice-channel-event broadcast as the realtime service would deliver it. */
async function receiveVoiceEvent(page: Page, serverId: string, payload: Record<string, unknown>) {
  await page.evaluate(({ serverId, payload }) => {
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, StoreHandle> } } } }
    }
    const users = root.__vue_app__.config.globalProperties.$pinia._s.get('serverUsers')
    if (!users) throw new Error('server users store not created')
    users.handleVoiceChannelEvent(serverId, payload)
  }, { serverId, payload })
}

test('in a call: the dock region, toggles, minimized panel, call view dialog and participant rows', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await enterVoice(page, { serverId: server.id, channelId: loungeId, channelName: 'lounge', selfId: owner.id, others: [member.id] })

  const dock = page.getByRole('region', { name: 'Voice connection' })

  await test.step('the dock is a named region with stable toggle buttons', async () => {
    // The region's own box is empty: its panels are position: fixed.
    await expect(dock).toBeAttached({ timeout: 20000 })
    const mute = dock.getByRole('button', { name: 'Mute', exact: true })
    await expect(mute).toBeVisible()
    await expect(mute).toHaveAttribute('aria-pressed', 'false')
    await mute.click()
    await expect(mute).toHaveAttribute('aria-pressed', 'true')
    await expect(politeRegion(page)).toHaveText('Muted', { timeout: 5000 })
    await mute.click()
    await expect(mute).toHaveAttribute('aria-pressed', 'false')
    await expect(dock.getByRole('button', { name: 'Deafen', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect(dock.getByRole('button', { name: 'Camera', exact: true })).toHaveAttribute('aria-pressed', 'false')
    // Two toolbars, one Tab stop each: mute to pop-out, participants to leave.
    const controls = dock.getByRole('toolbar', { name: 'Voice controls' })
    await expect(controls.locator('button[tabindex="0"]')).toHaveCount(1)
    await expect(dock.getByRole('toolbar', { name: 'Call' }).locator('button[tabindex="0"]')).toHaveCount(1)
    await mute.focus()
    await page.keyboard.press('ArrowRight')
    await expect(controls.getByRole('button', { name: 'Deafen', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(mute).toBeFocused()
    await expect(dock.getByRole('button', { name: 'Share screen', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expectNoAxeViolations(page, { include: '[data-testid="voice-dock"]', label: 'voice dock' })
  })

  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

  await test.step('the shortcut mutes and is announced', async () => {
    await blur()
    await page.keyboard.press('Control+Shift+KeyM')
    await expect(dock.getByRole('button', { name: 'Mute', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(politeRegion(page)).toHaveText('Muted', { timeout: 5000 })
    await page.keyboard.press('Control+Shift+KeyM')
    await expect(dock.getByRole('button', { name: 'Mute', exact: true })).toHaveAttribute('aria-pressed', 'false')
  })

  await test.step('the voice channel lists its participants as named buttons', async () => {
    const row = page.locator(`[data-channel-id="${loungeId}"]`).getByRole('button', { name: member.displayName, exact: true })
    await expect(row).toBeVisible({ timeout: 10000 })
    await expect(row).toHaveAttribute('aria-haspopup', 'menu')
    await expect(page.locator(`[data-channel-id="${loungeId}"]`).getByRole('button', { name: `${owner.displayName} (you)` })).toBeVisible()
    await row.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: member.displayName })
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(row).toBeFocused()
  })

  await test.step('minimizing leaves a real Expand button, focused, and mute in reach', async () => {
    await dock.getByRole('button', { name: 'Minimize voice panel' }).click()
    const expand = dock.getByRole('button', { name: 'Expand voice panel' })
    await expect(expand).toBeVisible()
    await expect(expand).toBeFocused()
    await expect(dock.getByRole('button', { name: 'Mute', exact: true })).toHaveCount(1)
    await expectNoAxeViolations(page, { include: '[data-testid="voice-dock"]', label: 'minimized voice panel' })
    await page.keyboard.press('Enter')
    await expect(dock.getByRole('button', { name: 'Minimize voice panel' })).toBeFocused()
  })

  await test.step('the call view is a modal dialog named by the channel; Escape returns focus', async () => {
    const openView = dock.getByRole('button', { name: 'Open call view' })
    await openView.focus()
    await page.keyboard.press('Enter')
    const view = page.getByRole('dialog', { name: 'lounge' })
    await expect(view).toBeVisible({ timeout: 15000 })
    await expect(view).toBeFocused()
    await expect(view.getByRole('group', { name: member.displayName })).toBeVisible()
    await expect(view.getByRole('button', { name: 'Mute', exact: true })).toHaveAttribute('aria-pressed', 'false')
    // The entry animation fades the view in; contrast is measured once it has settled.
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'))
    await expectNoAxeViolations(page, { include: '[data-testid="voice-overlay"]', label: 'call view' })

    await page.keyboard.press('Tab')
    await page.keyboard.press('Escape')
    await expect(view).toHaveCount(0, { timeout: 5000 })
    await expect(dock.getByRole('button', { name: 'Open call view' })).toBeFocused()
  })

  await test.step('closing the call view leaves the global mute shortcut working', async () => {
    await blur()
    await page.keyboard.press('Control+Shift+KeyM')
    await expect(dock.getByRole('button', { name: 'Mute', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Control+Shift+KeyM')
    await expect(dock.getByRole('button', { name: 'Mute', exact: true })).toHaveAttribute('aria-pressed', 'false')
  })

  await test.step('another voice channel shows its roster as a labelled list', async () => {
    await receiveVoiceEvent(page, server.id, { event: 'user-joined', userId: member.id, channelId: stageId })
    const list = page.locator(`[data-channel-id="${stageId}"]`).getByRole('list', { name: '1 in call' })
    await expect(list).toBeVisible({ timeout: 10000 })
    await expect(list.getByRole('listitem')).toHaveCount(1)
    await expect(list.getByRole('listitem').first()).toContainText(member.displayName)
    await expectNoAxeViolations(page, { include: `[data-channel-id="${stageId}"]`, label: 'voice roster' })
  })
})
