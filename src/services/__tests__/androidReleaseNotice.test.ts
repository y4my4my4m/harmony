import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(() => true),
  getVersion: vi.fn(async () => '1.6.1'),
}))

vi.mock('@/services/instanceConfig', () => ({ isTauriRuntime: mocks.isTauriRuntime }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: mocks.getVersion }))

import {
  CHECK_INTERVAL_MS,
  LATEST_RELEASE_URL,
  dismissVersion,
  findAndroidUpdate,
  getLatestRelease,
  parseLatestRelease,
} from '../androidReleaseNotice'

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36'

function releaseBody(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: 'v1.6.2',
    html_url: 'https://github.com/y4my4my4m/harmony/releases/tag/v1.6.2',
    draft: false,
    prerelease: false,
    assets: [
      {
        name: 'Harmony_1.6.2_x64-setup.exe',
        browser_download_url: 'https://github.com/y4my4my4m/harmony/releases/download/v1.6.2/Harmony_1.6.2_x64-setup.exe',
      },
      {
        name: 'app-universal-release.apk',
        browser_download_url: 'https://github.com/y4my4my4m/harmony/releases/download/v1.6.2/app-universal-release.apk',
      },
      {
        name: 'latest.json',
        browser_download_url: 'https://github.com/y4my4my4m/harmony/releases/download/v1.6.2/latest.json',
      },
    ],
    ...overrides,
  }
}

const fetchMock = vi.fn()

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => releaseBody() })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('navigator', { ...navigator, userAgent: ANDROID_UA })
  mocks.isTauriRuntime.mockReturnValue(true)
  mocks.getVersion.mockResolvedValue('1.6.1')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseLatestRelease', () => {
  it('takes the version from the tag and the APK asset URL', () => {
    expect(parseLatestRelease(releaseBody())).toEqual({
      version: '1.6.2',
      url: 'https://github.com/y4my4my4m/harmony/releases/download/v1.6.2/app-universal-release.apk',
    })
  })

  it('falls back to the release page when no APK is attached', () => {
    const body = releaseBody({ assets: [] })
    expect(parseLatestRelease(body)?.url).toBe(
      'https://github.com/y4my4my4m/harmony/releases/tag/v1.6.2',
    )
  })

  it('rejects drafts, pre-releases and malformed tags', () => {
    expect(parseLatestRelease(releaseBody({ draft: true }))).toBeNull()
    expect(parseLatestRelease(releaseBody({ prerelease: true }))).toBeNull()
    expect(parseLatestRelease(releaseBody({ tag_name: 'nightly' }))).toBeNull()
    expect(parseLatestRelease(null)).toBeNull()
    expect(parseLatestRelease({ message: 'Not Found' })).toBeNull()
  })

  it('rejects non-https download links', () => {
    const body = releaseBody({
      html_url: 'javascript:alert(1)',
      assets: [{ name: 'x.apk', browser_download_url: 'http://example.com/x.apk' }],
    })
    expect(parseLatestRelease(body)).toBeNull()
  })
})

describe('getLatestRelease', () => {
  it('fetches at most once per interval, caching failures too', async () => {
    const t0 = 1_000_000
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) })
    expect(await getLatestRelease(t0)).toBeNull()
    expect(await getLatestRelease(t0 + CHECK_INTERVAL_MS - 1)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(LATEST_RELEASE_URL)

    expect((await getLatestRelease(t0 + CHECK_INTERVAL_MS))?.version).toBe('1.6.2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('survives a network error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await getLatestRelease(5)).toBeNull()
  })
})

describe('findAndroidUpdate', () => {
  it('returns a newer release', async () => {
    expect((await findAndroidUpdate())?.version).toBe('1.6.2')
  })

  it('returns null when installed version is current', async () => {
    mocks.getVersion.mockResolvedValue('1.6.2')
    expect(await findAndroidUpdate()).toBeNull()
  })

  it('stays quiet for a dismissed version and returns for the next one', async () => {
    dismissVersion('1.6.2')
    expect(await findAndroidUpdate()).toBeNull()

    localStorage.removeItem('harmony.androidUpdate.latest')
    fetchMock.mockResolvedValue({ ok: true, json: async () => releaseBody({ tag_name: 'v1.6.3' }) })
    expect((await findAndroidUpdate())?.version).toBe('1.6.3')
  })

  it('does nothing outside the Android app', async () => {
    mocks.isTauriRuntime.mockReturnValue(false)
    expect(await findAndroidUpdate()).toBeNull()
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })
    mocks.isTauriRuntime.mockReturnValue(true)
    expect(await findAndroidUpdate()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
