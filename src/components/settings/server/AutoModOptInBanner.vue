<template>
  <div v-if="visible" class="automod-optin" role="region" :aria-label="t('automod.optin.title')">
    <Icon name="shield-check" :size="22" class="optin-icon" />
    <div class="optin-text">
      <strong>{{ t('automod.optin.title') }}</strong>
      <span>{{ t('automod.optin.body') }}</span>
    </div>
    <div class="optin-actions">
      <button type="button" class="btn btn-primary btn-sm" :disabled="busy" @click="enable">
        {{ t('automod.optin.enable') }}
      </button>
      <button type="button" class="btn btn-secondary btn-sm" :disabled="busy" @click="emit('review')">
        {{ t('automod.optin.review') }}
      </button>
      <button type="button" class="btn btn-link btn-sm" :disabled="busy" @click="dismiss">
        {{ t('automod.optin.dismiss') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import { debug } from '@/utils/debug'
import { dismissAutoModPrompt, enableAutoModPreset, type AutoModState } from '@/services/AutoModService'

const props = defineProps<{ serverId: string; status: AutoModState['status'] | null }>()
const emit = defineEmits<{ review: []; 'status-change': [status: AutoModState['status']] }>()

const { t } = useI18n()
const toast = useToast()
const busy = ref(false)

// Servers created before AutoMod existed have no settings row; nothing is enabled for them
// until a manager opts in here or on the AutoMod page.
const visible = computed(() => props.status === 'unconfigured')

async function enable() {
  busy.value = true
  try {
    const state = await enableAutoModPreset(props.serverId)
    emit('status-change', state.status)
    toast.success(t('automod.setup.enabled'))
  } catch (err: any) {
    debug.error('AutoMod opt-in failed:', err)
    toast.error(err?.message || t('automod.errors.generic'))
  } finally {
    busy.value = false
  }
}

async function dismiss() {
  busy.value = true
  try {
    const state = await dismissAutoModPrompt(props.serverId)
    emit('status-change', state.status)
  } catch (err: any) {
    debug.error('AutoMod prompt dismissal failed:', err)
    toast.error(err?.message || t('automod.errors.generic'))
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.automod-optin {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  margin-bottom: 16px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--harmony-primary) 45%, transparent);
  background: color-mix(in srgb, var(--harmony-primary) 12%, var(--background-secondary));
}

.optin-icon {
  flex-shrink: 0;
  color: var(--harmony-primary);
}

.optin-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 14px;
  color: var(--text-primary);
}

.optin-text span {
  font-size: 13px;
  color: var(--text-secondary);
}

.optin-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.btn-link {
  background: none;
  border: none;
  color: var(--text-secondary);
}

.btn-link:hover:not(:disabled) {
  color: var(--text-primary);
  text-decoration: underline;
}

@media (max-width: 640px) {
  .automod-optin {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
