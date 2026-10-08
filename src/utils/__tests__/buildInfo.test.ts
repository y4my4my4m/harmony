import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  detectDesktopOs,
  formatSupportText,
  formatVersionLine,
  getBuildInfo,
  getNativeVersion,
  getPlatformLabel,
} from '../buildInfo'

const mocks = vi.hoisted(() => ({
  getVersion: vi.fn(async () => '1.6.6'),
  platform: 'web' as string,
}))

vi.mock('@tauri-apps/api/app', () => ({ getVersion: mocks.getVersion }))
vi.mock('@/utils/platform', () => ({ getAppPlatform: () => mocks.platform }))

afterEach(() => {
  vi.unstubAllGlobals()
  mocks.platform = 'web'
  delete (globalThis as any).__TAURI_INTERNALS__
})

describe('getBuildInfo', () => {
  it('reads the injected constants', () => {
    vi.stubGlobal('__APP_VERSION__', '1.6.7')
    vi.stubGlobal('__APP_COMMIT__', '8b288a24')
    vi.stubGlobal('__APP_BUILD_DATE__', '2026-10-08T00:00:00.000Z')
    expect(getBuildInfo()).toEqual({ version: '1.6.7', commit: '8b288a24', buildDate: '2026-10-08T00:00:00.000Z' })
  })

  it('falls back when the build carries no git commit', () => {
    vi.stubGlobal('__APP_VERSION__', '1.6.7')
    vi.stubGlobal('__APP_COMMIT__', '')
    const build = getBuildInfo()
    expect(build.commit).toBe('')
    expect(formatVersionLine(build, 'web', null)).toBe('1.6.7 · web')
  })

  it('falls back when the constants are undefined', () => {
    expect(getBuildInfo()).toEqual({ version: 'unknown', commit: '', buildDate: '' })
  })
})

describe('platform', () => {
  it('detects desktop OS from the user agent', () => {
    expect(detectDesktopOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows')
    expect(detectDesktopOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('macos')
    expect(detectDesktopOs('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux')
  })

  it('labels each runtime', () => {
    expect(getPlatformLabel()).toBe('web')
    mocks.platform = 'pwa'
    expect(getPlatformLabel()).toBe('pwa')
    mocks.platform = 'tauri-mobile'
    expect(getPlatformLabel()).toBe('android')
    mocks.platform = 'tauri-desktop'
    expect(getPlatformLabel()).toMatch(/^desktop/)
  })

  it('reads the native version only under Tauri', async () => {
    expect(await getNativeVersion()).toBeNull()
    ;(globalThis as any).__TAURI_INTERNALS__ = {}
    expect(await getNativeVersion()).toBe('1.6.6')
  })
})

describe('formatting', () => {
  const build = { version: '1.6.7', commit: '8b288a24', buildDate: '2026-10-08T00:00:00.000Z' }

  it('appends the native version only when it differs', () => {
    expect(formatVersionLine(build, 'desktop linux', '1.6.6')).toBe('1.6.7 (8b288a24) · desktop linux · app 1.6.6')
    expect(formatVersionLine(build, 'desktop linux', '1.6.7')).toBe('1.6.7 (8b288a24) · desktop linux')
  })

  it('builds the support block', () => {
    const text = formatSupportText({
      build,
      platform: 'android',
      nativeVersion: '1.6.7',
      instance: 'mony.lol',
      serverVersion: '1.6.5',
      userAgent: 'UA',
    })
    expect(text).toBe([
      'Version: 1.6.7',
      'Commit: 8b288a24',
      'Build date: 2026-10-08T00:00:00.000Z',
      'Platform: android',
      'Native app: 1.6.7',
      'Instance: mony.lol',
      'Server version: 1.6.5',
      'User agent: UA',
    ].join('\n'))
  })

  it('marks missing commit and server version as unknown', () => {
    const text = formatSupportText({
      build: { version: '1.6.7', commit: '', buildDate: '' },
      platform: 'web',
      nativeVersion: null,
      instance: 'harmony.test',
      serverVersion: null,
      userAgent: '',
    })
    expect(text).toContain('Commit: unknown')
    expect(text).toContain('Build date: unknown')
    expect(text).toContain('Server version: unknown')
    expect(text).not.toContain('Native app')
  })
})
