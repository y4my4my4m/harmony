// Journey: the call view's device pickers leave the mic and camera off.
//
// Opening a device picker captures audio and video once, since device labels stay empty until a
// capture permission is granted. Every track of that capture is stopped once the list is read;
// a live track keeps the mic and camera light on for as long as the page lives.
//
// The stack has no LiveKit: the voice store is set as a joined call leaves it. getUserMedia is
// replaced with one returning real tracks (a canvas and an oscillator), so readyState is the
// browser's own.

import { test, expect, type Page } from '@playwright/test'
import { createUser, adminClient, deleteUser, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
let loungeId: string

test.beforeAll(async () => {
  owner = await createUser(admin, 'vdp')
  server = await seedServer(admin, owner, `Device probe ${owner.username}`)
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
  await deleteUser(admin, owner)
})

type StoreHandle = { $patch: (fn: (state: Record<string, any>) => void) => void; [key: string]: any }

/** Every getUserMedia call returns real tracks, recorded on window.__captures. */
async function recordCaptures(page: Page) {
  await page.addInitScript(() => {
    const captures: MediaStreamTrack[][] = []
    ;(window as unknown as { __captures: MediaStreamTrack[][] }).__captures = captures
    navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      const tracks: MediaStreamTrack[] = []
      if (constraints?.audio) {
        const ctx = new AudioContext()
        const osc = ctx.createOscillator()
        const dest = ctx.createMediaStreamDestination()
        osc.connect(dest)
        osc.start()
        tracks.push(...dest.stream.getAudioTracks())
      }
      if (constraints?.video) {
        const canvas = document.createElement('canvas')
        canvas.width = 16
        canvas.height = 16
        canvas.getContext('2d')!.fillRect(0, 0, 16, 16)
        tracks.push(...canvas.captureStream(1).getVideoTracks())
      }
      captures.push(tracks)
      return new MediaStream(tracks)
    }
  })
}

async function enterVoice(page: Page, selfId: string) {
  await page.evaluate((o) => {
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
  }, { serverId: server.id, channelId: loungeId, selfId })
}

const captureStates = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __captures: MediaStreamTrack[][] }).__captures.map((tracks) =>
      tracks.map((t) => `${t.kind}:${t.readyState}`),
    ),
  )

test('a device picker reads the device list and leaves no capture running', async ({ page }) => {
  test.setTimeout(120_000)
  await recordCaptures(page)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await enterVoice(page, owner.id)

  await page.getByRole('region', { name: 'Voice connection' }).getByRole('button', { name: 'Open call view' }).click()
  const view = page.getByRole('dialog', { name: 'lounge' })
  await expect(view).toBeVisible({ timeout: 15000 })

  for (const name of ['Select microphone', 'Select camera']) {
    await test.step(`${name}: the label-unlock capture is stopped`, async () => {
      const before = (await captureStates(page)).length
      const trigger = view.getByRole('button', { name })
      await trigger.click()
      await expect(page.getByRole('menu', { name })).toBeVisible()
      await expect.poll(async () => (await captureStates(page)).length).toBe(before + 1)
      expect((await captureStates(page))[before]).toEqual(['audio:ended', 'video:ended'])
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu', { name })).toHaveCount(0)
    })
  }

  // No capture from the pickers is left live.
  expect((await captureStates(page)).flat().filter((s) => s.endsWith(':live'))).toEqual([])
})
