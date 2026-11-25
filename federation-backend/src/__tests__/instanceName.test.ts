import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The instance's name for other servers: the stored name, else INSTANCE_NAME, else the domain.

const config = { INSTANCE_DOMAIN: 'chat.example.org', INSTANCE_NAME: 'Harmony Test' }
vi.mock('../config/index.js', () => ({ default: config }))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { resolveInstanceName, instanceName, cachedInstanceName, clearInstanceNameCache, INSTANCE_NAME_TTL_MS } =
  await import('../utils/instanceName.js')

describe('resolveInstanceName', () => {
  it('takes the stored name, trimmed, also JSON-encoded', () => {
    expect(resolveInstanceName(' Example Chat ')).toBe('Example Chat')
    expect(resolveInstanceName('"Example Chat"')).toBe('Example Chat')
  })

  it('falls back to INSTANCE_NAME for a blank, absent or non-string value', () => {
    for (const v of ['', '  ', '""', null, undefined, 3, { name: 'x' }]) expect(resolveInstanceName(v)).toBe('Harmony Test')
  })

  it('falls back to the domain when INSTANCE_NAME is blank too', () => {
    config.INSTANCE_NAME = ' '
    try {
      expect(resolveInstanceName('')).toBe('chat.example.org')
    } finally {
      config.INSTANCE_NAME = 'Harmony Test'
    }
  })
})

/** instance_config as PostgREST answers it. `answer` is read when the lookup resolves. */
function fakeDb(answer: () => unknown) {
  const reads = { count: 0 }
  const client = {
    from: (table: string) => {
      expect(table).toBe('instance_config')
      const chain: any = {
        select: () => chain,
        eq: (column: string, key: string) => (expect([column, key]).toEqual(['config_key', 'instance_name']), chain),
        maybeSingle: async () => {
          reads.count++
          const value = answer()
          if (value instanceof Error) throw value
          return value as { data: unknown; error: unknown }
        },
      }
      return chain
    },
  }
  return { client, reads }
}
const row = (value: unknown) => ({ data: { config_value: value }, error: null })

describe('instanceName', () => {
  it('reads the stored name', async () => {
    expect(await instanceName(fakeDb(() => row('Example Chat')).client)).toBe('Example Chat')
  })

  it('answers the fallback when the read fails or throws', async () => {
    expect(await instanceName(fakeDb(() => ({ data: null, error: { message: 'down' } })).client)).toBe('Harmony Test')
    expect(await instanceName(fakeDb(() => new Error('fetch failed')).client)).toBe('Harmony Test')
  })
})

describe('cachedInstanceName', () => {
  beforeEach(() => {
    clearInstanceNameCache()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('holds the name for INSTANCE_NAME_TTL_MS, then reads it again', async () => {
    let name = 'Example Chat'
    const db = fakeDb(() => row(name))
    expect(await cachedInstanceName(db.client)).toBe('Example Chat')
    name = 'Renamed Chat'
    vi.advanceTimersByTime(INSTANCE_NAME_TTL_MS - 1)
    expect(await cachedInstanceName(db.client)).toBe('Example Chat')
    vi.advanceTimersByTime(1)
    expect(await cachedInstanceName(db.client)).toBe('Renamed Chat')
    expect(db.reads.count).toBe(2)
  })

  it('shares one read among concurrent callers', async () => {
    const db = fakeDb(() => row('Example Chat'))
    const names = await Promise.all([cachedInstanceName(db.client), cachedInstanceName(db.client), cachedInstanceName(db.client)])
    expect(names).toEqual(['Example Chat', 'Example Chat', 'Example Chat'])
    expect(db.reads.count).toBe(1)
  })

  it('holds no failed read', async () => {
    let answer: unknown = { data: null, error: { message: 'down' } }
    const db = fakeDb(() => answer)
    expect(await cachedInstanceName(db.client)).toBe('Harmony Test')
    answer = new Error('fetch failed')
    expect(await cachedInstanceName(db.client)).toBe('Harmony Test')
    answer = row('Example Chat')
    expect(await cachedInstanceName(db.client)).toBe('Example Chat')
    expect(db.reads.count).toBe(3)
  })

  it('holds an absent row as the fallback', async () => {
    const db = fakeDb(() => ({ data: null, error: null }))
    expect(await cachedInstanceName(db.client)).toBe('Harmony Test')
    expect(await cachedInstanceName(db.client)).toBe('Harmony Test')
    expect(db.reads.count).toBe(1)
  })

  it('reads again after clearInstanceNameCache(), and holds no read begun before it', async () => {
    let name = 'Example Chat'
    const db = fakeDb(() => row(name))
    const early = cachedInstanceName(db.client)
    clearInstanceNameCache()
    name = 'Renamed Chat'
    const late = cachedInstanceName(db.client)
    expect(await early).toBe('Example Chat')
    expect(await late).toBe('Renamed Chat')
    expect(await cachedInstanceName(db.client)).toBe('Renamed Chat')
    expect(db.reads.count).toBe(2)
  })
})
