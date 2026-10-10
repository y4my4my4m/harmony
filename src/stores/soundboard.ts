import { defineStore } from 'pinia'
import { debug } from '@/utils/debug'
import { webrtcManager } from '@/services/webrtcManager'
import { roleService, Permission } from '@/services/RoleService'
import { VoiceSettingsService, normalizeSoundboardVolume } from '@/services/VoiceSettingsService'
import { remoteAudioMixer } from '@/services/voice/remoteAudioMixer'
import { soundboardGain, soundboardPlayer } from '@/services/soundboard/player'
import { defaultSound, listServerSounds, type SoundboardSound } from '@/services/soundboard/sounds'
import {
  SOUNDBOARD_COOLDOWN_MS,
  SOUNDBOARD_RECEIVE_INTERVAL_MS,
  SoundboardRateLimiter,
  buildSoundboardMessage,
  checkIncomingPlay,
  type SoundboardTransportEvent,
} from '@/services/soundboard/protocol'
import { useUnifiedVoiceChannelStore } from './unifiedVoiceChannel'

/**
 * Soundboard of the voice channel this client is in: the server's sounds, the
 * caller's right to play them, the send cooldown, and plays from others.
 *
 * Server voice channels of local servers only. DM calls have no server, and a
 * remote server's sounds live on its own instance.
 */

/** A received play naming a sound absent from the cached list refetches it at most this often, ms. */
const SOUND_LIST_REFRESH_MS = 10_000
/** How long a play stays in recentPlays, ms. */
const RECENT_PLAY_MS = 4000
const RECENT_PLAY_MAX = 3

export interface SoundboardChannel {
  serverId: string
  channelId: string
  selfId: string
}

export interface SoundboardPlay {
  key: number
  userId: string
  soundId: string
  name: string
  builtinKey?: string
  emoji: string | null
}

const receiveLimiter = new SoundboardRateLimiter(SOUNDBOARD_RECEIVE_INTERVAL_MS)
const pendingLoads = new Map<string, Promise<SoundboardSound[]>>()
let nextPlayKey = 1

function listenerLevels(sound: SoundboardSound) {
  const settings = VoiceSettingsService.getAll()
  return {
    muted: settings.soundboardMuted === true,
    gain: soundboardGain({
      soundVolume: sound.volume,
      soundboardVolume: normalizeSoundboardVolume(settings.soundboardVolume),
      masterVolume: remoteAudioMixer.getMasterVolume(),
    }),
  }
}

