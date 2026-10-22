import { describe, it, expect, vi } from 'vitest'

// systemNotes.ts: a system row as the Group's Note, and the Note back as local metadata.

vi.mock('../config/index.js', () => ({ default: { INSTANCE_DOMAIN: 'host.test' } }))

const {
  parseHarmonySystem,
  systemMetadata,
  systemNote,
  systemNoteText,
  systemPeopleIds,
  noteContentText,
  toHarmonySystem,
} = await import('../activitypub/systemNotes.js')

const SERVER = '00000000-0000-4000-8000-0000000000a1'
const CHANNEL = '00000000-0000-4000-8000-0000000000c1'
const ALICE = '00000000-0000-4000-8000-000000000001'
const REMOTE = '00000000-0000-4000-8000-000000000002'
const BOT = '00000000-0000-4000-8000-0000000000b1'
const THREAD = '00000000-0000-4000-8000-0000000000f1'

const people = {
  profiles: new Map([
    [ALICE, { id: ALICE, username: 'alice', display_name: 'Alice <3', federated_id: null }],
    [REMOTE, { id: REMOTE, username: 'rem', display_name: '', federated_id: 'https://member.test/users/rem' }],
  ]),
  bots: new Map([[BOT, { id: BOT, username: 'bridge', display_name: 'Discord Bridge' }]]),
}

const row = (metadata: Record<string, any>) => ({
  id: '00000000-0000-4000-8000-0000000000d1',
  created_at: '2026-10-22T00:00:00.000Z',
  metadata,
})

describe('serialize', () => {
  it('a join is the Group\'s Note naming the member by actor id', () => {
    const note = systemNote(row({ type: 'member_join', subject_id: REMOTE }), {
      hostDomain: 'host.test', serverId: SERVER, channelId: CHANNEL, people,
    })
    expect(note).toEqual({
      type: 'Note',
      id: 'https://host.test/messages/00000000-0000-4000-8000-0000000000d1',
      attributedTo: `https://host.test/servers/${SERVER}`,
      content: 'rem joined the server',
      context: `https://host.test/servers/${SERVER}/channels/${CHANNEL}`,
      published: '2026-10-22T00:00:00.000Z',
      'harmony:system': { type: 'member_join', subject: 'https://member.test/users/rem' },
    })
  })

  it('a kick names subject and actor; a local profile\'s actor id is on this host', () => {
    expect(toHarmonySystem({ type: 'member_kick', subject_id: REMOTE, actor_id: ALICE, reason: 'spam' }, people, 'host.test'))
      .toEqual({
        type: 'member_kick',
        subject: 'https://member.test/users/rem',
        actor: 'https://host.test/users/alice',
        reason: 'spam',
      })
  })

  it('a bridge thread notice names its Discord member or bot by name, and the thread by id', () => {
    expect(toHarmonySystem({
      type: 'thread_created', actor_bot_id: BOT, discord_user: { id: '1', username: 'finn', display_name: 'Finn' },
      thread_id: THREAD, thread_name: 'Lounge',
    }, people, 'host.test')).toEqual({
      type: 'thread_created', actorName: 'Finn', thread: `https://host.test/threads/${THREAD}`, threadName: 'Lounge',
    })
    expect(toHarmonySystem({ type: 'thread_created', actor_bot_id: BOT, thread_id: THREAD }, people, 'host.test'))
      .toMatchObject({ actorName: 'Discord Bridge' })
  })

  it('an AutoMod alert and an untyped row have no Note', () => {
    for (const metadata of [{ type: 'automod_alert', automod: {} }, {}]) {
      expect(systemNote(row(metadata), { hostDomain: 'host.test', serverId: SERVER, channelId: CHANNEL, people })).toBeNull()
    }
  })

  it('the activity form escapes names in HTML content', () => {
    const note = systemNote(row({ type: 'channel_encryption_enabled', actor_id: ALICE }), {
      hostDomain: 'host.test', serverId: SERVER, channelId: CHANNEL, people, html: true,
    })
    expect(note!.content).toBe('<p>Alice &lt;3 turned on end-to-end encryption</p>')
  })

  it('English text names a missing person "Someone" and carries the reason', () => {
    expect(systemNoteText({ type: 'member_ban', subject_id: '00000000-0000-4000-8000-0000000000ff', actor_id: ALICE, reason: 'raid' }, people))
      .toBe('Someone was banned by Alice <3: raid')
    expect(systemNoteText({ type: 'member_leave' }, people)).toBe('Someone left the server')
  })

  it('collects each named profile and bot once', () => {
    expect(systemPeopleIds([
      row({ type: 'member_kick', subject_id: REMOTE, actor_id: ALICE }),
      row({ type: 'member_join', subject_id: REMOTE }),
      row({ type: 'thread_created', actor_bot_id: BOT, actor_id: 'not-a-uuid' }),
    ])).toEqual({ profileIds: [REMOTE, ALICE], botIds: [BOT] })
  })
})

describe('parse', () => {
  it('maps actor ids back to local profiles and the thread url to its id', () => {
    const sys = parseHarmonySystem({
      type: 'member_kick', subject: 'https://member.test/users/rem', actor: 'https://host.test/users/alice',
      reason: ' spam ', thread: `https://host.test/threads/${THREAD}`, threadName: 'x',
    })!
    const ids: Record<string, string> = {
      'https://member.test/users/rem': 'local-rem', 'https://host.test/users/alice': 'local-alice',
    }
    expect(systemMetadata(sys, (url) => ids[url])).toEqual({
      type: 'member_kick', subject_id: 'local-rem', actor_id: 'local-alice', reason: 'spam',
      thread_id: THREAD, thread_name: 'x',
    })
  })

  it('an actor it cannot resolve falls back to actorName; an unresolved subject is left out', () => {
    const sys = parseHarmonySystem({ type: 'thread_created', actor: 'https://gone.test/u/x', actorName: 'Finn' })!
    expect(systemMetadata(sys, () => null)).toEqual({ type: 'thread_created', actor_name: 'Finn' })
    expect(systemMetadata(parseHarmonySystem({ type: 'member_join', subject: 'https://gone.test/u/x' })!, () => null))
      .toEqual({ type: 'member_join' })
  })

  it('refuses an unknown type, a non-object and people that are not http(s) URLs', () => {
    expect(parseHarmonySystem({ type: 'automod_alert' })).toBeNull()
    expect(parseHarmonySystem({ type: 'group_created' })).toBeNull()
    expect(parseHarmonySystem('member_join')).toBeNull()
    expect(parseHarmonySystem(['member_join'])).toBeNull()
    expect(parseHarmonySystem({ type: 'member_join', subject: 'ftp://member.test/users/rem', actor: 'javascript:x' }))
      .toEqual({ type: 'member_join' })
    expect(parseHarmonySystem({ type: 'member_join', subject: 'http://member.test/users/rem' }))
      .toEqual({ type: 'member_join', subject: 'http://member.test/users/rem' })
  })

  it('bounds names and reasons', () => {
    const sys = parseHarmonySystem({ type: 'member_ban', actorName: 'n'.repeat(500), reason: 'r'.repeat(5000) })!
    expect(sys.actorName).toHaveLength(100)
    expect(sys.reason).toHaveLength(512)
  })

  it('reads the content of an HTML Note as text', () => {
    expect(noteContentText('<p>Alice &lt;3 joined&nbsp;the server &amp; more</p>')).toBe('Alice <3 joined&nbsp;the server & more')
    expect(noteContentText(undefined)).toBe('')
  })
})
