import { describe, it, expect, vi, beforeEach } from 'vitest'

// profiles: local accounts named everyone and here (from before 20261031900001), and alice.
// The vitest VITE_DOMAIN is harmony.test.
const EVERYONE_USER = '00000000-0000-4000-8000-0000000e0e0e'
const HERE_USER = '00000000-0000-4000-8000-00000000e4e4'
const profiles = [
  { id: EVERYONE_USER, username: 'everyone', domain: 'harmony.test', display_name: 'Everyone', is_local: true },
  { id: HERE_USER, username: 'here', domain: 'harmony.test', display_name: 'Here', is_local: true },
  { id: '00000000-0000-4000-8000-00000000a11c', username: 'alice', domain: 'harmony.test', display_name: 'Alice', is_local: true },
]
const lookedUp: string[][] = []

vi.mock('@/supabase', () => {
  const query = () => {
    let rows = [...profiles]
    const q: any = {
      select: () => q,
      in: (col: string, vals: string[]) => { lookedUp.push(vals); rows = rows.filter((r: any) => vals.includes(r[col])); return q },
      eq: (col: string, v: unknown) => { rows = rows.filter((r: any) => r[col] === v); return q },
      or: (filter: string) => {
        const pairs = [...filter.matchAll(/and\(username\.eq\.([^,]+),domain\.eq\.([^)]+)\)/g)]
        rows = rows.filter((r: any) => pairs.some(([, u, d]) => r.username === u && r.domain === d))
        return q
      },
      then: (resolve: any) => resolve({ data: rows, error: null }),
    }
    return q
  }
  return {
    supabase: {
      from: () => query(),
      auth: {
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        getSession: async () => ({ data: { session: null } }),
      },
      channel: () => ({ on() { return this }, subscribe() { return this } }),
    },
  }
})

import { resolveMentionsUserData, parseContentToMessageParts } from '@/utils/unifiedContentProcessing'
import { messagePartsToMarkdown } from '@/utils/messageContentUtils'

const ROLE = { id: '00000000-0000-4000-8000-0000000000e0', name: '@everyone', color: null }
const ALLOWED = { allowed: true, everyoneRole: ROLE }
const REFUSED = { allowed: false, everyoneRole: ROLE }
const EVERYONE_PART = { type: 'role_mention', roleId: ROLE.id, roleName: 'everyone', roleColor: null }
const HERE_PART = { type: 'role_mention', roleId: 'here', roleName: 'here', roleColor: null }

const parse = async (text: string, massMentions?: typeof ALLOWED) =>
  parseContentToMessageParts(text, await resolveMentionsUserData(text), {}, {}, {}, { massMentions } as any)
const kinds = (parts: any[]) => parts.filter((p) => p.type !== 'text')
const plain = (parts: any[]) => parts.map((p) => (p.type === 'text' ? p.text : `<${p.type}:${p.userId ?? p.roleId}>`)).join('')

beforeEach(() => { lookedUp.length = 0 })

describe('typed @everyone and @here', () => {
  it('are the mass mentions for an author holding MENTION_EVERYONE', async () => {
    const parts = await parse('@everyone standup, @here too', ALLOWED)
    expect(kinds(parts)).toEqual([EVERYONE_PART, HERE_PART])
    expect(plain(parts)).toBe(`<role_mention:${ROLE.id}> standup, <role_mention:here> too`)
  })

  it('are text for an author without it', async () => {
    const parts = await parse('@everyone standup, @here too', REFUSED)
    expect(kinds(parts)).toEqual([])
    expect(plain(parts)).toBe('@everyone standup, @here too')
  })

  it('are text where no channel decides, as in DMs and posts', async () => {
    const parts = await parse('@everyone and @here')
    expect(kinds(parts)).toEqual([])
    expect(plain(parts)).toBe('@everyone and @here')
  })

  it('never name the users called everyone and here, nor look them up', async () => {
    for (const options of [ALLOWED, REFUSED, undefined]) {
      const parts = await parse('@everyone @here @Everyone @HERE', options)
      expect(parts.some((p: any) => p.type === 'mention')).toBe(false)
    }
    expect(lookedUp.flat()).not.toContain('everyone')
    expect(lookedUp.flat()).not.toContain('here')
    expect(await resolveMentionsUserData('@everyone @here')).toEqual({})
  })

  it('ping in lowercase only, as on Discord', async () => {
    const parts = await parse('@Everyone @HERE', ALLOWED)
    expect(kinds(parts)).toEqual([])
    expect(plain(parts)).toBe('@Everyone @HERE')
  })

  it('are text inside inline code and URLs', async () => {
    const parts = await parse('`@everyone` https://x.test/@here', ALLOWED)
    expect(kinds(parts).filter((p: any) => p.type === 'role_mention' || p.type === 'mention')).toEqual([])
  })

  it('need the default role for @everyone; @here needs none', async () => {
    const parts = await parse('@everyone @here', { allowed: true, everyoneRole: null })
    expect(kinds(parts)).toEqual([HERE_PART])
  })

  it('leave longer names alone', async () => {
    const parts = await parse('@alice @everyones', ALLOWED)
    expect(parts.filter((p: any) => p.type === 'role_mention')).toEqual([])
    expect(parts.filter((p: any) => p.type === 'mention').map((p: any) => p.username)).toEqual(['alice', 'everyones'])
  })
})

describe('a user named everyone', () => {
  it('is mentioned with the host', async () => {
    const parts = await parse('hi @everyone@harmony.test', ALLOWED)
    expect(parts.filter((p: any) => p.type === 'mention')).toEqual([
      expect.objectContaining({ userId: EVERYONE_USER, username: 'everyone', isLocal: true }),
    ])
    expect(parts.some((p: any) => p.type === 'role_mention')).toBe(false)
  })

  it('keeps the host through the editor text, so an edit does not turn it into the mass mention', async () => {
    const [mention] = (await parse('@everyone@harmony.test')).filter((p: any) => p.type === 'mention')
    const text = messagePartsToMarkdown([mention, { type: 'text', text: ' hi' }])
    expect(text).toBe('@everyone@harmony.test hi')
    const again = await parse(text, ALLOWED)
    expect(again.filter((p: any) => p.type === 'mention').map((p: any) => p.userId)).toEqual([EVERYONE_USER])
  })

  it('on another instance is that instance\'s user', async () => {
    const parts = await parse('@everyone@other.test', ALLOWED)
    expect(parts.filter((p: any) => p.type === 'mention')).toEqual([
      expect.objectContaining({ username: 'everyone', domain: 'other.test', isLocal: false }),
    ])
  })
})
