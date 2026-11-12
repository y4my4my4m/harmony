import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('../../config/supabase.js', () => ({
  supabaseUrl: 'http://127.0.0.1:1',
  supabaseServiceKey: 'service-key',
  supabase: { from: mocks.from, rpc: mocks.rpc },
  config: {},
}))

import {
  applyBridgeAttachmentPolicy,
  getBridgeAttachmentMode,
  isAllowedSourceUrl,
  mirrorAllows,
  readBridgeAttachmentMode,
} from '../mirrorExternalMedia.js'

const CHANNEL = '00000000-0000-4000-8000-0000000000c1'
const BOT = '00000000-0000-4000-8000-0000000000b1'

/** Every instance_config read answers `result`. */
function configRead(result: { data: unknown; error: { message: string } | null }) {
  const q: any = { select: () => q, eq: () => q, maybeSingle: async () => result }
  mocks.from.mockReturnValue(q)
}
const mirrorMode = () => configRead({ data: { config_value: '"mirror"' }, error: null })

beforeEach(() => {
  mocks.from.mockReset()
  mocks.rpc.mockReset()
  mocks.rpc.mockResolvedValue({ data: true, error: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isAllowedSourceUrl', () => {
  it('allows http and https on discordapp.com, discordapp.net and their subdomains', () => {
    for (const url of [
      'https://cdn.discordapp.com/attachments/1/2/a.png',
      'https://media.discordapp.net/attachments/1/2/a.png?width=10',
      'https://images-ext-1.discordapp.net/external/x/https/example.com/a.png',
      'https://discordapp.com/a.png',
      'http://cdn.discordapp.com/attachments/1/2/a.png',
      'HTTPS://CDN.DISCORDAPP.COM/a.png',
    ]) expect(isAllowedSourceUrl(url), url).toBe(true)
  })

  it('refuses other hosts, other schemes and what is not a URL', () => {
    for (const url of [
      'https://evil.example/a.png',
      'https://cdn.discordapp.com.evil.example/a.png',
      'https://notdiscordapp.com/a.png',
      'https://evil.example/https://cdn.discordapp.com/a.png',
      'https://cdn.discordapp.com@evil.example/a.png',
      'ftp://cdn.discordapp.com/a.png',
      'file://cdn.discordapp.com/etc/passwd',
      'javascript://cdn.discordapp.com/%0aalert(1)',
      '//cdn.discordapp.com/a.png',
      'not a url',
      '',
    ]) expect(isAllowedSourceUrl(url), url).toBe(false)
  })
})

describe('bridge attachment mode', () => {
  it('reads link, refresh and mirror, and link for anything else', async () => {
    for (const [stored, mode] of [['"mirror"', 'mirror'], ['refresh', 'refresh'], ['"link"', 'link'], ['"other"', 'link']] as const) {
      configRead({ data: { config_value: stored }, error: null })
      expect(await readBridgeAttachmentMode()).toBe(mode)
      expect(await getBridgeAttachmentMode()).toBe(mode)
    }
    configRead({ data: null, error: null })
    expect(await readBridgeAttachmentMode()).toBe('link')
  })

  it('answers link from getBridgeAttachmentMode and throws from readBridgeAttachmentMode when the read fails', async () => {
    configRead({ data: null, error: { message: 'connection refused' } })
    expect(await getBridgeAttachmentMode()).toBe('link')
    await expect(readBridgeAttachmentMode()).rejects.toThrow(/bridge_attachment_mode read failed: connection refused/)
  })
})

describe('mirrorAllows', () => {
  it('asks bridge_mirror_allows and answers true only for true', async () => {
    expect(await mirrorAllows(CHANNEL, 42)).toBe(true)
    expect(mocks.rpc).toHaveBeenCalledWith('bridge_mirror_allows', { p_channel_id: CHANNEL, p_bytes: 42 })
    mocks.rpc.mockResolvedValue({ data: false, error: null })
    expect(await mirrorAllows(CHANNEL, 42)).toBe(false)
    mocks.rpc.mockResolvedValue({ data: null, error: null })
    expect(await mirrorAllows(CHANNEL, 42)).toBe(false)
  })

  it('throws when the answer cannot be read', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'function not found' } })
    await expect(mirrorAllows(CHANNEL, 42)).rejects.toThrow(/bridge_mirror_allows failed: function not found/)
  })
})

describe('applyBridgeAttachmentPolicy and the server cap', () => {
  const part = { type: 'file', fileType: 'image', url: 'https://cdn.discordapp.com/attachments/1/2/cat.png?ex=1', fileSize: 2048 }

  it('keeps the Discord link and defers, without a download, when the cap refuses a file of known size', async () => {
    mirrorMode()
    mocks.rpc.mockResolvedValue({ data: false, error: null })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(applyBridgeAttachmentPolicy([part], BOT, CHANNEL)).resolves.toEqual({ parts: [part], deferred: true })
    expect(mocks.rpc).toHaveBeenCalledWith('bridge_mirror_allows', { p_channel_id: CHANNEL, p_bytes: 2048 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps the Discord link and defers, the body unread, when the cap refuses the Content-Length', async () => {
    mirrorMode()
    mocks.rpc.mockResolvedValue({ data: false, error: null })
    const cancel = vi.fn(async () => {})
    const body = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(4)) }, cancel })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'image/png', 'content-length': '4096' } })))
    const sizeless = { type: 'url', url: part.url }

    await expect(applyBridgeAttachmentPolicy([sizeless], BOT, CHANNEL)).resolves.toEqual({ parts: [sizeless], deferred: true })
    expect(mocks.rpc).toHaveBeenCalledWith('bridge_mirror_allows', { p_channel_id: CHANNEL, p_bytes: 4096 })
    expect(cancel).toHaveBeenCalled()
  })

  it('keeps the Discord link and defers when the cap cannot be read', async () => {
    mirrorMode()
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'connection refused' } })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(applyBridgeAttachmentPolicy([part], BOT, CHANNEL)).resolves.toEqual({ parts: [part], deferred: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('asks nothing outside mirror mode', async () => {
    configRead({ data: { config_value: '"link"' }, error: null })
    await expect(applyBridgeAttachmentPolicy([part], BOT, CHANNEL)).resolves.toEqual({ parts: [part], deferred: false })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
