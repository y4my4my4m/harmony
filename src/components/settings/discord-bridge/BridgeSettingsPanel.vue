<template>
  <div class="settings-list" data-testid="bridge-settings">
    <div v-for="key in shownKeys" :key="key" class="setting-row" :data-testid="`setting-${key}`">
      <div class="setting-text">
        <span :id="`${uid}-${key}-label`" class="setting-title">{{ t(`discordBridge.settings.${key}.label`) }}</span>
        <span :id="`${uid}-${key}-hint`" class="setting-hint">
          {{ t(`discordBridge.settings.${key}.hint`) }}
          <template v-if="INTENT_FOR[key] && local[key]">
            {{
              t(mode === 'instance' ? 'discordBridge.settings.needsInstanceIntent' : 'discordBridge.settings.needsIntent', {
                intent: DISCORD_INTENT_NAMES[INTENT_FOR[key]!],
              })
            }}
          </template>
          <template v-if="key === 'sync_presence' && mode === 'instance'">
            {{ t('discordBridge.settings.presenceInstance') }}
          </template>
        </span>
      </div>
      <ToggleSwitch
        :model-value="local[key]"
        :disabled="disabled || saving"
        :aria-labelledby="`${uid}-${key}-label`"
        :aria-describedby="`${uid}-${key}-hint`"
        @update:model-value="(value: boolean) => change(key, value)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { debug } from '@/utils/debug'
import {
  BRIDGE_SETTING_KEYS,
  type BridgeMode,
  type BridgeSettingKey,
  type BridgeSettings,
  type DiscordIntent,
} from '@/utils/discordBridgeSetup'
import { updateSettings } from './bridgeApi'
import { DISCORD_INTENT_NAMES } from './portalLabels'
import { bridgeErrorKey } from './bridgeErrors'

const props = defineProps<{
  bridgeId: string
  settings: BridgeSettings
  keys?: readonly BridgeSettingKey[]
  disabled?: boolean
  /** The instance bot's intents are the operator's; the hints say so. */
  mode?: BridgeMode
}>()

const emit = defineEmits<{ changed: [settings: BridgeSettings] }>()

const INTENT_FOR: Partial<Record<BridgeSettingKey, DiscordIntent>> = {
  sync_member_list: 'members',
  sync_presence: 'presence',
}

const { t } = useI18n()
const toast = useToast()
const uid = `bridge-settings-${useId()}`

const local = reactive<BridgeSettings>({ ...props.settings })
const saving = ref(false)
const shownKeys = computed(() => props.keys ?? BRIDGE_SETTING_KEYS)

watch(
  () => props.settings,
  (next) => {
    if (!saving.value) Object.assign(local, next)
  },
  { deep: true },
)

async function change(key: BridgeSettingKey, value: boolean) {
  const previous = local[key]
  local[key] = value
  saving.value = true
  try {
    await updateSettings(props.bridgeId, { ...local })
    emit('changed', { ...local })
  } catch (error) {
    debug.error('discord_bridge_update_settings failed:', error)
    local[key] = previous
    toast.error(t(bridgeErrorKey(error, 'discordBridge.errors.settings')))
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.settings-list {
  display: flex;
  flex-direction: column;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--background-quaternary);
}

.setting-row:first-child {
  padding-top: 0;
}

.setting-row:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.setting-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.setting-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.setting-hint {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}
</style>
