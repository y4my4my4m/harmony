import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  config: { bridge: { instanceDomain: 'chat.harmony.test', publicUrl: '' } },
}))

vi.mock('../../config/supabase.js', () => ({
  supabase: {},
  config: mocks.config,
}))

import { absoluteAvatarUrl, absoluteServerIconUrl } from '../avatarUrl.js'

const env = { ...process.env }

beforeEach(() => {
  mocks.config.bridge.instanceDomain = 'chat.harmony.test'
  process.env.PUBLIC_URL = 'https://db.harmony.test'
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  process.env = { ...env }
  vi.restoreAllMocks()
})

describe('absoluteAvatarUrl', () => {
  it('resolves bundled web app images against the instance origin', () => {
    expect(absoluteAvatarUrl('/discord-bridge-bot.webp')).toBe('https://chat.harmony.test/discord-bridge-bot.webp')
    expect(absoluteAvatarUrl('/default_avatar.webp')).toBe('https://chat.harmony.test/default_avatar.webp')
    expect(absoluteAvatarUrl('/default_avatar.png')).toBe('https://chat.harmony.test/default_avatar.webp')
  })

  it('renders storage paths under PUBLIC_URL and passes absolute URLs through', () => {
    expect(absoluteAvatarUrl('8a1f/avatar.png')).toBe(
      'https://db.harmony.test/storage/v1/render/image/public/avatars/8a1f/avatar.png?width=256&height=256&resize=contain&quality=80',
    )
    expect(absoluteAvatarUrl('https://cdn.discordapp.com/avatars/1/a.png')).toBe('https://cdn.discordapp.com/avatars/1/a.png')
    expect(absoluteAvatarUrl(null)).toBeUndefined()
  })

  it('omits a bundled image when no instance origin is configured', () => {
    mocks.config.bridge.instanceDomain = ''
    expect(absoluteAvatarUrl('/discord-bridge-bot.webp')).toBeUndefined()
  })
})

describe('absoluteServerIconUrl', () => {
  it('renders a server_icons storage path under PUBLIC_URL', () => {
    expect(absoluteServerIconUrl('5a/icon.png')).toBe(
      'https://db.harmony.test/storage/v1/render/image/public/server_icons/5a/icon.png?width=128&height=128&resize=contain&quality=80',
    )
  })

  it('passes absolute URLs through, on the public origin', () => {
    process.env.SUPABASE_URL = 'http://supabase-kong:8000'
    expect(absoluteServerIconUrl('http://supabase-kong:8000/storage/v1/object/public/server_icons/5a/icon.png')).toBe(
      'https://db.harmony.test/storage/v1/object/public/server_icons/5a/icon.png',
    )
    expect(absoluteServerIconUrl('https://remote.test/icon.png')).toBe('https://remote.test/icon.png')
  })

  it('reads the bundled default and an empty value as no icon', () => {
    expect(absoluteServerIconUrl('/default_server.webp')).toBeNull()
    expect(absoluteServerIconUrl('')).toBeNull()
    expect(absoluteServerIconUrl(null)).toBeNull()
  })

  it('resolves another bundled image against the instance origin', () => {
    expect(absoluteServerIconUrl('/discord-bridge-bot.webp')).toBe('https://chat.harmony.test/discord-bridge-bot.webp')
    mocks.config.bridge.instanceDomain = ''
    expect(absoluteServerIconUrl('/discord-bridge-bot.webp')).toBeNull()
  })

  it('is null for a storage path when no base is set', () => {
    delete process.env.PUBLIC_URL
    delete process.env.SUPABASE_URL
    expect(absoluteServerIconUrl('5a/icon.png')).toBeNull()
  })
})
