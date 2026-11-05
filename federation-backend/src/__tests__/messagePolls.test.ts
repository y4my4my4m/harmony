import { describe, it, expect, vi } from 'vitest'

// Chat message polls over federation (activitypub/messagePolls.ts): the poll a Note carries out
// and in, Mastodon's vote shape, and the text fallback older readers get.

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    SUPABASE_URL: 'http://localhost:54321',
    PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  dmPollQuestion,
  harmonyPollExtension,
  inboundPollOf,
  isPollVoteNote,
  messagePollByObjectId,
  parsePollFields,
  pollObjectId,
  pollQuestionFields,
  questionText,
  withPollPart,
  type FederatedPoll,
} from '../activitypub/messagePolls.js'
import { channelMessageActivity } from '../activitypub/channelMessageActivity.js'
import { convertContentToHTML } from '../utils/contentUtils.js'

const NOW = Date.parse('2026-11-05T12:00:00Z')

const poll = (over: Partial<FederatedPoll> = {}): FederatedPoll => ({
  messageId: 'm1',
  pollId: 'p1',
  question: 'Lunch?',
  allowMultiple: false,
  expiresAt: '2026-11-06T12:00:00Z',
  remote: false,
  apId: null,
  voters: 3,
  options: [
    { position: 0, text: 'Pizza', votes: 2 },
    { position: 1, text: 'Soup', votes: 1 },
  ],
  ...over,
})

describe('the poll going out', () => {
  it('is a Question\'s poll fields: oneOf with counts, endTime, votersCount', () => {
    expect(pollQuestionFields(poll(), NOW)).toEqual({
      oneOf: [
        { type: 'Note', name: 'Pizza', replies: { type: 'Collection', totalItems: 2 } },
        { type: 'Note', name: 'Soup', replies: { type: 'Collection', totalItems: 1 } },
      ],
      endTime: '2026-11-06T12:00:00.000Z',
      votersCount: 3,
    })
  })

  it('names the answers anyOf for multiple choice and carries closed once ended', () => {
    const fields = pollQuestionFields(poll({ allowMultiple: true, expiresAt: '2026-11-05T11:00:00Z' }), NOW)
    expect(Object.keys(fields)).toEqual(['anyOf', 'endTime', 'closed', 'votersCount'])
    expect(fields.closed).toBe('2026-11-05T11:00:00.000Z')
  })

  it('rides on a channel message Note as harmony:poll, the text fallback left in place', () => {
    const message = {
      id: '00000000-0000-0000-0000-0000000000a1',
      created_at: '2026-11-05T12:00:00Z',
      updated_at: '2026-11-05T12:00:00Z',
      author: { username: 'alice' },
      content: [
        { type: 'poll', pollId: 'p1', question: 'Lunch?', options: ['Pizza', 'Soup'], allowMultiple: false },
        { type: 'text', text: '📊 Lunch?\n1. Pizza\n2. Soup' },
      ],
      poll: poll(),
    }
    const note = channelMessageActivity(message, { id: 's1', name: 'S' }, 'c1', 'general', 'Create', 'peer.test').object
    expect(note.type).toBe('Note')
    expect(note['harmony:poll']).toMatchObject({ type: 'Question', name: 'Lunch?', votersCount: 3 })
    expect(note['harmony:poll'].oneOf.map((o: any) => o.name)).toEqual(['Pizza', 'Soup'])
    expect(note['harmony:rawContent']).toEqual([{ type: 'text', text: '📊 Lunch?\n1. Pizza\n2. Soup' }])
    expect(note.content).toBe('📊 Lunch?<br />1. Pizza<br />2. Soup')
  })

  it('reaches other software in a direct message as a Question whose content is the question', () => {
    const q = dmPollQuestion(
      { id: 'https://harmony.test/messages/m1', type: 'Note', content: 'x', contentMap: { en: 'x' }, 'harmony:poll': {}, to: ['a'] },
      poll({ question: 'Tea <or> coffee?' }),
      NOW,
    )
    expect(q.type).toBe('Question')
    expect(q.content).toBe('<p>Tea &lt;or&gt; coffee?</p>')
    expect(q.contentMap).toEqual({ en: '<p>Tea &lt;or&gt; coffee?</p>' })
    expect(q['harmony:poll']).toBeUndefined()
    expect(q.oneOf).toHaveLength(2)
    expect(q.to).toEqual(['a'])
  })

  it('is named by its message\'s Note id', () => {
    expect(pollObjectId({ apId: null, messageApId: null, messageId: 'm1' })).toBe('https://harmony.test/messages/m1')
    expect(pollObjectId({ apId: 'https://peer.test/messages/x', messageApId: null, messageId: 'm1' })).toBe('https://peer.test/messages/x')
    expect(pollObjectId({ apId: null, messageApId: 'https://peer.test/messages/y', messageId: 'm1' })).toBe('https://peer.test/messages/y')
  })
})

