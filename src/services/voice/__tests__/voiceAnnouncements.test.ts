import { beforeEach, describe, expect, it, vi } from 'vitest'

// Spoken voice events: wording (English messages), politeness, keys, and the
// speaking rules (rising edge after silence or on a turn change, verbose only).

const announce = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useAnnouncer', () => ({ announce }))
vi.mock('@/composables/useUserData', () => ({ useUserData: () => ({ getUserDisplayName: (id: string) => ({ value: id }) }) }))
vi.mock('@/i18n', async () => {
  const { createI18n } = await import('vue-i18n')
  const en = (await import('@/locales/en.json')).default
  return { i18n: createI18n({ legacy: false, locale: 'en', messages: { en } }) }
})

import {
  SPEAKING_SILENCE_MS,
  SPEAKING_TURN_MS,
  resetVoiceAnnouncerForTests,
  setVoiceNameResolver,
  voiceAnnouncer,
} from '../voiceAnnouncements'

const names: Record<string, string> = { a: 'Alice', b: 'Bob', c: 'Carol' }

beforeEach(() => {
  announce.mockClear()
  resetVoiceAnnouncerForTests()
  setVoiceNameResolver((id) => names[id] ?? id)
})

const spoken = () => announce.mock.calls.map((call) => call[0])

describe('voice announcements', () => {
  it('names who joined, left and streams', () => {
    voiceAnnouncer.participantJoined('a')
    voiceAnnouncer.participantLeft('b')
    voiceAnnouncer.streamChanged('c', true)
    voiceAnnouncer.streamChanged('c', false)
    expect(spoken()).toEqual(['Alice joined', 'Bob left', 'Carol started streaming', 'Carol stopped streaming'])
    expect(announce.mock.calls.every((call) => call[1]?.politeness !== 'assertive')).toBe(true)
  })

  it('reports the connection under one key so a fast join speaks only its result', () => {
    voiceAnnouncer.connecting('General')
    voiceAnnouncer.connected('General')
    voiceAnnouncer.reconnected()
    voiceAnnouncer.disconnected()
    expect(spoken()).toEqual(['Connecting to General…', 'Connected to General', 'Reconnected', 'Disconnected'])
    expect(new Set(announce.mock.calls.map((call) => call[1]?.key))).toEqual(new Set(['voice-connection']))
  })

  it('says the own microphone, deafen and camera state, repeats included', () => {
    voiceAnnouncer.selfMuted(true)
    voiceAnnouncer.selfMuted(false)
    voiceAnnouncer.selfDeafened(true)
    voiceAnnouncer.selfDeafened(false)
    voiceAnnouncer.selfCamera(true)
    voiceAnnouncer.selfCamera(false)
    expect(spoken()).toEqual(['Muted', 'Unmuted', 'Deafened', 'Undeafened', 'Camera on', 'Camera off'])
    expect(announce.mock.calls.every((call) => call[1]?.dedupeMs === 0)).toBe(true)
  })

  describe('speaking', () => {
    it('is verbose and keyed per person', () => {
      voiceAnnouncer.speakingChanged('a', true, 10_000)
      expect(announce).toHaveBeenCalledWith('Alice speaking', { verbose: true, key: 'voice-speaking:a' })
    })

    it('ignores the flicker between words', () => {
      let now = 10_000
      voiceAnnouncer.speakingChanged('a', true, now)
      for (let i = 0; i < 10; i++) {
        now += 200
        voiceAnnouncer.speakingChanged('a', false, now)
        now += 200
        voiceAnnouncer.speakingChanged('a', true, now)
      }
      expect(spoken()).toEqual(['Alice speaking'])
    })

    it('speaks again after a silence', () => {
      voiceAnnouncer.speakingChanged('a', true, 10_000)
      voiceAnnouncer.speakingChanged('a', false, 10_100)
      voiceAnnouncer.speakingChanged('a', true, 10_000 + SPEAKING_SILENCE_MS + 1)
      expect(spoken()).toEqual(['Alice speaking', 'Alice speaking'])
    })

    it('speaks each change of turn, at most once per SPEAKING_TURN_MS per person', () => {
      voiceAnnouncer.speakingChanged('a', true, 10_000)
      voiceAnnouncer.speakingChanged('a', false, 10_500)
      voiceAnnouncer.speakingChanged('b', true, 11_000)
      voiceAnnouncer.speakingChanged('b', false, 11_500)
      // Alice answers within the turn window of her last announcement: quiet.
      voiceAnnouncer.speakingChanged('a', true, 10_000 + SPEAKING_TURN_MS - 1)
      voiceAnnouncer.speakingChanged('a', false, 10_000 + SPEAKING_TURN_MS)
      voiceAnnouncer.speakingChanged('a', true, 10_000 + SPEAKING_TURN_MS + 100)
      expect(spoken()).toEqual(['Alice speaking', 'Bob speaking', 'Alice speaking'])
    })
  })
})
