import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { supabase } from '@/supabase'
import { useProfileStore } from '@/stores/useProfile'

/** Self-only setting, loaded afresh whenever the server's privacy dialog opens. */
export const useBridgePrivacyStore = defineStore('bridgePrivacy', () => {
  const serverId = ref<string | null>(null)
  const optOut = ref<{ discord: boolean; matrix: boolean } | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<'loadError' | 'saveError' | null>(null)
  let revision = 0

  function close(): void {
    revision++
    serverId.value = null
    optOut.value = null
    loading.value = false
    saving.value = false
    error.value = null
  }

  async function open(id: string): Promise<void> {
    const request = ++revision
    serverId.value = id
    optOut.value = null
    loading.value = true
    saving.value = false
    error.value = null
    try {
      const result = await supabase.rpc('get_server_bridge_privacy', { p_server_id: id })
      if (result.error || typeof result.data?.discord !== 'boolean' || typeof result.data?.matrix !== 'boolean') throw new Error('Invalid privacy response')
      if (request === revision) optOut.value = { discord: result.data.discord, matrix: result.data.matrix }
    } catch {
      if (request === revision) error.value = 'loadError'
    } finally {
      if (request === revision) loading.value = false
    }
  }

  async function setOptOut(platform: 'discord' | 'matrix', value: boolean): Promise<void> {
    if (!serverId.value || loading.value || saving.value || error.value || optOut.value === null) return
    const request = revision
    saving.value = true
    error.value = null
    try {
      const result = await supabase.rpc('set_server_bridge_platform_opt_out', { p_server_id: serverId.value, p_platform: platform, p_opt_out: value })
      if (result.error || typeof result.data !== 'boolean') throw new Error('Invalid privacy response')
      if (request === revision && optOut.value) optOut.value[platform] = result.data
    } catch {
      if (request === revision) error.value = 'saveError'
    } finally {
      if (request === revision) saving.value = false
    }
  }

  watch(() => useProfileStore().profileId, close)
  return { serverId, optOut, loading, saving, error, open, close, setOptOut }
})