describe('the poll coming in', () => {
  it('reads harmony:poll on a Note', () => {
    const got = inboundPollOf({ type: 'Note', 'harmony:poll': harmonyPollExtension(poll(), NOW) }, NOW)
    expect(got).toEqual({
      question: 'Lunch?', options: ['Pizza', 'Soup'], votes: [2, 1], voters: 3, allowMultiple: false,
      answers: [{ name: 'Pizza', votes: 2 }, { name: 'Soup', votes: 1 }], endsAt: '2026-11-06T12:00:00.000Z',
    })
  })

  it('reads a Mastodon Question, its question without the leading mention', () => {
    const got = inboundPollOf({
      type: 'Question',
      content: '<p><span class="h-card"><a href="https://harmony.test/users/bob" class="u-url mention">@<span>bob</span></a></span> Tea &amp; cake?</p>',
      endTime: '2026-11-06T12:00:00Z',
      anyOf: [
        { type: 'Note', name: 'Tea', replies: { type: 'Collection', totalItems: 4 } },
        { type: 'Note', name: 'Cake', replies: { type: 'Collection', totalItems: 1 } },
      ],
      votersCount: 4,
    }, NOW)
    expect(got?.question).toBe('Tea & cake?')
    expect(got?.allowMultiple).toBe(true)
    expect(got?.votes).toEqual([4, 1])
  })

  it('takes a close time over the end time, and counts single-choice voters from the votes', () => {
    const fields = parsePollFields({
      endTime: '2026-11-06T12:00:00Z', closed: '2026-11-05T10:00:00Z',
      oneOf: [{ name: 'a', replies: { totalItems: 2 } }, { name: 'b', replies: { totalItems: 3 } }],
    }, NOW)
    expect(fields.endsAt).toBe('2026-11-05T10:00:00.000Z')
    expect(fields.voters).toBe(5)
    expect(parsePollFields({ closed: true, oneOf: [] }, NOW).endsAt).toBe(new Date(NOW).toISOString())
  })

  it('refuses a poll this instance cannot hold', () => {
    const one = { type: 'Question', content: '<p>Q?</p>', oneOf: [{ name: 'only' }] }
    const eleven = { type: 'Question', content: '<p>Q?</p>', oneOf: Array.from({ length: 11 }, (_, i) => ({ name: `a${i}` })) }
    const blank = { type: 'Question', content: '<p>Q?</p>', oneOf: [{ name: 'a' }, { name: '  ' }] }
    const noQuestion = { type: 'Question', content: '', oneOf: [{ name: 'a' }, { name: 'b' }] }
    expect([one, eleven, blank, noQuestion].map((q) => inboundPollOf(q, NOW))).toEqual([null, null, null, null])
    expect(inboundPollOf({ type: 'Note', content: '<p>no poll</p>' }, NOW)).toBeNull()
  })

  it('cuts the question to 300 and the answers to 100 characters', () => {
    const got = inboundPollOf({ type: 'Question', content: `<p>${'q'.repeat(400)}</p>`, oneOf: [{ name: 'a'.repeat(150) }, { name: 'b' }] }, NOW)
    expect(got?.question.length).toBe(300)
    expect(got?.options[0].length).toBe(100)
  })

  it('puts the poll part in front of the content, spelling the poll out when there is no text', () => {
    const got = inboundPollOf({ type: 'Note', 'harmony:poll': harmonyPollExtension(poll(), NOW) }, NOW)!
    expect(withPollPart([{ type: 'text', text: '📊 Lunch?' }], 'p9', got).map((p) => p.type)).toEqual(['poll', 'text'])
    expect(withPollPart([], 'p9', got)).toEqual([
      { type: 'poll', pollId: 'p9', question: 'Lunch?', options: ['Pizza', 'Soup'], allowMultiple: false, expiresAt: '2026-11-06T12:00:00.000Z' },
      { type: 'text', text: '📊 Lunch?\n1. Pizza\n2. Soup' },
    ])
  })

  it('reads plain text of a Question\'s content', () => {
    expect(questionText('<p>@alice@peer.test @bob Where?</p>')).toBe('Where?')
    expect(questionText('<p>One<br>two</p>')).toBe('One\ntwo')
    expect(questionText(undefined)).toBe('')
  })
})

