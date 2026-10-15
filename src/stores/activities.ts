import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { supabase } from '@/supabase'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { useAuthStore } from '@/stores/auth'
import {
  controlActivity,
  expectedPosition,
  getActivity,
  getServerActivities,
  serverClockOffset,
  startActivity,
  stopActivity,
  type ActivityAction,
  type ActivityItem,
  type ActivitySource,
  type VoiceActivity,
} from '@/services/activities/activityService'

/**
 * Activities of voice channels, and the one of the call this client is in.
 *
 * States arrive from the RPC answers, the voice-channel-event broadcast and peers on the call's
 * data channel; a state replaces the held one only with a higher revision (an end, null, always
 * applies when it comes from the database). While in a call with an activity the row is read
 * again every POLL_MS (POLL_OFFLINE_MS while realtime is down), which settles missed events.
 *
 * Nothing plays without consent: a run (channel and started_at) plays for the member who
 * started it and for members who chose Join; the others get an invite naming the source and
 * title, never its picture.
 */

/** Row re-read period in a call, ms. */
const POLL_MS = 15_000
/** Re-read period while the realtime socket is down, ms. */
const POLL_OFFLINE_MS = 3_000
/** Clock offset re-measure period, ms. */
const CLOCK_MS = 5 * 60_000
const VOLUME_KEY = 'harmony:activity-volume'

export interface ActivityPlayerStatus {
  ready: boolean
  playing: boolean
  buffering: boolean
  positionMs: number
  durationMs: number
  error: string | null
}

function storedVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY))
    return Number.isFinite(v) && v >= 0 && v <= 1 && localStorage.getItem(VOLUME_KEY) !== null ? v : 0.8
  } catch {
    return 0.8
  }
}

