import { defineStore } from 'pinia'
import { debug } from '@/utils/debug'
import { webrtcManager } from '@/services/webrtcManager'
import { roleService, Permission } from '@/services/RoleService'
import { VoiceSettingsService, normalizeSoundboardVolume } from '@/services/VoiceSettingsService'
import { remoteAudioMixer } from '@/services/voice/remoteAudioMixer'
import { soundboardGain, soundboardPlayer } from '@/services/soundboard/player'
import {
  defaultSound,
  listServerSounds,
  listSoundboardLibrary,
  resolveSoundboardSound,
  type SoundboardLibraryServer,
  type SoundboardSound,
} from '@/services/soundboard/sounds'
import {
  SOUNDBOARD_COOLDOWN_MS,
  SOUNDBOARD_RECEIVE_INTERVAL_MS,
  SoundboardRateLimiter,
  buildSoundboardMessage,
  checkIncomingPlay,
  isExternalPlay,
  type SoundboardTransportEvent,
} from '@/services/soundboard/protocol'
import { useUnifiedVoiceChannelStore } from './unifiedVoiceChannel'

/**
 * Soundboard of the voice channel this client is in: the server's sounds, the
 * sounds of the caller's other servers that share them, the caller's right to
 * play each, the send cooldown, and plays from others.
 *
 * Server voice channels of local servers only. DM calls have no server, and a
 * remote server's sounds live on its own instance.
 */

/** A received play naming a sound absent from the cached list refetches it at most this often, ms. */
const SOUND_LIST_REFRESH_MS = 10_000
/** How long a resolved external sound is reused before asking again, ms. */
const EXTERNAL_SOUND_TTL_MS = 60_000
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
/** Keyed `${channel server}:${sound id}`; null for a sound that did not resolve. */
const externalSounds = new Map<string, { sound: SoundboardSound | null; at: number }>()
let pendingLibrary: Promise<SoundboardLibraryServer[]> | null = null
let nextPlayKey = 1

/** USE_SOUNDBOARD and SPEAK, or ADMINISTRATOR, in a get_user_permissions answer. */
function soundboardAllowed(perms: Partial<Record<Permission, boolean>>): boolean {
  return perms[Permission.ADMINISTRATOR] === true
    || (perms[Permission.USE_SOUNDBOARD] === true && perms[Permission.SPEAK] === true)
}

