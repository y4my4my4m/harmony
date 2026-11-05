// Journey: the device selects of Settings › Voice & video and the call's settings panel never
// show an empty box.
//
// - No microphone (or no camera): the select reads "None" and is disabled. Output-only
//   earbuds in a desktop without a microphone are this case.
// - Devices present but unnamed (Chromium before a capture permission: one entry per kind, empty
//   id and label): "Default", which is the system device, with "Allow microphone" / "Allow
//   camera". Allowing names the devices; a refusal says where to change it.
// - A device chosen elsewhere (the call's device menu) that this list has not seen yet: the list
//   is read again and shows it.
// - A choice made while names were visible survives a later visit without them.
//
// enumerateDevices and getUserMedia are replaced: the device list lives on window.__media, and a
// capture returns real tracks (an oscillator, a canvas) so the app's track handling is the
// browser's own.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

test.use({ serviceWorkers: 'block' })

type Kind = 'audioinput' | 'audiooutput' | 'videoinput'
interface FakeDevice { kind: Kind; deviceId: string; label: string }
/** `named`: whether a capture permission for that side (microphone: inputs and outputs) exists. */
interface FakeMedia { devices: FakeDevice[]; named: { audio: boolean; video: boolean }; deny: boolean; captures: string[] }

const admin = adminClient()
let user: SpecUser
let server: SeededServer
let loungeId: string

