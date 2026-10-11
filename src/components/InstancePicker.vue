<template>
  <div class="instance-picker">
    <div
      ref="dialogEl"
      class="instance-picker__card"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      tabindex="-1"
      data-testid="instance-picker"
    >
      <img src="/icon_3d.webp" alt="" class="instance-picker__logo" />
      <h1 :id="titleId">{{ t('instancePicker.title') }}</h1>
      <p :id="hintId" class="instance-picker__hint">{{ t('instancePicker.hint') }}</p>

      <form :aria-busy="busy ? 'true' : undefined" @submit.prevent="connect">
        <label :for="inputId" class="sr-only">{{ t('instancePicker.domainLabel') }}</label>
        <div class="instance-picker__field">
          <span class="instance-picker__scheme" aria-hidden="true">https://</span>
          <!-- readonly, not disabled, while connecting: a disabled field drops focus to <body>. -->
          <input
            :id="inputId"
            ref="inputEl"
            v-model="domain"
            type="text"
            inputmode="url"
            placeholder="harmony.example.com"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            :readonly="busy"
            :aria-invalid="error ? 'true' : undefined"
            :aria-describedby="error ? `${errorId} ${hintId}` : hintId"
            @input="error = ''"
          />
        </div>
        <button
          ref="connectButton"
          type="submit"
          :disabled="!busy && !domain.trim()"
          :aria-disabled="busy ? 'true' : undefined"
        >
          {{ busy ? t('instancePicker.connecting') : t('instancePicker.connect') }}
        </button>
      </form>

      <p :id="errorId" class="instance-picker__error" role="alert">{{ error }}</p>
      <p v-if="current" class="instance-picker__current">
        <i18n-t keypath="instancePicker.current" scope="global">
          <template #name><strong>{{ current.name }}</strong></template>
        </i18n-t>
        <button type="button" class="instance-picker__link" @click="cancel">{{ t('instancePicker.keep') }}</button>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  defaultInstanceInput,
  fetchInstanceInfo,
  getStoredInstance,
  setStoredInstance,
} from '@/services/instanceConfig';
import { useDialog } from '@/composables/useDialog';
import { useAnnouncer } from '@/composables/useAnnouncer';

const emit = defineEmits<{ (e: 'close'): void }>();

const { t } = useI18n();
const { polite } = useAnnouncer();

const current = getStoredInstance();
const prefilled = !current && defaultInstanceInput() !== '';
const domain = ref(current ? new URL(current.origin).hostname : defaultInstanceInput());
const dialogEl = ref<HTMLElement | null>(null);
const connectButton = ref<HTMLButtonElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
const busy = ref(false);
const error = ref('');

const uid = useId();
const inputId = `instance-domain-${uid}`;
const hintId = `instance-hint-${uid}`;
const errorId = `instance-error-${uid}`;

// Mandatory on first run: Escape closes only when an instance is already stored.
const { titleId } = useDialog({
  open: () => true,
  element: dialogEl,
  onClose: () => cancel(),
  closeOnEscape: !!current,
  initialFocus: () => (prefilled ? connectButton.value : inputEl.value),
});

async function connect() {
  if (busy.value || !domain.value.trim()) return;
  busy.value = true;
  error.value = '';
  polite(t('instancePicker.connecting'));
  try {
    const info = await fetchInstanceInfo(domain.value);
    setStoredInstance(info);
    // full reload: supabase.ts reads the instance config at module init
    window.location.reload();
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('instancePicker.unreachable');
    busy.value = false;
  }
}

function cancel() {
  emit('close');
}
</script>

<style scoped>
.instance-picker {
  position: fixed;
  inset: 0;
  z-index: var(--z-gate);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--background-primary);
  color: var(--text-primary);
}

.instance-picker__card {
  width: min(420px, 90vw);
  padding: 2rem;
  border-radius: 12px;
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  text-align: center;
}

.instance-picker__logo {
  width: 56px;
  height: 56px;
  margin-bottom: 0.75rem;
}

.instance-picker__card h1 {
  margin: 0 0 0.5rem;
  font-size: 1.4rem;
}

.instance-picker__hint {
  font-size: 0.9rem;
  color: var(--text-secondary);
  margin-bottom: 1.25rem;
}

.instance-picker__card form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.instance-picker__field {
  display: flex;
  align-items: center;
  border-radius: 8px;
  border: 1px solid var(--border-hover);
  background: var(--background-tertiary);
  overflow: hidden;
}

.instance-picker__field:focus-within {
  border-color: var(--border-focus);
}

.instance-picker__scheme {
  padding-left: 0.9rem;
  color: var(--text-muted);
  font-size: 1rem;
  user-select: none;
  flex-shrink: 0;
}

.instance-picker__card input {
  flex: 1;
  min-width: 0;
  padding: 0.7rem 0.9rem 0.7rem 0.15rem;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 1rem;
}

.instance-picker__card input:focus {
  outline: none;
}

.instance-picker__card button[type='submit'] {
  padding: 0.7rem;
  border-radius: 8px;
  border: none;
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
}

.instance-picker__card button[type='submit']:disabled,
.instance-picker__card button[type='submit'][aria-disabled='true'] {
  opacity: 0.5;
  cursor: default;
}

.instance-picker__card button:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.instance-picker__error {
  margin-top: 1rem;
  color: var(--text-danger);
  font-size: 0.9rem;
}

.instance-picker__error:empty {
  margin: 0;
}

.instance-picker__current {
  margin-top: 1.25rem;
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.instance-picker__link {
  background: none;
  border: none;
  color: var(--text-link);
  cursor: pointer;
  font-size: 0.85rem;
  text-decoration: underline;
  margin-left: 0.4rem;
}
</style>