export const useSoundboardStore = defineStore('soundboard', {
  state: () => ({
    soundsByServer: {} as Record<string, SoundboardSound[]>,
    loadedAt: {} as Record<string, number>,
    /** USE_SOUNDBOARD and SPEAK in the current channel. */
    permitted: false,
    cooldownUntil: 0,
    recentPlays: [] as SoundboardPlay[],
  }),

  actions: {
    /** The voice channel the soundboard plays into, or null when there is none. */
    currentChannel(): SoundboardChannel | null {
      const voice = useUnifiedVoiceChannelStore()
      const serverId = voice.currentServerId
      const channelId = voice.currentChannelId
      const selfId = voice.localState.userId
      if (!voice.isConnected || voice.isFederatedChannel) return null
      if (!serverId || serverId === 'dm' || !channelId || !selfId) return null
      return { serverId, channelId, selfId }
    },

    /** The caller holds USE_SOUNDBOARD and SPEAK in the current channel. */
    async refreshPermission(): Promise<boolean> {
      const channel = this.currentChannel()
      if (!channel) {
        this.permitted = false
        return false
      }
      const key = `${channel.serverId}:${channel.channelId}:${channel.selfId}`
      try {
        const perms = await roleService.getUserPermissions(channel.selfId, channel.serverId, channel.channelId)
        const granted = perms[Permission.ADMINISTRATOR] === true
          || (perms[Permission.USE_SOUNDBOARD] === true && perms[Permission.SPEAK] === true)
        const current = this.currentChannel()
        if (!current || `${current.serverId}:${current.channelId}:${current.selfId}` !== key) return false
        this.permitted = granted
        return granted
      } catch (error) {
        debug.warn('[Soundboard] permission check failed:', error)
        this.permitted = false
        return false
      }
    },

    async loadServerSounds(serverId: string, force = false): Promise<SoundboardSound[]> {
      if (!force && this.soundsByServer[serverId]) return this.soundsByServer[serverId]
      const pending = pendingLoads.get(serverId)
      if (pending) return pending
      const request = (async () => {
        try {
          const sounds = await listServerSounds(serverId)
          this.setServerSounds(serverId, sounds)
          return sounds
        } catch (error) {
          debug.warn('[Soundboard] sounds unavailable:', error)
          this.loadedAt[serverId] = Date.now()
          return this.soundsByServer[serverId] ?? []
        } finally {
          pendingLoads.delete(serverId)
        }
      })()
      pendingLoads.set(serverId, request)
      return request
    },

    setServerSounds(serverId: string, sounds: SoundboardSound[]): void {
      this.soundsByServer[serverId] = sounds
      this.loadedAt[serverId] = Date.now()
    },

    /** A built-in clip, or one of the server's; refetches the list once for an unknown id. */
    async resolveSound(serverId: string, soundId: string): Promise<SoundboardSound | null> {
      const builtin = defaultSound(soundId)
      if (builtin) return builtin
      const cached = this.soundsByServer[serverId]?.find((s) => s.id === soundId)
      if (cached) return cached
      const loadedAt = this.loadedAt[serverId] ?? 0
      if (this.soundsByServer[serverId] && Date.now() - loadedAt < SOUND_LIST_REFRESH_MS) return null
      const sounds = await this.loadServerSounds(serverId, true)
      return sounds.find((s) => s.id === soundId) ?? null
    },

    /** Milliseconds until the caller may play again. */
    cooldownRemaining(now = Date.now()): number {
      return Math.max(0, this.cooldownUntil - now)
    },

    /** Plays a sound for everyone in the channel. False when refused locally. */
    play(sound: SoundboardSound): boolean {
      const voice = useUnifiedVoiceChannelStore()
      const channel = this.currentChannel()
      if (!channel || !this.permitted || voice.localState.isDeafened) return false
      if (sound.serverId && sound.serverId !== channel.serverId) return false
      const now = Date.now()
      if (this.cooldownRemaining(now) > 0) return false

      this.cooldownUntil = now + SOUNDBOARD_COOLDOWN_MS
      webrtcManager.sendSoundboard(buildSoundboardMessage(sound.id, channel.serverId, channel.selfId))
      this.notePlay(channel.selfId, sound)
      const { muted, gain } = listenerLevels(sound)
      if (!muted) soundboardPlayer.play(sound.url, gain)
      return true
    },

    /** Plays a sound for this client only. */
    preview(sound: SoundboardSound): void {
      soundboardPlayer.play(sound.url, listenerLevels(sound).gain)
    },

    async receive(event: SoundboardTransportEvent): Promise<void> {
      const voice = useUnifiedVoiceChannelStore()
      const channel = this.currentChannel()
      const decision = checkIncomingPlay(event, {
        selfId: channel?.selfId ?? null,
        serverId: channel?.serverId ?? null,
        participants: new Set(voice.allUsers.map((u: { userId: string }) => u.userId)),
      }, receiveLimiter, Date.now())
      if (!decision.ok) {
        debug.log('[Soundboard] play dropped:', decision.reason, event.userId)
        return
      }

      const sound = await this.resolveSound(decision.message.serverId, decision.message.soundId)
      if (!sound) {
        debug.log('[Soundboard] play of an unknown sound dropped:', decision.message.soundId)
        return
      }
      if (this.currentChannel()?.serverId !== decision.message.serverId) return

      this.notePlay(event.userId, sound)
      const { muted, gain } = listenerLevels(sound)
      if (muted || voice.localState.isDeafened || remoteAudioMixer.isLocalMuted(event.userId, 'mic')) return
      soundboardPlayer.play(sound.url, gain)
    },

    notePlay(userId: string, sound: SoundboardSound): void {
      const play: SoundboardPlay = {
        key: nextPlayKey++,
        userId,
        soundId: sound.id,
        name: sound.name,
        builtinKey: sound.builtinKey,
        emoji: sound.emoji,
      }
      this.recentPlays = [...this.recentPlays, play].slice(-RECENT_PLAY_MAX)
      setTimeout(() => {
        this.recentPlays = this.recentPlays.filter((p) => p.key !== play.key)
      }, RECENT_PLAY_MS)
    },

    /** Clears per-call state; cached sound lists stay. */
    leaveCall(): void {
      soundboardPlayer.stopAll()
      receiveLimiter.reset()
      this.permitted = false
      this.recentPlays = []
    },
  },
})
