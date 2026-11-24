// Journey: Settings › Voice & video starts a camera preview. Closed before the camera answers, it
// leaves no camera on: the capture that arrives after the page closed is stopped. Before 1.9.8
// it stayed live, camera light on, until the tab closed.
//
// getUserMedia is replaced: a camera capture answers when the test says so and returns a canvas
// track, so the track's readyState is the browser's own.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let user: SpecUser

test.beforeAll(async () => {
  user = await createUser(admin, 'camprev')
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

interface CameraProbe {
  requests: number
  answer: () => void
  tracks: MediaStreamTrack[]
}

async function slowCamera(page: Page) {
  await page.addInitScript(() => {
    const probe: CameraProbe = { requests: 0, answer: () => {}, tracks: [] }
    ;(window as unknown as { __camera: CameraProbe }).__camera = probe
    const md = navigator.mediaDevices
    md.enumerateDevices = async () => ([
      { kind: 'audioinput', deviceId: 'mic-desk', label: 'Desk mic', groupId: '' },
      { kind: 'audiooutput', deviceId: 'out-desk', label: 'Desk speakers', groupId: '' },
      { kind: 'videoinput', deviceId: 'cam-web', label: 'Webcam', groupId: '' },
    ].map((d) => ({ ...d, toJSON() { return this } })) as unknown as MediaDeviceInfo[])
    md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      const tracks: MediaStreamTrack[] = []
      if (constraints?.audio) {
        const ctx = new AudioContext()
        const dest = ctx.createMediaStreamDestination()
        ctx.createOscillator().connect(dest)
        tracks.push(...dest.stream.getAudioTracks())
      }
      if (constraints?.video) {
        probe.requests++
        await new Promise<void>((resolve) => { probe.answer = resolve })
        const canvas = document.createElement('canvas')
        canvas.width = 16
        canvas.height = 16
        canvas.getContext('2d')!.fillRect(0, 0, 16, 16)
        const video = canvas.captureStream(1).getVideoTracks()
        probe.tracks.push(...video)
        tracks.push(...video)
      }
      return new MediaStream(tracks)
    }
  })
}

type ProbeWindow = { __camera: CameraProbe }
const requests = (page: Page) => page.evaluate(() => (window as unknown as ProbeWindow).__camera.requests)
const trackStates = (page: Page) => page.evaluate(() => (window as unknown as ProbeWindow).__camera.tracks.map((t) => t.readyState))
/** Answers the newest camera request. */
const answer = (page: Page) => page.evaluate(() => (window as unknown as ProbeWindow).__camera.answer())

test('closing Voice & video before the camera answers leaves the camera off', async ({ page }) => {
  test.setTimeout(120_000)
  await slowCamera(page)
  await signIn(page, user)
  await page.goto('/settings/voice')
  await dismissAnnouncements(page)
  await expect(page.getByRole('combobox', { name: 'Camera' })).toBeVisible({ timeout: 30000 })

  await test.step('the preview asks for the camera on opening', async () => {
    await expect.poll(() => requests(page), { timeout: 15000 }).toBe(1)
  })

  await test.step('settings close while the camera has not answered', async () => {
    await page.getByRole('button', { name: 'Close settings' }).click()
    await expect(page).not.toHaveURL(/\/settings/, { timeout: 15000 })
  })

  await test.step('the camera answers late: its track is stopped', async () => {
    await answer(page)
    await expect.poll(() => trackStates(page), { timeout: 5000 }).toHaveLength(1)
    await expect.poll(() => trackStates(page), { timeout: 5000 }).toEqual(['ended'])
  })
})

test('a second camera chosen before the first answers keeps one camera on', async ({ page }) => {
  test.setTimeout(120_000)
  await slowCamera(page)
  await page.addInitScript(() => {
    const md = navigator.mediaDevices
    const list = md.enumerateDevices.bind(md)
    md.enumerateDevices = async () => [
      ...(await list()),
      { kind: 'videoinput', deviceId: 'cam-doc', label: 'Document camera', groupId: '', toJSON() { return this } } as unknown as MediaDeviceInfo,
    ]
  })
  await signIn(page, user)
  await page.goto('/settings/voice')
  await dismissAnnouncements(page)
  const camera = page.getByRole('combobox', { name: 'Camera' })
  await expect(camera).toBeVisible({ timeout: 30000 })
  await expect.poll(() => requests(page), { timeout: 15000 }).toBe(1)
  await page.evaluate(() => {
    const w = window as unknown as ProbeWindow & { __firstAnswer: () => void }
    w.__firstAnswer = w.__camera.answer
  })

  await camera.selectOption('cam-doc')
  await expect.poll(() => requests(page), { timeout: 15000 }).toBeGreaterThanOrEqual(2)

  // The later choice answers first, then the first camera.
  await answer(page)
  await page.evaluate(() => (window as unknown as { __firstAnswer: () => void }).__firstAnswer())
  await expect.poll(async () => (await trackStates(page)).length, { timeout: 5000 }).toBe(2)
  await page.waitForTimeout(500)

  expect(await trackStates(page)).toEqual(['live', 'ended'])
})
