import { describe, expect, it } from 'vitest'
import { customEmojiLabel, humanizeEmojiName, spokenEmojiName } from '../emojiNames'
import { messageSpeechText, summarizeIncoming, systemEventSpeechText, type Translate } from '../messageSpeech'
import type { MessagePart } from '@/types'

/** Key plus its params, so assertions read what each piece was built from. */
const t: Translate = (key, params) => {
  if (!params) return key
  const args = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')
  return `${key}(${args})`
}

describe('emoji names', () => {
  it('turns shortcodes into words', () => {
    expect(humanizeEmojiName('thumbs_up')).toBe('thumbs up')
    expect(humanizeEmojiName(':grinning_face:')).toBe('grinning face')
    expect(humanizeEmojiName('flag-jp')).toBe('flag jp')
    expect(humanizeEmojiName(undefined)).toBe('')
  })

  it('keeps custom emoji in :name: form', () => {
    expect(customEmojiLabel('party_parrot')).toBe(':party_parrot:')
    expect(customEmojiLabel(':blob:')).toBe(':blob:')
    expect(customEmojiLabel('')).toBe('')
  })

  it('names an emoji by kind', () => {
    expect(spokenEmojiName({ url: 'https://cdn/x.png', name: 'blob_wave' })).toBe(':blob_wave:')
    expect(spokenEmojiName({ shortcode: 'red_heart', native: '❤️' })).toBe('red heart')
    expect(spokenEmojiName({ name: 'thumbs up', native: '👍' })).toBe('thumbs up')
    // A name that is the character itself falls back to the character.
    expect(spokenEmojiName({ name: '👍', native: '👍' })).toBe('👍')
  })
})

describe('messageSpeechText', () => {
  it('speaks text, mentions and custom emoji', () => {
    const parts = [
      { type: 'mention', userId: 'u1', username: 'alice' },
      { type: 'text', text: ' look ' },
      { type: 'emoji', emoji: { id: 'e1', name: 'blob', url: 'https://cdn/blob.png' } },
    ] as unknown as MessagePart[]
    expect(messageSpeechText(parts, t)).toBe('@alice look :blob:')
  })

  it('never speaks a spoiler or an encrypted body', () => {
    expect(messageSpeechText([{ type: 'text', text: 'the end: ||he dies|| sad' }] as MessagePart[], t))
      .toBe('the end: messageA11y.speech.spoiler sad')
    expect(messageSpeechText([{ type: 'text', text: 'c2VjcmV0' }] as MessagePart[], t, { encrypted: true }))
      .toBe('messageA11y.speech.encrypted')
  })

  it('names attachments by kind and description, never by file name', () => {
    const parts = [
      { type: 'file', fileType: 'image', url: 'u', fileName: 'IMG_1.png', altText: 'a cat' },
      { type: 'file', fileType: 'image', url: 'u', fileName: 'IMG_2.png' },
      { type: 'file', fileType: 'file', url: 'u', fileName: 'notes.pdf' },
    ] as unknown as MessagePart[]
    expect(messageSpeechText(parts, t)).toBe(
      'messageA11y.speech.imageWithAlt(alt=a cat) messageA11y.speech.image messageA11y.speech.file(name=notes.pdf)',
    )
  })

  it('truncates long text', () => {
    const text = messageSpeechText([{ type: 'text', text: 'x'.repeat(500) }] as MessagePart[], t, { max: 20 })
    expect(text).toHaveLength(20)
    expect(text.endsWith('…')).toBe(true)
  })
})

