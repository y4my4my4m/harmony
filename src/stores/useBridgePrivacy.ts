import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { debug } from '@/utils/debug'
import { useProfileStore } from '@/stores/useProfile'
import {
  bridgedPlatforms,
  fetchBridgeMemberPrivacy,
  setBridgeMemberOptout,
  type BridgeMemberPrivacy,
  type BridgePlatform,
} from '@/services/bridgeMemberPrivacyApi'

/**
 * The signed-in member's own bridge relay preference per server. Menus read it once per server
 * per profile (prefetch) to decide whether to offer the dialog; the dialog reads it afresh.
 */
export const useBridgePrivacyStore = defineStore('bridgePrivacy', () => {
  const byServer = ref<Record<string, BridgeMemberPrivacy>>({})
  const pendingReads = new Map<string, Promise<BridgeMemberPrivacy>>()
  /** Profile generation; a read started under another profile is dropped. */
  let session = 0

  const serverId = ref<string | null>(null)
  const privacy = ref<BridgeMemberPrivacy | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<'loadError' | 'saveError' | null>(null)
  /** Dialog generation; a response for a closed or reopened dialog is dropped. */
  let revision = 0

  const platforms = computed<BridgePlatform[]>(() => (privacy.value ? bridgedPlatforms(privacy.value) : []))

  function hasBridge(id: string | null | undefined): boolean {
    const known = id ? byServer.value[id] : undefined
    return !!known && bridgedPlatforms(known).length > 0
  }

  function read(id: string): Promise<BridgeMemberPrivacy> {
    const pending = pendingReads.get(id)
    if (pending) return pending
    const started = session
    const request = fetchBridgeMemberPrivacy(id)
      .then((result) => {
        if (started === session) byServer.value[id] = result
        return result
      })
      .finally(() => {
        if (pendingReads.get(id) === request) pendingReads.delete(id)
      })
    pendingReads.set(id, request)
    return request
  }

  async function prefetch(id: string | null | undefined): Promise<void> {
    if (!id || byServer.value[id]) return
    try {
      await read(id)
    } catch (failure) {
      debug.warn('bridge_member_privacy unavailable:', failure)
    }
  }

  function close(): void {
    revision++
    serverId.value = null
    privacy.value = null
    loading.value = false
    saving.value = false
    error.value = null
  }

  async function open(id: string): Promise<void> {
    const request = ++revision
    serverId.value = id
    privacy.value = null
    loading.value = true
    saving.value = false
    error.value = null
    try {
      const result = await read(id)
      if (request === revision) privacy.value = result
    } catch {
      if (request === revision) error.value = 'loadError'
    } finally {
      if (request === revision) loading.value = false
    }
  }

  async function setOptOut(platform: BridgePlatform, optedOut: boolean): Promise<void> {
    const id = serverId.value
    if (!id || loading.value || saving.value || error.value || !privacy.value?.[platform].bridged) return
    const request = revision
    const started = session
    saving.value = true
    try {
      const result = await setBridgeMemberOptout(id, platform, optedOut)
      if (started === session) byServer.value[id] = result
      if (request === revision) privacy.value = result
    } catch {
      if (request === revision) error.value = 'saveError'
    } finally {
      if (request === revision) saving.value = false
    }
  }

  watch(() => useProfileStore().profileId, () => {
    session++
    byServer.value = {}
    pendingReads.clear()
    close()
  })

  return { byServer, serverId, privacy, platforms, loading, saving, error, hasBridge, prefetch, open, close, setOptOut }
})
