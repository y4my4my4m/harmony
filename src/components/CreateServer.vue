<template>
  <div class="create-server-overlay" @click.self="closeModal">
    <form
      class="create-server-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-server-title"
      novalidate
      @submit.prevent="createServer"
    >
      <header class="modal-header">
        <div class="header-text">
          <h2 id="create-server-title" class="modal-title">{{ $t('server.createYourServer') }}</h2>
          <p class="modal-subtitle">{{ $t('server.buildCommunity') }}</p>
        </div>
        <button
          type="button"
          class="close-button"
          :aria-label="$t('common.close')"
          :disabled="isCreating"
          @click="closeModal"
        >
          <Icon name="x" :size="20" />
        </button>
      </header>

      <div class="create-server-body">
        <div class="section icon-section">
          <button
            type="button"
            class="icon-preview"
            :aria-label="$t('server.serverIcon')"
            :disabled="isCreating"
            @click="triggerIconUpload"
          >
            <img v-if="iconPreview" :src="iconPreview" alt="" />
            <Icon v-else name="image" :size="26" />
            <span class="upload-overlay" aria-hidden="true">
              <Icon name="upload" :size="18" />
            </span>
          </button>
          <input
            ref="iconInput"
            type="file"
            accept="image/*"
            class="file-input"
            tabindex="-1"
            aria-hidden="true"
            @change="handleIconUpload"
          />
          <div class="icon-meta">
            <span class="section-label">{{ $t('server.serverIcon') }}</span>
            <span class="hint">{{ $t('server.iconUploadHint') }}</span>
            <div class="icon-actions">
              <button type="button" class="btn btn-secondary btn-compact" :disabled="isCreating" @click="triggerIconUpload">
                {{ $t('files.browse') }}
              </button>
              <button v-if="iconFile" type="button" class="btn btn-ghost btn-compact" :disabled="isCreating" @click="removeIcon">
                {{ $t('common.remove') }}
              </button>
            </div>
          </div>
        </div>

        <div class="section">
          <label for="create-server-name" class="section-label">{{ $t('server.serverName') }}</label>
          <input
            id="create-server-name"
            ref="nameInput"
            v-model="serverName"
            type="text"
            class="field"
            :class="{ 'field--invalid': showNameError }"
            data-testid="create-server-name-input"
            :placeholder="$t('server.placeholders.serverName')"
            :maxlength="NAME_MAX"
            autocomplete="off"
            :aria-invalid="showNameError"
            aria-describedby="create-server-name-feedback"
            :disabled="isCreating"
            @blur="nameTouched = nameTouched || serverName.length > 0"
          />
          <div id="create-server-name-feedback" class="input-feedback">
            <span v-if="showNameError" class="error-text">{{ nameError }}</span>
            <span class="char-count">{{ serverName.length }}/{{ NAME_MAX }}</span>
          </div>
        </div>

        <div class="section">
          <label for="create-server-description" class="section-label">
            {{ $t('server.description') }} <span class="optional">({{ $t('common.optional') }})</span>
          </label>
          <textarea
            id="create-server-description"
            v-model="description"
            class="field field--textarea"
            :placeholder="$t('server.placeholders.description')"
            :maxlength="DESCRIPTION_MAX"
            rows="3"
            :disabled="isCreating"
          ></textarea>
          <div class="input-feedback">
            <span class="char-count">{{ description.length }}/{{ DESCRIPTION_MAX }}</span>
          </div>
        </div>

        <fieldset class="section privacy-fieldset" :disabled="isCreating">
          <legend class="section-label">{{ $t('server.privacySettings') }}</legend>
          <div class="privacy-options">
            <label class="privacy-option" :class="{ active: !isPublic }">
              <input v-model="isPublic" type="radio" name="create-server-visibility" :value="false" class="privacy-radio" />
              <span class="option-icon"><Icon name="lock" :size="16" /></span>
              <span class="option-content">
                <span class="option-title">{{ $t('server.private') }}</span>
                <span class="option-description">{{ $t('server.privateDesc') }}</span>
              </span>
            </label>

            <label class="privacy-option" :class="{ active: isPublic }">
              <input v-model="isPublic" type="radio" name="create-server-visibility" :value="true" class="privacy-radio" />
              <span class="option-icon"><Icon name="globe" :size="16" /></span>
              <span class="option-content">
                <span class="option-title">{{ $t('server.public') }}</span>
                <span class="option-description">{{ $t('server.publicDesc') }}</span>
              </span>
            </label>
          </div>
        </fieldset>

        <div class="section">
          <span id="create-server-category-label" class="section-label">
            {{ $t('server.discoveryCategory') }} <span class="optional">({{ $t('common.optional') }})</span>
          </span>
          <ServerCategoryPicker
            v-model="category"
            name="create-server-category"
            labelledby="create-server-category-label"
            :disabled="isCreating"
          />
          <p class="hint category-hint">
            {{ category ? $t('server.discoveryCategoryHint') : $t('server.discoveryCategoryNoneHint') }}
          </p>
        </div>
      </div>

      <div v-if="errorMessage" class="error-banner" role="alert">
        <Icon name="alert-circle" :size="16" />
        <span>{{ errorMessage }}</span>
      </div>

      <footer class="modal-actions">
        <button type="button" class="btn btn-ghost" :disabled="isCreating" @click="closeModal">
          {{ $t('common.cancel') }}
        </button>
        <button
          type="submit"
          class="btn btn-primary"
          data-testid="create-server-btn"
          :disabled="isCreating"
        >
          <Icon v-if="isCreating" name="spinner" :size="16" class="spin" />
          {{ isCreating ? $t('server.creating') : $t('server.createButton') }}
        </button>
      </footer>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useToast } from 'vue-toastification';
