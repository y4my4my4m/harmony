<template>
  <section class="encryption-section" :aria-labelledby="headingId">
    <h3 :id="headingId" class="encryption-heading">{{ t('channelEncryption.settings.heading') }}</h3>

    <p v-if="loading" class="encryption-hint">{{ t('channelEncryption.settings.loading') }}</p>
    <p v-else-if="!state" class="encryption-hint">{{ t('channelEncryption.settings.unavailable') }}</p>

    <template v-else>
      <div class="encryption-row">
        <div class="encryption-row-text">
          <span class="encryption-row-label">
            <Icon :name="state.messagesEncrypted ? 'lock' : 'unlock'" :size="14" />
            {{ t('channelEncryption.settings.messagesLabel') }}
          </span>
          <span class="encryption-hint">{{ messagesHint }}</span>
        </div>
        <ToggleSwitch
          :model-value="state.messagesEncrypted"
          :disabled="!canToggleMessages"
          :class="{ disabled: !canToggleMessages }"
          role="switch"
          :aria-checked="state.messagesEncrypted"
          :aria-label="t('channelEncryption.settings.messagesLabel')"
          :aria-disabled="!canToggleMessages"
          :tabindex="canToggleMessages ? 0 : -1"
          @change="toggleMessages"
          @keydown.enter.prevent="toggleMessages(!state.messagesEncrypted)"
          @keydown.space.prevent="toggleMessages(!state.messagesEncrypted)"
        />
      </div>

      <div v-if="isVoiceChannel" class="encryption-row">
        <div class="encryption-row-text">
          <span class="encryption-row-label">
            <Icon :name="state.voiceEncrypted ? 'lock' : 'unlock'" :size="14" />
            {{ t('channelEncryption.settings.voiceLabel') }}
          </span>
          <span class="encryption-hint">{{ voiceHint }}</span>
        </div>
        <ToggleSwitch
          :model-value="state.voiceEncrypted"
          :disabled="!canToggleVoice"
          :class="{ disabled: !canToggleVoice }"
          role="switch"
          :aria-checked="state.voiceEncrypted"
          :aria-label="t('channelEncryption.settings.voiceLabel')"
          :aria-disabled="!canToggleVoice"
          :tabindex="canToggleVoice ? 0 : -1"
          @change="toggleVoice"
          @keydown.enter.prevent="toggleVoice(!state.voiceEncrypted)"
          @keydown.space.prevent="toggleVoice(!state.voiceEncrypted)"
        />
      </div>

      <div v-if="integrationWarning" class="encryption-warning" role="note">
        <Icon name="alert-triangle" :size="14" />
        <span>{{ integrationWarning }}</span>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { fetchEffectiveChannelEncryption, setChannelEncryption } from '@/services/ChannelEncryptionService'
import { useChannelEncryptionStore } from '@/stores/useChannelEncryption'
import type { EffectiveChannelEncryption } from '@/utils/channelEncryption'
import type { Channel } from '@/types'
import { debug } from '@/utils/debug'

const props = defineProps<{
  channel: Channel
  /** Owner, instance admin or MANAGE_CHANNELS holder. set_channel_encryption re-checks. */
  canManage: boolean
}>()

const { t } = useI18n()
const toast = useToast()
const { confirm } = useConfirmDialog()
const channelEncryptionStore = useChannelEncryptionStore()

const headingId = `channel-encryption-${Math.random().toString(36).slice(2, 8)}`
const state = ref<EffectiveChannelEncryption | null>(null)
const loading = ref(false)
const saving = ref(false)

const isVoiceChannel = computed(() => Number(props.channel.type) === 1)

const canToggleMessages = computed(() =>
  props.canManage && !saving.value && !!state.value && !state.value.messagesLocked)
const canToggleVoice = computed(() =>
  props.canManage && !saving.value && !!state.value && !state.value.voiceLocked)

const messagesHint = computed(() => {
  const s = state.value
  if (!s) return ''
  if (s.serverMode === 'disabled') return t('channelEncryption.settings.serverDisabled')
  if (s.messagesLocked) return t('channelEncryption.settings.serverRequired')
  return s.messagesEncrypted
    ? t('channelEncryption.settings.messagesOnHint')
    : t('channelEncryption.settings.messagesOffHint')
})

