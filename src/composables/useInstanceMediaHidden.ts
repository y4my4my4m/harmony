/**
 * Servers hosted elsewhere whose pictures, videos and files render hidden on this instance
 * (instance_server_blocks.media_hidden). Read once per session on first use; the instance
 * panel updates it when staff change it.
 */
import { computed, ref, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue'
import { debug } from '@/utils/debug'
import { fetchMediaHiddenServerIds } from '@/services/instanceServerTools'

const hiddenIds = ref<ReadonlySet<string>>(new Set())
let loading: Promise<void> | null = null

function load(): Promise<void> {
  loading ??= fetchMediaHiddenServerIds()
    .then((ids) => { hiddenIds.value = new Set(ids) })
    .catch((error) => {
      loading = null
      debug.warn('Hidden-media servers not loaded:', error)
    })
  return loading
}

export function setServerMediaHiddenLocally(serverId: string, hidden: boolean): void {
  const next = new Set(hiddenIds.value)
  if (hidden) next.add(serverId)
  else next.delete(serverId)
  hiddenIds.value = next
}

export function resetInstanceMediaHidden(): void {
  hiddenIds.value = new Set()
  loading = null
}

export function useInstanceMediaHidden() {
  void load()
  return {
    isServerMediaHidden: (serverId: string | null | undefined): boolean => !!serverId && hiddenIds.value.has(serverId),
    reload: () => { loading = null; return load() },
  }
}

/**
 * True when messages of `serverId` render with their media hidden here. A conversation passes
 * null: its messages are never hidden.
 */
export function useServerMediaHidden(serverId: MaybeRefOrGetter<string | null | undefined>): ComputedRef<boolean> {
  const { isServerMediaHidden } = useInstanceMediaHidden()
  return computed(() => isServerMediaHidden(toValue(serverId)))
}
