<template>
  <div data-testid="step-bot">
    <p class="db-text">{{ t('discordBridge.bot.lead') }}</p>
    <ol class="db-steps">
      <li>
        <i18n-t keypath="discordBridge.bot.open" tag="span" scope="global">
          <template #portal>
            <a :href="portalUrl" target="_blank" rel="noopener noreferrer">{{ t('discordBridge.bot.portalName') }}</a>
          </template>
        </i18n-t>
      </li>
      <li>
        <i18n-t keypath="discordBridge.bot.newApp" tag="span" scope="global">
          <template #newApplication><span class="db-ui">{{ PORTAL.newApplication }}</span></template>
          <template #create><span class="db-ui">{{ PORTAL.create }}</span></template>
          <template #example><em>{{ exampleName }}</em></template>
        </i18n-t>
      </li>
      <li>
        <i18n-t keypath="discordBridge.bot.openBot" tag="span" scope="global">
          <template #bot><span class="db-ui">{{ PORTAL.bot }}</span></template>
        </i18n-t>
      </li>
      <li>
        <i18n-t keypath="discordBridge.bot.intents" tag="span" scope="global">
          <template #section><span class="db-ui">{{ PORTAL.privilegedIntents }}</span></template>
        </i18n-t>
        <ul class="intent-list" data-testid="intent-list">
          <li v-for="intent in DISCORD_INTENTS" :key="intent" :data-intent="intent" :data-needed="needed.includes(intent)">
            <Icon
              :name="needed.includes(intent) ? 'check-circle' : 'circle'"
              :size="16"
              :class="needed.includes(intent) ? 'on' : 'off'"
              aria-hidden="true"
            />
            <span>
              <span class="db-ui">{{ DISCORD_INTENT_NAMES[intent] }}</span>
              <span :class="['db-badge', needed.includes(intent) ? 'db-badge--ok' : '']">
                {{ needed.includes(intent) ? t('discordBridge.bot.switchOn') : t('discordBridge.bot.leaveOff') }}
              </span>
              <span class="intent-why">{{ t(`discordBridge.bot.why.${intent}.${needed.includes(intent) ? 'on' : 'off'}`) }}</span>
            </span>
          </li>
        </ul>
        <div class="intent-options">
          <p class="db-muted">{{ t('discordBridge.bot.optionsLead') }}</p>
          <BridgeSettingsPanel
            :bridge-id="bridgeId"
            :settings="current"
            :keys="['sync_member_list', 'sync_presence']"
            @changed="onSettingsChanged"
          />
        </div>
        <i18n-t keypath="discordBridge.bot.save" tag="span" scope="global">
          <template #save><span class="db-ui">{{ PORTAL.saveChanges }}</span></template>
        </i18n-t>
      </li>
      <li>
        <i18n-t keypath="discordBridge.bot.token" tag="span" scope="global">
          <template #token><span class="db-ui">{{ PORTAL.token }}</span></template>
          <template #reset><span class="db-ui">{{ PORTAL.resetToken }}</span></template>
          <template #confirm><span class="db-ui">{{ PORTAL.yesDoIt }}</span></template>
          <template #copy><span class="db-ui">{{ PORTAL.copy }}</span></template>
        </i18n-t>
      </li>
    </ol>
    <div class="db-banner db-banner--warn">
      <p>{{ t('discordBridge.bot.secret') }}</p>
      <p v-if="mode === 'hosted'">{{ t('discordBridge.bot.hostedAccess') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import {
  DISCORD_DEVELOPER_PORTAL_URL,
  DISCORD_INTENTS,
  requiredIntents,
  type BridgeMode,
  type BridgeSettings,
} from '@/utils/discordBridgeSetup'
import { DISCORD_INTENT_NAMES, PORTAL } from './portalLabels'
import BridgeSettingsPanel from './BridgeSettingsPanel.vue'

const props = defineProps<{
  bridgeId: string
  mode: BridgeMode
  settings: BridgeSettings
  serverName: string
}>()

const emit = defineEmits<{ changed: [] }>()

const { t } = useI18n()
const portalUrl = DISCORD_DEVELOPER_PORTAL_URL
const current = ref<BridgeSettings>({ ...props.settings })
watch(() => props.settings, (next) => (current.value = { ...next }), { deep: true })
const needed = computed(() => requiredIntents(current.value))

function onSettingsChanged(next: BridgeSettings) {
  current.value = next
  emit('changed')
}
const exampleName = computed(() => t('discordBridge.bot.exampleName', { server: props.serverName || 'Harmony' }))
</script>

<style scoped src="./bridge.css"></style>
<style scoped>
.intent-list {
  list-style: none;
  margin: 10px 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.intent-list > li {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--background-primary);
  border: 1px solid var(--background-quaternary);
}

.intent-list > li > span {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  align-items: center;
  min-width: 0;
}

.intent-list :deep(.icon-wrap) {
  margin-top: 2px;
  flex-shrink: 0;
}

.intent-list .on {
  color: var(--success);
}

.intent-list .off {
  color: var(--text-secondary);
}

.intent-why {
  flex-basis: 100%;
  font-size: 13px;
  color: var(--text-secondary);
}

.intent-options {
  margin: 8px 0 10px;
  padding: 12px;
  border-radius: 6px;
  border: 1px dashed var(--background-quaternary);
}

.intent-options .db-muted {
  margin-bottom: 8px;
}
</style>