export const useActivitiesStore = defineStore('activities', () => {
  const byChannel = ref<Record<string, VoiceActivity | null>>({})
  const offsetMs = ref(0)
  const volume = ref(storedVolume())
  const muted = ref(false)
  /** Channels whose activity this client chose not to play. */
  const hidden = ref<Set<string>>(new Set())
  /** Runs, `${channel_id}:${started_at}`, this client joined. */
  const joined = ref<Set<string>>(new Set())
  /** Elements the player shows itself over, last registered first. */
  const slots = shallowRef<HTMLElement[]>([])
  const status = ref<ActivityPlayerStatus>({ ready: false, playing: false, buffering: false, positionMs: 0, durationMs: 0, error: null })
  const busy = ref(false)
  const launcherOpen = ref(false)
  /** Button the launcher opens beside, style-space px. */
  const launcherAnchor = ref<{ left: number; top: number; width: number; height: number } | null>(null)
  let clockAt = 0
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let pollChannel: string | null = null

  const voiceChannelId = computed(() => {
    const voice = useUnifiedVoiceChannelStore()
    return voice.isConnected ? voice.effectiveChannelId ?? voice.currentChannelId ?? null : null
  })

  /** The activity of the call this client is in. */
  const current = computed<VoiceActivity | null>(() => {
    const id = voiceChannelId.value
    return id ? byChannel.value[id] ?? null : null
  })

  const runKey = (a: VoiceActivity) => `${a.channel_id}:${a.started_at}`
  const accepted = (a: VoiceActivity) => a.host_id === useAuthStore().session?.user?.id || joined.value.has(runKey(a))

  const playingHere = computed(() => !!current.value && !hidden.value.has(current.value.channel_id) && accepted(current.value))
  /** The call's activity while it does not play here: never joined, declined, or stopped for me. */
  const waiting = computed(() => (current.value && !playingHere.value ? current.value : null))
  /** waiting, and the member has not answered its invite yet. */
  const invited = computed(() => !!waiting.value && !hidden.value.has(waiting.value.channel_id))
  const slot = computed(() => slots.value[0] ?? null)

  function serverTime(): number {
    return Date.now() + offsetMs.value
  }

  function position(): number {
    return current.value ? expectedPosition(current.value, serverTime()) : 0
  }

  async function syncClock(force = false): Promise<void> {
    if (!force && Date.now() - clockAt < CLOCK_MS) return
    clockAt = Date.now()
    try {
      offsetMs.value = await serverClockOffset()
    } catch {
      /* keep the last offset */
    }
  }

  /**
   * Applies a state for `channelId`; false when it is older than the held one. A run of an
   * activity is its started_at; within a run, the revision orders states. An end (null) applies
   * only from the database.
   */
  function apply(channelId: string, activity: VoiceActivity | null, authoritative: boolean): boolean {
    const held = byChannel.value[channelId] ?? null
    if (!activity) {
      if (!held || !authoritative) return false
    } else if (held) {
      if (activity.started_at === held.started_at) {
        if (activity.revision < held.revision) return false
        if (activity.revision === held.revision && activity.position_at === held.position_at) return false
      } else if (activity.started_at < held.started_at) {
        return false
      }
    }
    byChannel.value = { ...byChannel.value, [channelId]: activity }
    if (!activity || (held && activity.started_at !== held.started_at)) {
      const next = new Set(hidden.value)
      next.delete(channelId)
      hidden.value = next
      if (held) {
        const runs = new Set(joined.value)
        runs.delete(runKey(held))
        joined.value = runs
      }
    }
    return true
  }

  // Loaded on use: the transport stays out of the bundle of pages that only show activities.
  function share(activity: VoiceActivity | null, channelId: string): void {
    void import('@/services/webrtcManager').then(({ webrtcManager }) => {
      webrtcManager.sendActivity({ type: 'activity', v: 1, channelId, activity })
    }).catch(() => {})
  }

  async function refresh(channelId: string): Promise<void> {
    try {
      const result = await getActivity(channelId)
      apply(channelId, result.activity, true)
    } catch {
      /* the next poll retries */
    }
  }

  async function refreshServer(serverId: string): Promise<void> {
    try {
      const list = await getServerActivities(serverId)
      const next = { ...byChannel.value }
      for (const [id, a] of Object.entries(next)) {
        if (a?.server_id === serverId && !list.some((l) => l.channel_id === id)) next[id] = null
      }
      for (const a of list) {
        const held = next[a.channel_id]
        if (!held || a.revision >= held.revision) next[a.channel_id] = a
      }
      byChannel.value = next
    } catch {
      /* sidebar decoration only */
    }
  }

  async function run(work: () => Promise<{ activity: VoiceActivity | null }>, channelId: string): Promise<VoiceActivity | null> {
    busy.value = true
    try {
      const result = await work()
      apply(channelId, result.activity, true)
      share(result.activity, channelId)
      return result.activity
    } finally {
      busy.value = false
    }
  }

  async function start(source: ActivitySource, item: ActivityItem, startMs = 0): Promise<VoiceActivity | null> {
    const channelId = voiceChannelId.value
    if (!channelId) throw new Error('Not in a voice channel')
    await syncClock()
    const activity = await run(() => startActivity(channelId, source, item), channelId)
    if (activity && startMs > 0) await control({ action: 'seek', position_ms: startMs })
    return activity
  }

  function control(change: ActivityAction): Promise<VoiceActivity | null> {
    const channelId = voiceChannelId.value
    if (!channelId) return Promise.resolve(null)
    return run(() => controlActivity(channelId, change), channelId)
  }

  async function stop(): Promise<void> {
    const channelId = voiceChannelId.value
    if (!channelId) return
    busy.value = true
    try {
      await stopActivity(channelId)
      apply(channelId, null, true)
      share(null, channelId)
    } finally {
      busy.value = false
    }
  }

  const togglePlay = () => (current.value?.playing
    ? control({ action: 'pause', position_ms: Math.round(position()) })
    : control({ action: 'play', position_ms: Math.round(position()) }))
  const seek = (ms: number) => control({ action: 'seek', position_ms: Math.max(0, Math.round(ms)) })

  /** The player reached the end of the item it plays. */
  function itemEnded(): void {
    const a = current.value
    if (!a || !a.playing) return
    void control({ action: 'next', revision: a.revision }).catch(() => {})
  }

  /** voice-channel-event {event: activity} from the voice topics. */
  function receiveBroadcast(payload: { channelId?: string; activity?: VoiceActivity | null; serverNow?: number }): void {
    if (!payload?.channelId) return
    apply(payload.channelId, payload.activity ?? null, true)
  }

  /** An activity state from a participant of the call. */
  function receivePeer(event: { userId: string; message: unknown }): void {
    const message = event.message as { type?: string; channelId?: string; activity?: VoiceActivity | null }
    if (message?.type !== 'activity' || typeof message.channelId !== 'string') return
    if (message.channelId !== voiceChannelId.value) return
    if (message.activity && message.activity.channel_id !== message.channelId) return
    apply(message.channelId, message.activity ?? null, false)
  }

  function hide(channelId: string, value: boolean): void {
    const next = new Set(hidden.value)
    if (value) next.add(channelId)
    else next.delete(channelId)
    hidden.value = next
  }

  /** Plays the call's current run here. */
  function join(): void {
    const a = current.value
    if (!a) return
    joined.value = new Set(joined.value).add(runKey(a))
    hide(a.channel_id, false)
  }

  function setVolume(v: number): void {
    volume.value = Math.min(1, Math.max(0, v))
    muted.value = false
    try {
      localStorage.setItem(VOLUME_KEY, String(volume.value))
    } catch {
      /* private mode */
    }
  }

  function registerSlot(el: HTMLElement): () => void {
    slots.value = [el, ...slots.value.filter((s) => s !== el)]
    return () => {
      slots.value = slots.value.filter((s) => s !== el)
    }
  }

  function setStatus(next: Partial<ActivityPlayerStatus>): void {
    status.value = { ...status.value, ...next }
  }

  function schedulePoll(): void {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
    const channelId = voiceChannelId.value
    pollChannel = channelId
    if (!channelId) return
    const online = (() => {
      try {
        return supabase.realtime.isConnected()
      } catch {
        return false
      }
    })()
    pollTimer = setTimeout(async () => {
      if (pollChannel !== voiceChannelId.value) return
      await refresh(channelId)
      void syncClock()
      schedulePoll()
    }, online ? POLL_MS : POLL_OFFLINE_MS)
  }

  /** Follows the call: reads the activity on join and keeps re-reading while in it. */
  async function enterCall(): Promise<void> {
    const channelId = voiceChannelId.value
    if (!channelId) {
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = null
      pollChannel = null
      return
    }
    await Promise.all([syncClock(true), refresh(channelId)])
    schedulePoll()
  }

  return {
    byChannel, offsetMs, volume, muted, hidden, joined, slots, slot, status, busy, launcherOpen, launcherAnchor,
    voiceChannelId, current, playingHere, waiting, invited, join,
    serverTime, position, syncClock, apply, refresh, refreshServer, start, control, stop, togglePlay, seek,
    itemEnded, receiveBroadcast, receivePeer, hide, setVolume, registerSlot, setStatus, enterCall,
  }
})