import { debug } from '@/utils/debug';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useAuthStore } from '@/stores/auth';
import { useOpenServer } from '@/composables/useOpenServer';
import Icon from '@/components/common/Icon.vue';
import ServerCategoryPicker from '@/components/common/ServerCategoryPicker.vue';
import { usePublicServersStore } from '@/stores/usePublicServers';
import type { ServerCategory } from '@/utils/serverDiscovery';
import type { Server } from '@/types';

const emit = defineEmits<{
  close: []
  created: [server: Server]
}>();

const NAME_MIN = 2;
const NAME_MAX = 28;
const DESCRIPTION_MAX = 500;
const ICON_MAX_BYTES = 5 * 1024 * 1024;

const { t } = useI18n();
const toast = useToast();
const serverChannelStore = useServerChannelStore();
const authStore = useAuthStore();
const openServer = useOpenServer();

const serverName = ref('');
const description = ref('');
const isPublic = ref(false);
const category = ref<ServerCategory | null>(null);
const iconFile = ref<File | null>(null);
const iconPreview = ref<string | null>(null);
const errorMessage = ref('');
const isCreating = ref(false);
const nameTouched = ref(false);
const submitAttempted = ref(false);

const iconInput = ref<HTMLInputElement>();
const nameInput = ref<HTMLInputElement>();

const nameError = computed(() => {
  const length = serverName.value.trim().length;
  if (length === 0) return t('server.errors.nameRequired');
  if (length < NAME_MIN) return t('server.errors.nameTooShort');
  return '';
});

const showNameError = computed(() => (nameTouched.value || submitAttempted.value) && !!nameError.value);

const triggerIconUpload = () => {
  iconInput.value?.click();
};

const handleIconUpload = (event: Event) => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;

  if (file.size > ICON_MAX_BYTES) {
    toast.error('Icon file size must be less than 5MB');
    target.value = '';
    return;
  }

  iconFile.value = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    iconPreview.value = e.target?.result as string;
  };
  reader.readAsDataURL(file);
};

const removeIcon = () => {
  iconFile.value = null;
  iconPreview.value = null;
  if (iconInput.value) {
    iconInput.value.value = '';
  }
};

const closeModal = () => {
  if (isCreating.value) return;
  emit('close');
};

const onKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') closeModal();
};

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  void nextTick(() => nameInput.value?.focus());
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
});

const uploadIcon = async (serverId: string, file: File) => {
  try {
    const { uploadServerIcon } = await import('@/utils/fileUpload');
    const uploadResult = await uploadServerIcon(file, serverId);

    if (uploadResult.success && uploadResult.url) {
      await serverChannelStore.updateServer({ id: serverId, icon: uploadResult.url });
    } else {
      debug.error('Server icon upload failed:', uploadResult.error);
      toast.warning(`Server created, but the icon couldn't be uploaded: ${uploadResult.error || 'unknown error'}. You can update it later in server settings.`);
    }
  } catch (uploadError) {
    debug.error('Server icon upload error:', uploadError);
    toast.warning('Server created but icon upload failed. You can update it later in server settings.');
  }
};

const createServer = async () => {
  if (isCreating.value) return;

  submitAttempted.value = true;
  if (nameError.value) {
    nameInput.value?.focus();
    return;
  }

  const userId = authStore.session?.user?.id;
  if (!userId) {
    errorMessage.value = t('server.errors.notSignedIn');
    return;
  }

  isCreating.value = true;
  errorMessage.value = '';

  let created: Server;
  try {
    created = await serverChannelStore.createServer({
      name: serverName.value.trim(),
      description: description.value.trim() || undefined,
      public: isPublic.value,
      category: category.value,
      owner: userId
    });
    usePublicServersStore().markStale();
  } catch (error) {
    debug.error('Server creation error:', error);
    errorMessage.value = t('server.errors.createFailed');
    isCreating.value = false;
    return;
  }

  if (iconFile.value) {
    await uploadIcon(created.id, iconFile.value);
  }

  try {
    await openServer(created.id);
  } catch (error) {
    debug.error('Could not open the new server:', error);
  }

  isCreating.value = false;
  emit('created', created);
  emit('close');
};
</script>

<style scoped src="./PublicServers/discoveryButtons.css"></style>

