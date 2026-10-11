/**
 * Spoken voice-call events for screen-reader users, through the global
 * announcer (composables/useAnnouncer.ts). Sounds alone carry no names; these
 * say who and what.
 *
 * Polite throughout. Spoken elsewhere: a dropped connection by its toast,
 * "Reconnecting…" and blocked audio by VoiceCallBanner's status region.
 * Speaking is verbose (spoken only with "Screen reader support" on) and is
 * said when someone starts after SPEAKING_SILENCE_MS of silence, or takes the
 * turn from the last person announced, at most once per SPEAKING_TURN_MS each.
 * The raw flag flickers between words; neither rule fires mid-sentence.
 */

import { announce } from '@/composables/useAnnouncer'
import { useUserData } from '@/composables/useUserData'
import { i18n } from '@/i18n'

/** Silence after which a person starting to speak is announced again, ms. */
export const SPEAKING_SILENCE_MS = 5000
/** Minimum gap between two turn-change announcements for one person, ms. */
export const SPEAKING_TURN_MS = 3000

const t = (key: string, params?: Record<string, unknown>): string =>
  params ? i18n.global.t(key, params) : i18n.global.t(key)

let resolveName: (userId: string) => string = (userId) => useUserData().getUserDisplayName(userId).value

/** Test hook: replaces the display-name lookup. */
export function setVoiceNameResolver(resolver: ((userId: string) => string) | null): void {
  resolveName = resolver ?? ((userId) => useUserData().getUserDisplayName(userId).value)
}

const speaking = new Map<string, { on: boolean; lastOnAt: number; announcedAt: number }>()
let lastAnnouncedSpeaker: string | null = null

export const voiceAnnouncer = {
  participantJoined(userId: string): void {
    announce(t('voice.announce.joined', { name: resolveName(userId) }))
  },

  participantLeft(userId: string): void {
    speaking.delete(userId)
    announce(t('voice.announce.left', { name: resolveName(userId) }))
  },

  streamChanged(userId: string, streaming: boolean): void {
    const key = streaming ? 'voice.announce.startedStreaming' : 'voice.announce.stoppedStreaming'
    announce(t(key, { name: resolveName(userId) }))
  },

  selfStreamChanged(streaming: boolean): void {
    announce(t(streaming ? 'voice.announce.selfStreaming' : 'voice.announce.selfStreamStopped'), { key: 'voice-self-stream' })
  },

  connecting(channelName: string): void {
    announce(t('voice.announce.connectingTo', { channel: channelName }), { key: 'voice-connection' })
  },

  connected(channelName: string): void {
    announce(t('voice.announce.connectedTo', { channel: channelName }), { key: 'voice-connection' })
  },

  reconnected(): void {
    announce(t('voice.announce.reconnected'), { key: 'voice-connection' })
  },

  disconnected(): void {
    speaking.clear()
    lastAnnouncedSpeaker = null
    announce(t('voice.disconnected'), { key: 'voice-connection' })
  },

  selfMuted(muted: boolean): void {
    announce(t(muted ? 'voice.statusMuted' : 'voice.announce.unmuted'), { key: 'voice-self-mic', dedupeMs: 0 })
  },

  selfDeafened(deafened: boolean): void {
    announce(t(deafened ? 'voice.statusDeafened' : 'voice.announce.undeafened'), { key: 'voice-self-mic', dedupeMs: 0 })
  },

  selfCamera(on: boolean): void {
    announce(t(on ? 'voice.statusCameraOn' : 'voice.announce.cameraOff'), { key: 'voice-self-camera', dedupeMs: 0 })
  },

  /** Raw speaking flag from every audio-level update. */
  speakingChanged(userId: string, isSpeaking: boolean, now = Date.now()): void {
    const entry = speaking.get(userId) ?? { on: false, lastOnAt: -Infinity, announcedAt: -Infinity }
    if (isSpeaking && !entry.on) {
      const afterSilence = now - entry.lastOnAt >= SPEAKING_SILENCE_MS
      const takesTurn = lastAnnouncedSpeaker !== userId && now - entry.announcedAt >= SPEAKING_TURN_MS
      if (afterSilence || takesTurn) {
        entry.announcedAt = now
        lastAnnouncedSpeaker = userId
        announce(t('voice.announce.speaking', { name: resolveName(userId) }), { verbose: true, key: `voice-speaking:${userId}` })
      }
    }
    if (isSpeaking) entry.lastOnAt = now
    entry.on = isSpeaking
    speaking.set(userId, entry)
  },
}

/** Test hook. */
export function resetVoiceAnnouncerForTests(): void {
  speaking.clear()
  lastAnnouncedSpeaker = null
}