const voiceHint = computed(() => {
  const s = state.value
  if (!s) return ''
  if (s.voiceMode === 'required') return t('channelEncryption.settings.voiceRequired')
  if (s.serverMode === 'disabled') return t('channelEncryption.settings.serverDisabled')
  return t('channelEncryption.settings.voiceHint')
})

function integrationText(s: EffectiveChannelEncryption): string {
  if (s.botCount > 0 && s.bridgeCount > 0) {
    return t('channelEncryption.integrations.both', { bots: s.botCount, bridges: s.bridgeCount })
  }
  if (s.bridgeCount > 0) return t('channelEncryption.integrations.bridges', { count: s.bridgeCount }, s.bridgeCount)
  return t('channelEncryption.integrations.bots', { count: s.botCount }, s.botCount)
}

const integrationWarning = computed(() => {
  const s = state.value
  if (!s || !s.messagesEncrypted || (s.botCount === 0 && s.bridgeCount === 0)) return ''
  return integrationText(s)
})

async function load() {
  loading.value = true
  try {
    state.value = await fetchEffectiveChannelEncryption(props.channel.id)
    if (state.value) channelEncryptionStore.applyEffective(state.value)
  } catch (error) {
    debug.error('Failed to load channel encryption:', error)
    state.value = null
  } finally {
    loading.value = false
  }
}

async function apply(change: { messagesEncrypted?: boolean; voiceEncrypted?: boolean }, successKey: string) {
  saving.value = true
  try {
    const next = await setChannelEncryption(props.channel.id, change)
    if (next) {
      state.value = next
      channelEncryptionStore.applyEffective(next)
    }
    toast.success(t(successKey))
  } catch (error: any) {
    debug.error('Failed to change channel encryption:', error)
    toast.error(error?.message || t('channelEncryption.settings.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function toggleMessages(enable: boolean) {
  const s = state.value
  if (!s || !canToggleMessages.value) return

  if (enable) {
    if (s.botCount > 0 || s.bridgeCount > 0) {
      const ok = await confirm({
        title: t('channelEncryption.confirmOn.title'),
        message: integrationText(s),
        confirmButtonText: t('channelEncryption.confirmOn.confirm'),
      })
      if (!ok) return
    }
    await apply({ messagesEncrypted: true }, 'channelEncryption.settings.turnedOn')
    return
  }

  const ok = await confirm({
    title: t('channelEncryption.confirmOff.title'),
    message: t('channelEncryption.confirmOff.message'),
    confirmButtonText: t('channelEncryption.confirmOff.confirm'),
    dangerAction: true,
  })
  if (!ok) return
  await apply({ messagesEncrypted: false }, 'channelEncryption.settings.turnedOff')
}

async function toggleVoice(enable: boolean) {
  if (!state.value || !canToggleVoice.value) return
  if (!enable) {
    const ok = await confirm({
      title: t('channelEncryption.confirmVoiceOff.title'),
      message: t('channelEncryption.confirmVoiceOff.message'),
      confirmButtonText: t('channelEncryption.confirmVoiceOff.confirm'),
      dangerAction: true,
    })
    if (!ok) return
  }
  await apply(
    { voiceEncrypted: enable },
    enable ? 'channelEncryption.settings.voiceTurnedOn' : 'channelEncryption.settings.voiceTurnedOff',
  )
}

watch(() => props.channel.id, () => { void load() }, { immediate: true })
</script>

<style scoped>
.encryption-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-bottom: 20px;
  padding: var(--space-4);
  background: var(--surface-inset);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
}

.encryption-heading {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.encryption-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.encryption-row-text {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.encryption-row-label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.encryption-hint {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: 1.4;
}

.encryption-warning {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-xs);
  line-height: 1.4;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border-radius: var(--radius-base);
}

.encryption-warning :deep(svg) {
  flex-shrink: 0;
  margin-top: 1px;
}
</style>
