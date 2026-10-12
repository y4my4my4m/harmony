import { describe, it, expect, vi, beforeEach } from 'vitest'

// In the Android app, alert sounds follow the phone's ringer: the webview's media stream does
// not, so a phone on vibrate still beeped.

const native = vi.hoisted(() => ({
  android: true,
  mode: 'vibrate' as 'normal' | 'vibrate' | 'silent' | null,
  buzz: vi.fn(async () => {}),
}))
vi.mock('@/services/androidReleaseNotice', () => ({ isAndroidApp: () => native.android }))
vi.mock('@/services/androidPush', () => ({
  ringerMode: vi.fn(async () => native.mode),
  buzz: native.buzz,
}))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const played: string[] = []
class FakeAudio {
  volume = 1
  constructor(public src = '') {}
  play() { played.push(this.src); return Promise.resolve() }
  addEventListener() {}
  cloneNode() { return new FakeAudio(this.src) }
}
vi.stubGlobal('Audio', FakeAudio)

const { audioThemeService } = await import('../AudioThemeService')

beforeEach(() => {
  played.length = 0
  native.buzz.mockClear()
  native.android = true
})

async function play(action: Parameters<typeof audioThemeService.testAudio>[0]) {
  await audioThemeService.testAudio(action)
}

describe('alert sounds and the Android ringer', () => {
  it('on vibrate, an alert buzzes instead of sounding', async () => {
    native.mode = 'vibrate'
    await play('dm')
    expect(played).toEqual([])
    expect(native.buzz).toHaveBeenCalledTimes(1)
  })

  it('on vibrate, a reaction neither sounds nor buzzes', async () => {
    native.mode = 'vibrate'
    await play('reaction')
    expect(played).toEqual([])
    expect(native.buzz).not.toHaveBeenCalled()
  })

  it('on silent or Do Not Disturb, nothing sounds or buzzes', async () => {
    native.mode = 'silent'
    await play('call_incoming')
    expect(played).toEqual([])
    expect(native.buzz).not.toHaveBeenCalled()
  })

  it('feedback sounds play whatever the ringer', async () => {
    native.mode = 'silent'
    await play('mic_on')
    expect(played).toHaveLength(1)
  })

  it('with the ringer on, or outside the Android app, alerts sound', async () => {
    native.mode = 'normal'
    await play('mention')
    native.android = false
    native.mode = 'silent'
    await play('dm')
    expect(played).toHaveLength(2)
  })
})
