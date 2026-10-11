<!--
  AltTextDialog - the description of one attached chat image for people who
  cannot see it. Mirrors the description field of activitypub/MediaEditDialog:
  a labelled textarea that takes focus, with the image beside it. Ctrl+Enter
  saves. The text is stored as `altText` on the message's file part.
-->
<template>
  <AppDialog
    :open="true"
    class="alt-text-dialog"
    data-testid="alt-text-dialog"
    v-slot="{ titleId }"
    @close="emit('cancel')"
  >
    <h2 :id="titleId" class="alt-text-title">{{ t('messageA11y.alt.title', { name }) }}</h2>
    <div class="alt-text-body">
      <img v-if="preview" :src="preview" alt="" class="alt-text-preview" />
      <div class="alt-text-field">
        <label :for="fieldId" class="alt-text-label">{{ t('activitypub.altTextLabel') }}</label>
        <textarea
          :id="fieldId"
          v-model="text"
          class="alt-text-input"
          rows="4"
          :maxlength="ALT_TEXT_MAX"
          :placeholder="t('activitypub.altTextPlaceholder')"
          :aria-describedby="countId"
          data-autofocus
          data-testid="alt-text-input"
          @keydown.enter.ctrl.prevent="save"
          @keydown.enter.meta.prevent="save"
        />
        <span :id="countId" class="alt-text-count">{{ text.length }} / {{ ALT_TEXT_MAX }}</span>
      </div>
    </div>
    <div class="alt-text-actions">
      <button type="button" class="btn btn-ghost" @click="emit('cancel')">{{ t('common.cancel') }}</button>
      <button type="button" class="btn btn-primary" data-testid="alt-text-save" @click="save">{{ t('common.save') }}</button>
    </div>
  </AppDialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import AppDialog from '@/components/a11y/AppDialog.vue'
import { useT } from '@/composables/useT'
import { uid } from '@/utils/a11y/focus'

// Mastodon's media description limit, as MediaEditDialog.
const ALT_TEXT_MAX = 1500

const props = defineProps<{
  name: string
  preview?: string
  initial?: string
}>()

const emit = defineEmits<{
  save: [text: string]
  cancel: []
}>()

const { t } = useT()
const fieldId = uid('alt-text')
const countId = uid('alt-text-count')
const text = ref(props.initial ?? '')

function save() {
  emit('save', text.value.trim())
}
</script>

<style>
/* The dialog element is AppDialog's; scoped styles reach only the slot content. */
.app-dialog-overlay > .alt-text-dialog {
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  overflow: auto;
  padding: var(--space-4, 16px);
  border-radius: var(--radius-lg, 12px);
  background: var(--background-primary);
  box-shadow: var(--shadow-large);
  color: var(--text-primary);
}
</style>

<style scoped>
.alt-text-title {
  margin: 0 0 12px;
  font-size: 1.125rem;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.alt-text-body {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.alt-text-preview {
  width: 96px;
  height: 96px;
  flex-shrink: 0;
  object-fit: cover;
  border-radius: var(--radius-md, 8px);
  background: var(--background-tertiary);
}

.alt-text-field {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
}

.alt-text-label {
  font-size: var(--font-size-sm, 0.875rem);
  font-weight: 500;
  color: var(--text-secondary);
}

.alt-text-input {
  width: 100%;
  resize: vertical;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md, 8px);
  background: var(--background-secondary);
  color: var(--text-primary);
  font: inherit;
}

.alt-text-input:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}

.alt-text-count {
  align-self: flex-end;
  font-size: var(--font-size-xs, 0.75rem);
  color: var(--text-muted);
}

.alt-text-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

@media (max-width: 480px) {
  .alt-text-body {
    flex-direction: column;
  }
}
</style>