test.beforeAll(async () => {
  user = await createUser(admin, 'devsel')
  server = await seedServer(admin, user, `Devices ${user.username}`)
  const { data: general } = await admin.from('channels').select('category').eq('id', server.generalChannelId).single()
  const { data, error } = await admin
    .from('channels')
    .insert({ server_id: server.id, name: 'lounge', type: 1, category: general?.category ?? null })
    .select('id')
    .single()
  if (error || !data) throw new Error(`lounge: ${error?.message}`)
  loungeId = data.id
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

const EARBUDS: FakeDevice = { kind: 'audiooutput', deviceId: 'out-earbuds', label: 'WF-1000XM6' }
const DESK_MIC: FakeDevice = { kind: 'audioinput', deviceId: 'mic-desk', label: 'Desk mic' }
const HEADSET_MIC: FakeDevice = { kind: 'audioinput', deviceId: 'mic-headset', label: 'Headset mic' }
const WEBCAM: FakeDevice = { kind: 'videoinput', deviceId: 'cam-web', label: 'Webcam' }

/**
 * Installs the fake media devices for every load of the page. Unnamed is Chromium without a
 * capture permission: each kind present is one entry with an empty id and label. A microphone
 * capture names inputs and outputs, a camera capture names cameras. The state lives in
 * sessionStorage so it survives reloads.
 */
async function fakeMedia(page: Page, init: Omit<FakeMedia, 'captures'>) {
  await page.addInitScript((seed) => {
    const KEY = '__fakeMedia'
    const read = (): FakeMedia => JSON.parse(sessionStorage.getItem(KEY) ?? 'null') ?? { ...seed, captures: [] }
    const write = (state: FakeMedia) => sessionStorage.setItem(KEY, JSON.stringify(state))
    if (!sessionStorage.getItem(KEY)) write({ ...seed, captures: [] })
    ;(window as unknown as { __media: { read: typeof read; write: typeof write } }).__media = { read, write }
    const md = navigator.mediaDevices
    md.enumerateDevices = async () => {
      const state = read()
      const named = (kind: Kind) => (kind === 'videoinput' ? state.named.video : state.named.audio)
      const list: FakeDevice[] = []
      for (const device of state.devices) {
        if (named(device.kind)) list.push(device)
        else if (!list.some((d) => d.kind === device.kind)) list.push({ kind: device.kind, deviceId: '', label: '' })
      }
      return list.map((d) => ({ ...d, groupId: '', toJSON() { return this } })) as unknown as MediaDeviceInfo[]
    }
    md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      const state = read()
      state.captures.push([constraints?.audio ? 'audio' : '', constraints?.video ? 'video' : ''].filter(Boolean).join('+'))
      write(state)
      if (state.deny) throw new DOMException('Permission denied', 'NotAllowedError')
      const wants = (kind: Kind) => state.devices.some((d) => d.kind === kind)
      if ((constraints?.audio && !wants('audioinput')) || (constraints?.video && !wants('videoinput'))) {
        throw new DOMException('Requested device not found', 'NotFoundError')
      }
      if (constraints?.audio) state.named.audio = true
      if (constraints?.video) state.named.video = true
      write(state)
      const tracks: MediaStreamTrack[] = []
      if (constraints?.audio) {
        const ctx = new AudioContext()
        const dest = ctx.createMediaStreamDestination()
        ctx.createOscillator().connect(dest)
        tracks.push(...dest.stream.getAudioTracks())
      }
      if (constraints?.video) {
        const canvas = document.createElement('canvas')
        canvas.width = 16
        canvas.height = 16
        canvas.getContext('2d')!.fillRect(0, 0, 16, 16)
        tracks.push(...canvas.captureStream(1).getVideoTracks())
      }
      return new MediaStream(tracks)
    }
  }, { ...init, captures: [] } as FakeMedia)
}

async function setMedia(page: Page, patch: Partial<FakeMedia>) {
  await page.evaluate((p) => {
    const media = (window as unknown as { __media: { read(): FakeMedia; write(s: FakeMedia): void } }).__media
    media.write({ ...media.read(), ...p })
  }, patch)
}

const captures = (page: Page) =>
  page.evaluate(() => (window as unknown as { __media: { read(): FakeMedia } }).__media.read().captures)

const input = (scope: Page | ReturnType<Page['getByRole']>) => scope.getByRole('combobox', { name: 'Input device' })
const output = (scope: Page | ReturnType<Page['getByRole']>) => scope.getByRole('combobox', { name: 'Output device' })
const camera = (scope: Page | ReturnType<Page['getByRole']>) => scope.getByRole('combobox', { name: 'Camera' })

/** The option a select shows; none when the select is blank. */
const shown = (select: ReturnType<Page['getByRole']>) => select.locator('option:checked')

async function openVoiceSettings(page: Page) {
  await page.goto('/settings/voice')
  await dismissAnnouncements(page)
  await expect(output(page)).toBeVisible({ timeout: 30000 })
}

test('no microphone and no camera: the selects read None and are disabled', async ({ page }) => {
  test.setTimeout(120_000)
  await fakeMedia(page, { devices: [EARBUDS], named: { audio: true, video: true }, deny: false })
  await signIn(page, user)
  await openVoiceSettings(page)

  await expect(shown(output(page))).toHaveText('WF-1000XM6')
  for (const select of [input(page), camera(page)]) {
    await expect(shown(select)).toHaveText('None')
    await expect(select).toBeDisabled()
  }
})

test('unnamed devices offer Default and a way to name them; a choice survives a visit without names', async ({ page }) => {
  test.setTimeout(150_000)
  await fakeMedia(page, { devices: [DESK_MIC, HEADSET_MIC, EARBUDS, WEBCAM], named: { audio: false, video: false }, deny: false })
  await signIn(page, user)
  await openVoiceSettings(page)

  await test.step('before access: Default, enabled, and Allow buttons', async () => {
    for (const select of [input(page), output(page)]) {
      await expect(shown(select)).toHaveText('Default')
      await expect(select).toBeEnabled()
    }
    await expect(shown(camera(page))).toHaveText('No camera')
    await expect(page.getByRole('button', { name: 'Allow microphone' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Allow camera' })).toBeVisible()
  })

  await test.step('Allow microphone names the microphones and speakers', async () => {
    await page.getByRole('button', { name: 'Allow microphone' }).click()
    await expect(input(page).locator('option')).toHaveText(['Desk mic', 'Headset mic'])
    await expect(shown(input(page))).toHaveText('Desk mic')
    await expect(shown(output(page))).toHaveText('WF-1000XM6')
    await expect(page.getByRole('button', { name: 'Allow microphone' })).toHaveCount(0)
    expect(await captures(page)).toContain('audio')
  })

  await test.step('Allow camera names the camera', async () => {
    await page.getByRole('button', { name: 'Allow camera' }).click()
    await expect(camera(page).locator('option')).toHaveText(['No camera', 'Webcam'])
    await expect(page.getByRole('button', { name: 'Allow camera' })).toHaveCount(0)
  })

  await test.step('the headset chosen, then a visit without names keeps it', async () => {
    await input(page).selectOption({ label: 'Headset mic' })
    await expect(shown(input(page))).toHaveText('Headset mic')
    await setMedia(page, { named: { audio: false, video: false } })
    await page.reload()
    await expect(shown(input(page))).toHaveText('Default', { timeout: 30000 })
    await page.getByRole('slider', { name: 'Input volume' }).fill('120')
    await page.getByRole('button', { name: 'Allow microphone' }).click()
    await expect(shown(input(page))).toHaveText('Headset mic')
  })

  await test.step('phone width: the Allow row fits', async () => {
    await setMedia(page, { named: { audio: false, video: false } })
    await page.setViewportSize({ width: 375, height: 812 })
    await page.reload()
    const allow = page.getByRole('button', { name: 'Allow microphone' })
    await expect(allow).toBeVisible({ timeout: 30000 })
    const box = await allow.boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(375)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
  })
})

test('a refused microphone says so and keeps Default', async ({ page }) => {
  test.setTimeout(120_000)
  await fakeMedia(page, { devices: [DESK_MIC, EARBUDS], named: { audio: false, video: false }, deny: true })
  await signIn(page, user)
  await openVoiceSettings(page)

  await page.getByRole('button', { name: 'Allow microphone' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Microphone access is blocked' })).toBeVisible()
  await expect(shown(input(page))).toHaveText('Default')
  await expect(input(page)).toBeEnabled()
})

test('a microphone chosen in the call menu that this list has not seen shows by name', async ({ page }) => {
  test.setTimeout(120_000)
  await fakeMedia(page, { devices: [DESK_MIC, EARBUDS], named: { audio: true, video: true }, deny: false })
  await signIn(page, user)
  await openVoiceSettings(page)
  await expect(shown(input(page))).toHaveText('Desk mic')

  // Plugged in without a devicechange event reaching this page; picked from the call's device menu.
  await setMedia(page, { devices: [DESK_MIC, HEADSET_MIC, EARBUDS] })
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('harmony-device-changed', { detail: { type: 'input', deviceId: 'mic-headset' } }))
  })
  await expect(shown(input(page))).toHaveText('Headset mic')
})

test('the call settings panel: None when there is no microphone, Default before access', async ({ page }) => {
  test.setTimeout(120_000)
  await fakeMedia(page, { devices: [EARBUDS], named: { audio: true, video: true }, deny: false })
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await page.evaluate((o) => {
    type StoreHandle = { $patch: (fn: (state: Record<string, unknown>) => void) => void }
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, StoreHandle> } } } }
    }
    const voice = root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')
    if (!voice) throw new Error('voice store not created')
    voice.$patch((s) => {
      s.isConnected = true
      s.currentServerId = o.serverId
      s.currentChannelId = o.channelId
      s.currentChannelName = 'lounge'
      s.localState = {
        userId: o.selfId, isAudioEnabled: true, isVideoEnabled: false, isScreenSharing: false,
        isMuted: false, isDeafened: false, isSpeaking: false, audioLevel: 0,
      }
      s.allUsers = []
    })
  }, { serverId: server.id, channelId: loungeId, selfId: user.id })

  await page.getByRole('region', { name: 'Voice connection' }).getByRole('button', { name: 'Voice settings' }).click()
  const panel = page.getByRole('dialog', { name: 'Voice & video settings' })
  await expect(panel).toBeVisible({ timeout: 15000 })
  await expect(shown(input(panel))).toHaveText('None')
  await expect(input(panel)).toBeDisabled()
  await expect(shown(output(panel))).toHaveText('WF-1000XM6')
  await expect(shown(camera(panel))).toHaveText('None')

  await setMedia(page, { devices: [DESK_MIC, EARBUDS], named: { audio: false, video: false } })
  await page.evaluate(() => navigator.mediaDevices.dispatchEvent(new Event('devicechange')))
  await expect(shown(input(panel))).toHaveText('Default')
  await panel.getByRole('button', { name: 'Allow microphone' }).click()
  await expect(shown(input(panel))).toHaveText('Desk mic')
})
