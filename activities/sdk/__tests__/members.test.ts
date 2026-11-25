import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Member names and images inside the frame: name parts become object URLs, a profile message
// replaces them and fires `member`, and every URL a member was given is revoked once it is replaced.

const APP = 'https://harmony.test'
const listeners: Array<(event: unknown) => void> = []
const parent = { opener: null as unknown, postMessage: vi.fn() }
const image = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })

let urls: number
const revoked: string[] = []

const say = (data: unknown) => listeners.forEach((l) => l({ source: parent, origin: APP, data }))

async function room() {
  vi.resetModules()
  const { connect } = await import('../index')
  const pending = connect({ timeoutMs: 50 })
  say({
    hp: 1, t: 'init', you: 'me', host: 'me', canEnd: false, locale: 'en', visible: true, state: null, clockOffset: 0,
    theme: { scheme: 'dark', accent: '#0EA5E9', reducedMotion: false },
    session: { id: 's1', appId: 'a', context: 'direct', startedBy: 'me', maxPlayers: 4, minPlayers: 1 },
    members: [
      { id: 'me', name: 'Me', username: 'me', avatarUrl: null, joinedAt: 1, spectator: false, state: null, avatarBlob: null, nameParts: [{ text: 'Me' }] },
      {
        id: 'sp', name: 'Spartzy !', username: 'sp', avatarUrl: null, joinedAt: 2, spectator: false, state: null, avatarBlob: null,
        nameParts: [{ text: 'Spartzy ' }, { emoji: 'cat', image: null }, { text: ' !' }],
      },
    ],
  })
  return pending
}

beforeEach(() => {
  listeners.length = 0
  urls = 0
  revoked.length = 0
  vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, listener: any) => { if (type === 'message') listeners.push(listener) }) as any)
  vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as any)
  vi.stubGlobal('location', { origin: APP, get ancestorOrigins() { return [APP] } })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++urls}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => { revoked.push(url) })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('member names and images', () => {
  it('gives a name emoji without its image a null src', async () => {
    const r = await room()
    expect(r.member('sp')?.name).toBe('Spartzy !')
    expect(r.member('sp')?.nameParts).toEqual([{ text: 'Spartzy ' }, { emoji: 'cat', src: null }, { text: ' !' }])
    expect(r.member('sp')?.avatar).toBeNull()
  })

  it('takes a profile message: new parts and avatar as object URLs, a member event, the old URLs revoked', async () => {
    const r = await room()
    const changed = vi.fn()
    r.on('member', changed)
    say({ hp: 1, t: 'profile', id: 'sp', name: 'Spartzy !', nameParts: [{ text: 'Spartzy ' }, { emoji: 'cat', image: image() }, { text: ' !' }], avatarBlob: image() })
    const sp = r.member('sp')!
    expect(sp.nameParts).toEqual([{ text: 'Spartzy ' }, { emoji: 'cat', src: 'blob:1' }, { text: ' !' }])
    expect(sp.avatar).toBe('blob:2')
    expect(changed).toHaveBeenCalledWith(sp)
    say({ hp: 1, t: 'profile', id: 'sp', name: 'Spartzy', nameParts: [{ text: 'Spartzy' }], avatarBlob: null })
    expect(r.member('sp')?.avatar).toBeNull()
    expect(revoked.sort()).toEqual(['blob:1', 'blob:2'])
  })

  it('ignores a profile message for someone who is not a member', async () => {
    const r = await room()
    const changed = vi.fn()
    r.on('member', changed)
    say({ hp: 1, t: 'profile', id: 'nobody', name: 'X', nameParts: [], avatarBlob: image() })
    expect(changed).not.toHaveBeenCalled()
    expect(urls).toBe(0)
  })

  it('revokes a rejoining member\'s emoji URLs', async () => {
    const r = await room()
    say({ hp: 1, t: 'profile', id: 'sp', name: 'Spartzy !', nameParts: [{ emoji: 'cat', image: image() }], avatarBlob: null })
    say({ hp: 1, t: 'join', member: { id: 'sp', name: 'Spartzy !', username: 'sp', avatarUrl: null, joinedAt: 3, spectator: false, state: null, avatarBlob: null, nameParts: [{ text: 'Spartzy !' }] } })
    expect(revoked).toEqual(['blob:1'])
    expect(r.member('sp')?.nameParts).toEqual([{ text: 'Spartzy !' }])
  })
})
