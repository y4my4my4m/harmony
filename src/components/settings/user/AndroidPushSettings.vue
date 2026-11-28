<template>
  <div class="android-push">
    <div class="android-push-status">
      <div>
        <h4 class="android-push-title">{{ t('settings.notifications.android.title') }}</h4>
        <p class="android-push-active">
          {{ activeLabel }}<span v-if="statusNote"> · {{ statusNote }}</span>
        </p>
      </div>
      <button
        v-if="permissionState !== 'granted' && status"
        class="android-push-btn primary"
        :disabled="busy"
        @click="allowNotifications"
      >
        <Icon name="bell" />
        <span>{{ permissionState === 'denied' ? t('settings.notifications.android.openSettings') : t('settings.notifications.android.allow') }}</span>
      </button>
    </div>

    <p v-if="!status" class="android-push-note">
      {{ t('settings.notifications.android.unavailable') }}
    </p>

    <div v-else class="android-push-options" role="radiogroup" :aria-label="t('settings.notifications.android.service')">
      <label
        v-for="option in options"
        :key="option.value"
        class="android-push-option"
        :class="{ disabled: option.disabled, selected: preference === option.value }"
      >
        <input
          type="radio"
          name="android-push-transport"
          :value="option.value"
          :checked="preference === option.value"
          :disabled="option.disabled || busy"
          @change="select(option.value)"
        />
        <span class="android-push-option-text">
          <span class="android-push-option-label">{{ option.label }}</span>
          <span v-if="option.hint" class="android-push-option-hint">{{ option.hint }}</span>
        </span>
      </label>
    </div>

    <p v-if="status && status.unifiedPush.distributors.length === 0" class="android-push-note">
      {{ t('settings.notifications.android.noDistributor') }}
    </p>

    <div v-if="isActive" class="android-push-actions">
      <button class="android-push-btn" :disabled="busy" @click="sendTest">
        <Icon v-if="testing" name="loader" class="spinning" />
        <Icon v-else name="send" />
        <span>{{ t('settings.notifications.android.sendTest') }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import { usePushNotifications } from '@/composables/usePushNotifications'
import { useI18n } from 'vue-i18n'
import { type TransportPreference, fcmDirect, relayReady } from '@/services/androidPush'

const toast = useToast()
const { t } = useI18n()
const push = usePushNotifications()
const busy = ref(false)
const testing = ref(false)

const status = computed(() => push.androidStatus.value)
const choice = computed(() => push.androidChoice.value)
const preference = computed(() => push.androidPreference.value)
const server = computed(() => push.serverSupport.value)
const permissionState = computed(() => status.value?.permission ?? 'granted')
const isActive = computed(() => push.isSubscribed.value && choice.value?.kind !== 'off' && permissionState.value === 'granted')

const activeLabel = computed(() => {
  const c = choice.value
  if (!status.value || !c || c.kind === 'off') return t('settings.notifications.android.off')
  if (c.kind === 'fcm') return 'Google (FCM)'
  if (c.kind === 'relay') return t('settings.notifications.android.fcmThrough', { host: hostOf(c.origin) })
  const name = status.value.unifiedPush.distributors.find(d => d.id === c.distributor)?.name || c.distributor
  return t('settings.notifications.android.unifiedPushVia', { name })
})

const statusNote = computed(() => {
  const c = choice.value
  if (!status.value || !c) return ''
  if (permissionState.value !== 'granted') return t('settings.notifications.android.note.notAllowed')
  if (c.kind === 'off') {
    if (c.reason === 'choose_distributor') return t('settings.notifications.android.note.chooseService')
    if (c.reason === 'unavailable') return t('settings.notifications.android.note.noService')
    return ''
  }
  if (push.error.value) return push.error.value
  return push.isSubscribed.value ? t('settings.notifications.android.note.active') : t('settings.notifications.android.note.registering')
})

function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

// Google reaches this device directly, or through the relay when the server cannot.
const googleDirect = computed(() => !!status.value && !!server.value && fcmDirect(status.value, server.value))
const googleRelayed = computed(() =>
  !!status.value && !!server.value && relayReady(status.value, server.value, push.relaySupport.value))

const fcmHint = computed(() => {
  const fcm = status.value?.fcm
  if (fcm === 'no_config') return t('settings.notifications.android.hint.notInBuild')
  if (fcm === 'no_play_services') return t('settings.notifications.android.hint.needsPlay')
  if (server.value && !googleDirect.value && googleRelayed.value) {
    return t('settings.notifications.android.hint.googleRelayed', { host: new URL(push.relaySupport.value!.origin).host })
  }
  if (server.value && !googleDirect.value) return t('settings.notifications.android.hint.notConfigured')
  return t('settings.notifications.android.hint.google')
})

const options = computed(() => {
  const list: Array<{ value: TransportPreference; label: string; hint?: string; disabled?: boolean }> = [
    { value: 'auto', label: t('settings.notifications.android.auto'), hint: t('settings.notifications.android.hint.auto') },
    {
      value: 'fcm',
      label: 'Google (FCM)',
      hint: fcmHint.value,
      disabled: status.value?.fcm !== 'available' || (!!server.value && !googleDirect.value && !googleRelayed.value),
    },
  ]
  for (const d of status.value?.unifiedPush.distributors ?? []) {
    list.push({
      value: `unifiedpush:${d.id}`,
      label: t('settings.notifications.android.unifiedPushVia', { name: d.name }),
      hint: server.value?.unifiedpush === false ? t('settings.notifications.android.hint.notConfigured') : t('settings.notifications.android.hint.ownService'),
      disabled: server.value?.unifiedpush === false,
    })
  }
  list.push({ value: 'off', label: t('settings.notifications.android.off'), hint: t('settings.notifications.android.hint.off') })
  return list
})

async function select(value: TransportPreference) {
  busy.value = true
  try {
    await push.setAndroidTransport(value)
    if (push.error.value) toast.error(push.error.value)
  } finally {
    busy.value = false
  }
}

async function allowNotifications() {
  busy.value = true
  try {
    await push.enableAndroidNotifications()
  } finally {
    busy.value = false
  }
}

async function sendTest() {
  testing.value = true
  busy.value = true
  try {
    const result = await push.sendTestNotification()
    if (result.success) toast.success(t('settings.notifications.android.testSent'))
    else toast.error(result.error || t('settings.notifications.android.testFailed'))
  } finally {
    testing.value = false
    busy.value = false
  }
}

onMounted(() => {
  void push.reconcile()
})
</script>

<style scoped>
.android-push {
  margin-bottom: 20px;
  padding: 16px;
  background: var(--background-secondary);
  border: 1px solid var(--border-secondary);
  border-radius: var(--radius-md);
}

.android-push-status {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.android-push-title {
  margin: 0 0 4px 0;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.android-push-active {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.android-push-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.android-push-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border-secondary);
  border-radius: var(--radius-md);
  cursor: pointer;
}

.android-push-option.selected {
  border-color: color-mix(in srgb, var(--harmony-primary) 50%, transparent);
  background: color-mix(in srgb, var(--harmony-primary) 8%, transparent);
}

.android-push-option.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.android-push-option input {
  margin-top: 3px;
  accent-color: var(--harmony-primary);
}

.android-push-option-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.android-push-option-label {
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.android-push-option-hint {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.android-push-note {
  margin: 12px 0 0 0;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  line-height: 1.4;
}

.android-push-actions {
  display: flex;
  gap: 12px;
  margin-top: 12px;
}

.android-push-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  border: 1px solid color-mix(in srgb, var(--harmony-primary) 30%, transparent);
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  color: var(--text-link);
}

.android-push-btn.primary {
  background: var(--harmony-primary-fill);
  border-color: var(--harmony-primary);
  color: var(--text-on-primary);
}

.android-push-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: android-push-spin 1s linear infinite;
}

@keyframes android-push-spin {
  to { transform: rotate(360deg); }
}
</style>
