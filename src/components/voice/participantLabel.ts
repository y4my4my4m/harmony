import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

type Translate = (key: string, ...args: unknown[]) => string

export interface ParticipantFlags {
  self?: boolean
  muted?: boolean
  deafened?: boolean
  camera?: boolean
  streaming?: boolean
  speaking?: boolean
  /** Silenced for this listener only. */
  mutedByYou?: boolean
}

/** State words in a fixed order: deafened implies muted, so muted is dropped then. */
export function participantStates(t: Translate, flags: ParticipantFlags): string[] {
  const parts: string[] = []
  if (flags.deafened) parts.push(t('voice.statusDeafened'))
  else if (flags.muted) parts.push(t('voice.statusMuted'))
  if (flags.mutedByYou) parts.push(t('voice.mutedByYou'))
  if (flags.camera) parts.push(t('voice.statusCameraOn'))
  if (flags.streaming) parts.push(t('voice.statusStreaming'))
  if (flags.speaking) parts.push(t('voice.statusSpeaking'))
  return parts
}

/** "Alice (you), Muted, Camera on, Speaking": the accessible name of a participant row or tile. */
export function participantLabel(t: Translate, name: string, flags: ParticipantFlags): string {
  const head = flags.self ? t('voice.selfName', { name }) : name
  return [head, ...participantStates(t, flags)].join(', ')
}

/**
 * `source` turned on at once and off only after `holdMs` of continuous
 * false. The raw speaking flag flips between words at audio-level rate; a
 * name built from it would change several times a second.
 */
export function useHeldFlag(source: () => boolean, holdMs = 1200): Ref<boolean> {
  const held = ref(source())
  let timer: ReturnType<typeof setTimeout> | null = null
  watch(source, (on) => {
    if (on) {
      if (timer) clearTimeout(timer)
      timer = null
      held.value = true
    } else if (held.value && !timer) {
      timer = setTimeout(() => {
        timer = null
        held.value = false
      }, holdMs)
    }
  })
  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer)
  })
  return held
}

/** useHeldFlag over a set of ids: an id joins at once and leaves after `holdMs` absent. */
export function useHeldIds(source: () => string[], holdMs = 1200): Ref<Set<string>> {
  const held = ref(new Set<string>(source())) as Ref<Set<string>>
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  watch(source, (ids) => {
    const now = new Set(ids)
    let changed = false
    const next = new Set(held.value)
    for (const id of now) {
      const timer = timers.get(id)
      if (timer) {
        clearTimeout(timer)
        timers.delete(id)
      }
      if (!next.has(id)) {
        next.add(id)
        changed = true
      }
    }
    for (const id of held.value) {
      if (now.has(id) || timers.has(id)) continue
      timers.set(id, setTimeout(() => {
        timers.delete(id)
        const after = new Set(held.value)
        after.delete(id)
        held.value = after
      }, holdMs))
    }
    if (changed) held.value = next
  })
  onBeforeUnmount(() => {
    timers.forEach((timer) => clearTimeout(timer))
    timers.clear()
  })
  return held
}