describe('systemEventSpeechText', () => {
  const ME = '00000000-0000-4000-8000-000000000001'
  const BOB = '00000000-0000-4000-8000-000000000002'
  const CAROL = '00000000-0000-4000-8000-000000000003'
  const THREAD = '00000000-0000-4000-8000-0000000000f1'
  const names = { user: (id: string) => ({ [ME]: 'Me', [BOB]: 'Bob', [CAROL]: 'Carol' })[id] ?? '' }

  it('names a join by metadata, with the event phrase, never the stored content', () => {
    const text = systemEventSpeechText({ type: 'member_join', subject_id: BOB }, t, { names })
    expect(text).toBe('systemEvents.memberJoin(subject=Bob)')
    expect(text).not.toContain(BOB)
  })

  it('falls back to the event\'s Someone when the member is unknown or missing', () => {
    expect(systemEventSpeechText({ type: 'member_join', subject_id: BOB }, t))
      .toBe('systemEvents.memberJoin(subject=systemEvents.someone)')
    expect(systemEventSpeechText({ type: 'member_leave' }, t, { names }))
      .toBe('systemEvents.memberLeave(subject=systemEvents.someone)')
  })

  it('names the threaded member and reads the link as text, not the thread id', () => {
    const text = systemEventSpeechText(
      { type: 'thread_created', actor_id: BOB, thread_id: THREAD, thread_name: 'Plans' },
      t,
      { names },
    )
    expect(text).toBe('systemEvents.threadCreated(actor=Bob,thread=Plans,allThreads=systemEvents.allThreads)')
    expect(text).not.toContain(THREAD)
  })

  it('reads a kick with its moderator and reason', () => {
    expect(systemEventSpeechText({ type: 'member_kick', subject_id: BOB, actor_id: CAROL, reason: 'spam' }, t, { names }))
      .toBe('systemEvents.memberKick(actor=Carol,subject=Bob) systemEvents.reason(reason=spam)')
    expect(systemEventSpeechText({ type: 'member_ban', subject_id: BOB, actor_id: CAROL }, t, { names }))
      .toBe('systemEvents.memberBan(actor=Carol,subject=Bob)')
  })

  it('reads a missed call from the viewer and an unanswered one they started', () => {
    expect(systemEventSpeechText(
      { type: 'call_ended', actor_id: BOB, call_type: 'voice', participants: [BOB] },
      t,
      { names, currentUserId: 'me' },
    )).toBe('systemEvents.callMissed.voice(actor=Bob)')
    expect(systemEventSpeechText(
      { type: 'call_ended', actor_id: ME, call_type: 'voice', participants: [ME] },
      t,
      { names, currentUserId: ME },
    )).toBe('systemEvents.callStarted.voice(actor=Me) systemEvents.noAnswer')
  })

  it('reads the encryption toggles and names no sentence for an unknown type', () => {
    expect(systemEventSpeechText({ type: 'channel_voice_encryption_disabled', actor_id: CAROL }, t, { names }))
      .toBe('systemEvents.voiceEncryptionDisabled(actor=Carol)')
    expect(systemEventSpeechText({ type: 'something_new' }, t, { names })).toBe('')
  })
})

describe('summarizeIncoming', () => {
  it('speaks one message as author and text', () => {
    expect(summarizeIncoming([{ authorName: 'Alice', text: 'hi' }], t)).toBe('messageA11y.announce.one(name=Alice,text=hi)')
    expect(summarizeIncoming([{ authorName: 'Alice', text: '' }], t)).toBe('messageA11y.announce.oneEmpty(name=Alice)')
  })

  it('sums a burst by count and distinct authors', () => {
    const burst = [
      { authorName: 'Alice', text: 'a' },
      { authorName: 'Bob', text: 'b' },
      { authorName: 'Alice', text: 'c' },
    ]
    expect(summarizeIncoming(burst, t)).toBe('messageA11y.announce.many(count=3,names=Alice, Bob)')
  })

  it('lists three authors and counts the rest', () => {
    const burst = ['A', 'B', 'C', 'D', 'E'].map((authorName) => ({ authorName, text: 'x' }))
    expect(summarizeIncoming(burst, t)).toBe(
      'messageA11y.announce.many(count=5,names=messageA11y.announce.andOthers(names=A, B, C,count=2))',
    )
  })

  it('says nothing for nothing', () => {
    expect(summarizeIncoming([], t)).toBe('')
  })
})

describe('mentions', () => {
  it('reads a role as a role, and a member of the same name as a handle', () => {
    const parts = [
      { type: 'mention', userId: 'u1', username: 'crew', domain: 'harmony.test', isLocal: true },
      { type: 'text', text: ' and ' },
      { type: 'role_mention', roleId: 'r1', roleName: 'crew', roleColor: null },
    ] as MessagePart[]
    expect(messageSpeechText(parts, t)).toBe('@crew and mentionLabels.rolePill(name=crew)')
  })
})