describe('votes', () => {
  it('are Mastodon\'s: a Note with name and inReplyTo and no content', () => {
    const vote = { type: 'Note', name: 'Pizza', inReplyTo: 'https://harmony.test/messages/m1' }
    expect(isPollVoteNote(vote)).toBe(true)
    expect(isPollVoteNote({ ...vote, content: '<p>a reply</p>' })).toBe(false)
    expect(isPollVoteNote({ ...vote, name: '' })).toBe(false)
    expect(isPollVoteNote({ ...vote, inReplyTo: undefined })).toBe(false)
    expect(isPollVoteNote({ ...vote, type: 'Question' })).toBe(false)
    expect(isPollVoteNote({ ...vote, 'harmony:rawContent': [] })).toBe(false)
  })
})

describe('messagePollByObjectId', () => {
  const client = (rows: any[]) => {
    const calls: Array<[string, unknown]> = []
    return {
      calls,
      from: () => {
        const q: any = {
          select: () => q,
          eq: (c: string, v: unknown) => { calls.push([c, v]); return q },
          maybeSingle: async () => ({ data: rows.find((r) => calls.every(([c, v]) => (c === 'message_id' ? r.message.id === v : r[c] === v))) ?? null }),
        }
        return q
      },
    }
  }
  const row = (metadata: Record<string, unknown> = {}) => ({
    id: 'p1', remote: false, ap_id: null,
    message: { id: '00000000-0000-0000-0000-0000000000a1', channel_id: 'c1', conversation_id: null, user_id: 'u1', metadata, channel: { server_id: 's1' } },
  })

  it('finds this instance\'s message by its URL', async () => {
    const got = await messagePollByObjectId(client([row()]), 'https://harmony.test/messages/00000000-0000-0000-0000-0000000000a1')
    expect(got).toMatchObject({ pollId: 'p1', serverId: 's1', remote: false })
  })

  it('does not take a message held under another instance\'s id for this instance\'s', async () => {
    const got = await messagePollByObjectId(client([row({ ap_id: 'https://peer.test/messages/00000000-0000-0000-0000-0000000000a1' })]),
      'https://harmony.test/messages/00000000-0000-0000-0000-0000000000a1')
    expect(got).toBeNull()
  })

  it('finds a copy by its ap_id', async () => {
    const c = client([{ ...row(), remote: true, ap_id: 'https://peer.test/messages/x' }])
    expect(await messagePollByObjectId(c, 'https://peer.test/messages/x')).toMatchObject({ remote: true })
    expect(c.calls).toEqual([['ap_id', 'https://peer.test/messages/x']])
    expect(await messagePollByObjectId(c, 'not a url')).toBeNull()
  })
})

describe('the text of a message as HTML', () => {
  it('keeps its line breaks as <br />, which HTML readers would collapse', () => {
    expect(convertContentToHTML([{ type: 'text', text: '📊 Q?\n1. a\n2. b' }])).toBe('📊 Q?<br />1. a<br />2. b')
    expect(convertContentToHTML('one\r\ntwo')).toBe('one<br />two')
    expect(convertContentToHTML([{ type: 'bold', text: 'x\ny' }])).toBe('<strong>x<br />y</strong>')
    expect(convertContentToHTML([{ type: 'codeblock', text: 'a\nb' }])).toBe('<pre><code>a\nb</code></pre>')
  })
})