<style scoped>
.create-server-overlay {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--background-tertiary) 70%, transparent);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-5);
  z-index: 1000;
  animation: fadeIn 0.2s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.create-server-modal {
  background: var(--background-primary);
  border-radius: var(--radius-xl);
  border: 1px solid var(--border-primary);
  box-shadow: var(--shadow-modal);
  width: 100%;
  max-width: 520px;
  max-height: 90vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  animation: slideUp 0.2s ease-out;
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-5) var(--space-6) var(--space-4);
  border-bottom: none;
}

.header-text {
  min-width: 0;
}

.modal-title {
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-bold);
  color: var(--text-primary);
  margin: 0 0 var(--space-1);
}

.modal-subtitle {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0;
}

.close-button {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.close-button:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.close-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.close-button:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.create-server-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2) var(--space-6) var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.section {
  width: 100%;
}

.section-label {
  display: block;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
  margin-bottom: var(--space-2);
}

.optional {
  font-weight: var(--font-weight-normal);
  text-transform: none;
  letter-spacing: 0;
  color: var(--text-muted);
}

.icon-section {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.icon-preview {
  position: relative;
  width: 80px;
  height: 80px;
  flex-shrink: 0;
  padding: 0;
  border-radius: var(--radius-full);
  border: 2px dashed var(--border-hover);
  background: var(--background-secondary);
  color: var(--text-muted);
  overflow: hidden;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color var(--transition-fast);
}

.icon-preview:hover:not(:disabled) {
  border-color: var(--harmony-primary);
}

.icon-preview:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.icon-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.upload-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  color: var(--text-light);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.icon-preview:hover .upload-overlay,
.icon-preview:focus-visible .upload-overlay {
  opacity: 1;
}

.file-input {
  display: none;
}

.icon-meta {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.icon-meta .section-label {
  margin-bottom: 0;
}

.hint {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.category-hint {
  margin: var(--space-2) 0 0;
}

.icon-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-1);
}

.btn-compact {
  min-height: 30px;
  padding: 0 var(--space-3);
  font-size: var(--font-size-xs);
}

.field {
  width: 100%;
  padding: 10px 12px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: var(--font-size-base);
  font-family: inherit;
  line-height: 1.4;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.field--textarea {
  resize: vertical;
  min-height: 72px;
}

.field:focus {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px var(--harmony-primary-light);
}

.field--invalid,
.field--invalid:focus {
  border-color: var(--error);
}

.field::placeholder {
  color: var(--text-muted);
}

.field:disabled {
  opacity: 0.6;
}

.input-feedback {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: 6px;
  min-height: 18px;
}

.error-text {
  font-size: var(--font-size-xs);
  color: var(--error);
}

.char-count {
  margin-left: auto;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.privacy-fieldset {
  border: none;
  padding: 0;
  margin: 0;
  min-width: 0;
}

.privacy-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

.privacy-option {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  cursor: pointer;
  min-width: 0;
  transition: border-color var(--transition-fast), background-color var(--transition-fast);
}

.privacy-option:hover {
  border-color: var(--border-hover);
}

.privacy-option.active {
  border-color: var(--harmony-primary);
  background: var(--harmony-primary-light);
}

.privacy-option:has(.privacy-radio:focus-visible) {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

/* Visually hidden; stays focusable so the pair behaves as a native radio group. */
.privacy-radio {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
  margin: 0;
  pointer-events: none;
}

.option-icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.privacy-option.active .option-icon {
  color: var(--harmony-primary);
}

.option-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.option-title {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.option-description {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  line-height: 1.35;
}

.error-banner {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0 var(--space-6) var(--space-4);
  padding: 10px 12px;
  border-radius: var(--radius-md);
  border: 1px solid color-mix(in srgb, var(--error) 40%, transparent);
  background: color-mix(in srgb, var(--error) 10%, transparent);
  color: var(--error);
  font-size: var(--font-size-sm);
  line-height: 1.4;
}

.error-banner :deep(.icon-wrap) {
  flex-shrink: 0;
  margin-top: 1px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-6);
  border-top: 1px solid var(--border-primary);
  background: var(--background-secondary);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .create-server-overlay {
    padding: 0;
    align-items: stretch;
  }

  .create-server-modal {
    max-width: none;
    max-height: none;
    height: 100vh;
    height: 100dvh;
    border: none;
    border-radius: 0;
    padding-top: env(safe-area-inset-top, 0px);
  }

  .modal-header,
  .create-server-body {
    padding-left: var(--space-4);
    padding-right: var(--space-4);
  }

  .error-banner {
    margin-left: var(--space-4);
    margin-right: var(--space-4);
  }

  .modal-actions {
    padding: var(--space-3) var(--space-4) calc(var(--space-3) + env(safe-area-inset-bottom, 0px));
  }

  .modal-actions .btn {
    flex: 1;
  }

  .privacy-options {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .create-server-overlay,
  .create-server-modal,
  .spin {
    animation: none;
  }
}
</style>
