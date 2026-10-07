<template>
  <div data-testid="instance-link">
    <p class="db-text">{{ t('discordBridge.instance.lead') }}</p>
    <ol class="db-steps">
      <li>
        <i18n-t keypath="discordBridge.instance.step1" tag="span" scope="global">
          <template #button><span class="db-ui">{{ addLabel }}</span></template>
        </i18n-t>
      </li>
      <li>
        <i18n-t keypath="discordBridge.instance.step2" tag="span" scope="global">
          <template #authorize><span class="db-ui">{{ DISCORD_AUTHORIZE_LABEL }}</span></template>
        </i18n-t>
      </li>
      <li>{{ t('discordBridge.instance.step3') }}</li>
    </ol>

    <div class="db-banner db-banner--warn" data-testid="instance-privacy">
      <p>{{ t('discordBridge.instance.privacy') }}</p>
    </div>

    <p v-if="guildName" class="db-muted" data-testid="instance-linked">
      {{ t('discordBridge.instance.relink', { guild: guildName }) }}
    </p>

    <div v-if="error" class="db-banner db-banner--error" role="alert" data-testid="instance-link-error">
      <p>{{ error }}</p>
      <p v-if="detail" class="db-muted">{{ detail }}</p>
    </div>

    <div class="db-actions">
      <button type="button" class="btn btn-primary" :disabled="busy" data-testid="add-to-discord" @click="start">
        <Icon name="external-link" :size="14" aria-hidden="true" />
        {{ busy ? t('discordBridge.instance.opening') : addLabel }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { debug } from '@/utils/debug'
import { bridgeErrorKey, errorDetail } from './bridgeErrors'
import { startInstanceLink } from './instanceLink'

/** Discord prints the consent button in English for every locale. */
const DISCORD_AUTHORIZE_LABEL = 'Authorize'

const props = defineProps<{
  serverId: string
  /** The linked Discord server; set when re-linking. */
  guildName?: string | null
}>()

const { t } = useI18n()
const busy = ref(false)
const error = ref('')
const detail = ref('')

const addLabel = computed(() =>
  props.guildName ? t('discordBridge.instance.addOther') : t('discordBridge.instance.add'),
)

async function start() {
  busy.value = true
  error.value = ''
  detail.value = ''
  try {
    await startInstanceLink(props.serverId)
  } catch (cause) {
    debug.error('discord_bridge_instance_link failed:', cause)
    error.value = t(bridgeErrorKey(cause, 'discordBridge.errors.link'))
    detail.value = errorDetail(cause)
  } finally {
    busy.value = false
  }
}
</script>

<style scoped src="./bridge.css"></style>
