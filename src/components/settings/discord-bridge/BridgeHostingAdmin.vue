<template>
  <div class="admin-card" data-testid="bridge-hosting-admin" :data-platform="platform">
    <h4>{{ t(key('title')) }}</h4>
    <p class="hint">{{ t(key('lead')) }}</p>

    <p v-if="loadError" class="error" role="alert">{{ t('discordBridge.admin.loadFailed') }}</p>

    <div class="row">
      <div class="text">
        <span :id="`${uid}-label`" class="title">{{ t(key('toggle')) }}</span>
        <span :id="`${uid}-hint`" class="hint">{{ t(key('toggleHint')) }}</span>
      </div>
      <ToggleSwitch
        :model-value="enabled"
        :disabled="!loaded || switching"
        :labelledby="`${uid}-label`"
        :describedby="`${uid}-hint`"
        data-testid="hosting-toggle"
        @update:model-value="setEnabled"
      />
    </div>

    <div class="field">
      <label :for="`${uid}-limit`" class="title">{{ t('discordBridge.admin.limit') }}</label>
      <input
        :id="`${uid}-limit`"
        v-model.number="limit"
        type="number"
        min="0"
        step="1"
        inputmode="numeric"
        class="cyber-input limit-input"
        :disabled="!loaded || savingLimit"
        :aria-describedby="`${uid}-limit-hint`"
        data-testid="hosting-limit"
      />
      <span :id="`${uid}-limit-hint`" class="hint">{{ t('discordBridge.admin.limitHint') }}</span>
      <span v-if="count !== null" class="hint" data-testid="hosting-count">{{ t('matrixBridge.admin.hostedCount', { count, limit: savedLimit }) }}</span>
      <span v-if="limitInvalid" class="error" role="alert">{{ t('discordBridge.admin.limitInvalid') }}</span>
    </div>

    <p v-if="platform === 'discord'" class="note" data-testid="hosting-note">
      <i18n-t keypath="discordBridge.admin.note" tag="span" scope="global">
        <template #service><code>BRIDGE_MODE=host</code></template>
        <template #docs>
          <a :href="HOSTING_DOCS_URL" target="_blank" rel="noopener noreferrer">{{ t('discordBridge.admin.docs') }}</a>
        </template>
      </i18n-t>
    </p>

    <button
      type="button"
      class="btn btn-primary"
      :disabled="!loaded || savingLimit || !limitDirty || limitInvalid"
      data-testid="hosting-save"
      @click="saveLimit"
    >
      {{ savingLimit ? t('discordBridge.admin.saving') : t('discordBridge.admin.saveLimit') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { debug } from '@/utils/debug'
import {
  DEFAULT_HOSTING_LIMIT,
  HOSTING_KEYS,
  fetchHostingConfig,
  saveBridgeInstanceConfig,
  type BridgeRemotePlatform,
} from './bridgeApi'

const props = withDefaults(
  defineProps<{
    platform?: BridgeRemotePlatform
    /** Hosted bridges now; null where it is not known. */
    count?: number | null
  }>(),
  { platform: 'discord', count: null },
)

/** Self-host guide section the operator follows to run the bridge host service. */
const HOSTING_DOCS_URL = 'https://github.com/y4my4my4m/harmony/blob/master/self-host/README.md#discord-bridge-hosting'

const { t } = useI18n()
const toast = useToast()
const uid = `bridge-hosting-${useId()}`

/** Strings that name the platform live under its namespace; the rest are shared. */
const PLATFORM_KEYS: Record<BridgeRemotePlatform, string> = { discord: 'discordBridge.admin', matrix: 'matrixBridge.admin.hosting' }
const key = (name: string) => `${PLATFORM_KEYS[props.platform]}.${name}`

const enabled = ref(false)
const limit = ref<number>(DEFAULT_HOSTING_LIMIT)
const savedLimit = ref(DEFAULT_HOSTING_LIMIT)
const loaded = ref(false)
const loadError = ref(false)
const switching = ref(false)
const savingLimit = ref(false)

const limitInvalid = computed(() => !Number.isInteger(limit.value) || limit.value < 0)
const limitDirty = computed(() => limit.value !== savedLimit.value)

/** Saved on change; the switch returns to its previous position when the save fails. */
async function setEnabled(next: boolean) {
  const previous = enabled.value
  enabled.value = next
  switching.value = true
  try {
    await saveBridgeInstanceConfig(HOSTING_KEYS[props.platform].enabled, next)
    toast.success(t('discordBridge.admin.saved'))
  } catch (error) {
    enabled.value = previous
    debug.error('Saving bridge hosting switch failed:', error)
    toast.error(t('discordBridge.admin.saveFailed'))
  } finally {
    switching.value = false
  }
}

async function saveLimit() {
  if (limitInvalid.value || !limitDirty.value) return
  savingLimit.value = true
  try {
    const next = limit.value
    await saveBridgeInstanceConfig(HOSTING_KEYS[props.platform].limit, next)
    savedLimit.value = next
    toast.success(t('discordBridge.admin.saved'))
  } catch (error) {
    debug.error('Saving bridge hosting limit failed:', error)
    toast.error(t('discordBridge.admin.saveFailed'))
  } finally {
    savingLimit.value = false
  }
}

onMounted(async () => {
  try {
    const config = await fetchHostingConfig(props.platform)
    enabled.value = config.enabled
    limit.value = config.limit
    savedLimit.value = config.limit
    loaded.value = true
  } catch (error) {
    debug.warn('Bridge hosting settings unavailable:', error)
    loadError.value = true
  }
})
</script>

<style scoped src="../../admin/adminShared.css"></style>
<style scoped src="./bridgeAdmin.css"></style>