/** soundboardAllowed plus USE_EXTERNAL_SOUNDS. */
function externalSoundsAllowed(perms: Partial<Record<Permission, boolean>>): boolean {
  return perms[Permission.ADMINISTRATOR] === true
    || (soundboardAllowed(perms) && perms[Permission.USE_EXTERNAL_SOUNDS] === true)
}

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
    /** The caller's servers that share their sounds (list_soundboard_library). */
    library: [] as SoundboardLibraryServer[],
    /** USE_SOUNDBOARD and SPEAK in the current channel. */
    permitted: false,
    /** permitted, and USE_EXTERNAL_SOUNDS in the current channel. */
    externalPermitted: false,
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

    /**
     * The caller holds USE_SOUNDBOARD and SPEAK in the current channel; also
     * sets externalPermitted.
     */
    async refreshPermission(): Promise<boolean> {
      const channel = this.currentChannel()
      if (!channel) {
        this.permitted = false
        this.externalPermitted = false
        return false
      }
      const key = `${channel.serverId}:${channel.channelId}:${channel.selfId}`
      try {
        const perms = await roleService.getUserPermissions(channel.selfId, channel.serverId, channel.channelId)
        const current = this.currentChannel()
        if (!current || `${current.serverId}:${current.channelId}:${current.selfId}` !== key) return false
        this.permitted = soundboardAllowed(perms)
        this.externalPermitted = externalSoundsAllowed(perms)
        return this.permitted
      } catch (error) {
        debug.warn('[Soundboard] permission check failed:', error)
        this.permitted = false
        this.externalPermitted = false
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

    /** The caller's servers that share their sounds; the previous list when the request fails. */
    async loadLibrary(): Promise<SoundboardLibraryServer[]> {
      if (pendingLibrary) return pendingLibrary
      pendingLibrary = (async () => {
        try {
          this.library = await listSoundboardLibrary()
        } catch (error) {
          debug.warn('[Soundboard] library unavailable:', error)
        } finally {
          pendingLibrary = null
        }
        return this.library
      })()
      return pendingLibrary
    },

    /** A sound of a server other than the current channel's. */
    isExternal(sound: SoundboardSound): boolean {
      const channel = this.currentChannel()
      return !!sound.serverId && !!channel && sound.serverId !== channel.serverId
    },

    /** The caller may play the sound in the current channel, cooldown aside. */
    mayPlay(sound: SoundboardSound): boolean {
      return this.permitted && (!this.isExternal(sound) || this.externalPermitted)
    },

    /**
     * Another server's sound played in serverId, through resolve_soundboard_sound;
     * results are reused for EXTERNAL_SOUND_TTL_MS, misses for SOUND_LIST_REFRESH_MS.
     */
    async resolveExternalSound(serverId: string, soundId: string): Promise<SoundboardSound | null> {
      const key = `${serverId}:${soundId}`
      const cached = externalSounds.get(key)
      const ttl = cached?.sound ? EXTERNAL_SOUND_TTL_MS : SOUND_LIST_REFRESH_MS
      if (cached && Date.now() - cached.at < ttl) return cached.sound
      let sound: SoundboardSound | null
      try {
        sound = await resolveSoundboardSound(soundId, serverId)
      } catch (error) {
        debug.warn('[Soundboard] external sound unavailable:', error)
        return null
      }
      externalSounds.set(key, { sound, at: Date.now() })
      return sound
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
      if (!channel || !this.mayPlay(sound) || voice.localState.isDeafened) return false
      const now = Date.now()
      if (this.cooldownRemaining(now) > 0) return false

      this.cooldownUntil = now + SOUNDBOARD_COOLDOWN_MS
      webrtcManager.sendSoundboard(buildSoundboardMessage(sound.id, channel.serverId, channel.selfId, sound.serverId))
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
      if (!channel) return

      const { message } = decision
      let sound: SoundboardSound | null
      if (isExternalPlay(message)) {
        if (event.externalGranted == null && !(await this.senderMayPlayExternal(event.userId, channel))) {
          debug.log('[Soundboard] external play dropped: sender lacks USE_EXTERNAL_SOUNDS', event.userId)
          return
        }
        sound = await this.resolveExternalSound(message.serverId, message.soundId)
      } else {
        sound = await this.resolveSound(message.serverId, message.soundId)
      }
      if (!sound) {
        debug.log('[Soundboard] play of an unknown sound dropped:', message.soundId)
        return
      }
      if (sound.serverId && sound.serverId !== (message.soundServerId ?? message.serverId)) {
        debug.log('[Soundboard] play naming the wrong server dropped:', message.soundId)
        return
      }
      if (this.currentChannel()?.serverId !== message.serverId) return

      this.notePlay(event.userId, sound)
      const { muted, gain } = listenerLevels(sound)
      if (muted || voice.localState.isDeafened || remoteAudioMixer.isLocalMuted(event.userId, 'mic')) return
      soundboardPlayer.play(sound.url, gain)
    },

    /** The sender's channel permissions, for plays whose transport carries no external grant. */
    async senderMayPlayExternal(userId: string, channel: SoundboardChannel): Promise<boolean> {
      try {
        return externalSoundsAllowed(await roleService.getUserPermissions(userId, channel.serverId, channel.channelId))
      } catch (error) {
        debug.warn('[Soundboard] sender permission check failed:', error)
        return false
      }
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
      externalSounds.clear()
      this.permitted = false
      this.externalPermitted = false
      this.recentPlays = []
    },
  },
})
