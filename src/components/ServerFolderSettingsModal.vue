<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="isOpen" class="modal-overlay" @click.self="close">
        <div class="modal-container">
          <div class="modal-header">
            <h2 class="modal-title">Folder Settings</h2>
            <button class="close-button" @click="close">
              <svg viewBox="0 0 24 24" width="24" height="24">
                <path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
              </svg>
            </button>
          </div>

          <div class="modal-body">
            <!-- Folder Name -->
            <div class="form-group">
              <label class="form-label">Folder Name <span class="optional">(optional)</span></label>
              <input
                v-model="folderName"
                type="text"
                class="form-input"
                placeholder="Leave empty for no name"
                maxlength="32"
                @keydown.enter="save"
              />
            </div>

            <!-- Folder Color -->
            <div class="form-group">
              <label class="form-label">Folder Color</label>
              <ColorPicker
                :color="selectedColor"
                @update:color="selectedColor = $event"
                @change="selectedColor = $event"
              />
            </div>
          </div>

          <div class="modal-footer">
            <button class="btn btn-primary" :disabled="!isValid || isSaving" @click="save">
              {{ isSaving ? 'Saving...' : 'Done' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useServerChannelStore } from '@/stores/useServerChannel';
import ColorPicker from '@/components/common/ColorPicker.vue';
import type { ServerFolder } from '@/types';

interface Props {
  isOpen: boolean;
  folder?: ServerFolder | null;
}

interface Emits {
  (e: 'close'): void;
  (e: 'saved', folder: ServerFolder): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const serverChannelStore = useServerChannelStore();

// Constants
const DEFAULT_COLOR = '#0EA5E9';

// State
const folderName = ref('');
const selectedColor = ref(DEFAULT_COLOR);
const isSaving = ref(false);

// Computed
const isValid = computed(() => true);

const isEditMode = computed(() => {
  return props.folder !== null && props.folder !== undefined;
});

watch(() => props.isOpen, (open) => {
  if (open) {
    if (props.folder) {
      folderName.value = props.folder.name;
      selectedColor.value = props.folder.color || DEFAULT_COLOR;
    } else {
      folderName.value = '';
      selectedColor.value = DEFAULT_COLOR;
    }
  }
});

const close = () => {
  emit('close');
};

const save = async () => {
  if (!isValid.value || isSaving.value) return;

  isSaving.value = true;

  try {
    if (isEditMode.value && props.folder) {
      const success = await serverChannelStore.updateFolder(props.folder.id, {
        name: folderName.value.trim(),
        color: selectedColor.value
      });

      if (success) {
        emit('saved', {
          ...props.folder,
          name: folderName.value.trim(),
          color: selectedColor.value
        });
        close();
      }
    } else {
      const newFolder = await serverChannelStore.createFolder(
        folderName.value.trim(),
        selectedColor.value
      );

      if (newFolder) {
        emit('saved', newFolder);
        close();
      }
    }
  } finally {
    isSaving.value = false;
  }
};
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.modal-container {
  background: var(--background-tertiary);
  border-radius: 8px;
  width: 100%;
  max-width: 440px;
  max-height: 90vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--background-quinary);
}

.modal-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

.close-button {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.close-button:hover {
  color: #dcddde;
  background: var(--background-quinary);
}

.modal-body {
  padding: 16px;
  overflow-y: auto;
  flex: 1;
}

.form-group {
  margin-bottom: 20px;
}

.form-label {
  display: block;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #b9bbbe;
  margin-bottom: 8px;
}

.form-label .optional {
  font-weight: 400;
  text-transform: none;
  color: var(--text-muted);
  font-size: 11px;
}

.form-input {
  width: 100%;
  padding: 10px 12px;
  background: #202225;
  border: 1px solid #040405;
  border-radius: 4px;
  color: #dcddde;
  font-size: 16px;
  outline: none;
  transition: border-color 0.15s ease;
}

.form-input:focus {
  border-color: var(--harmony-primary, #0EA5E9);
}

.form-input::placeholder {
  color: var(--text-muted);
}

/* Color picker */
.color-picker {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.color-row {
  display: flex;
  gap: 8px;
}

.color-grid {
  display: grid;
  grid-template-columns: repeat(10, 1fr);
  gap: 6px;
}

.color-swatch {
  width: 28px;
  height: 28px;
  border-radius: 4px;
  border: 2px solid transparent;
  cursor: pointer;
  position: relative;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.color-swatch.large {
  width: 48px;
  height: 48px;
  border-radius: 6px;
}

.color-swatch:hover {
  transform: scale(1.1);
}

.color-swatch.selected {
  border-color: var(--text-primary);
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.3);
}

.check-icon {
  width: 16px;
  height: 16px;
  color: var(--text-primary);
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.5));
}

.color-swatch.large .check-icon {
  width: 20px;
  height: 20px;
}

/* Footer */
.modal-footer {
  padding: 16px;
  background: #292b2f;
  display: flex;
  justify-content: flex-end;
}

.btn {
  padding: 10px 24px;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  border: none;
  transition: all 0.15s ease;
}

.btn-primary {
  background: var(--harmony-primary, #0EA5E9);
  color: var(--text-primary);
}

.btn-primary:hover:not(:disabled) {
  background: #0284C7;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Modal animation */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}

.modal-enter-active .modal-container,
.modal-leave-active .modal-container {
  transition: transform 0.2s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-container,
.modal-leave-to .modal-container {
  transform: scale(0.95);
}

/* Color option wrapper */
.color-option-wrapper {
  position: relative;
}

/* Custom color swatch - pencil icon */
.pencil-icon {
  color: rgba(255, 255, 255, 0.7);
}

.custom-color-swatch:hover .pencil-icon {
  color: var(--text-primary);
}

/* Hidden native color input - the browser opens its own color picker dialog */
.hidden-color-input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
  pointer-events: none;
}

/* Color tooltip */
.color-tooltip {
  position: fixed;
  background: #18191c;
  color: var(--text-primary);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  pointer-events: none;
  z-index: 1000;
  transform: translateX(-50%);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.color-tooltip::before {
  content: '';
  position: absolute;
  top: -6px;
  left: 50%;
  transform: translateX(-50%);
  border-left: 6px solid transparent;
  border-right: 6px solid transparent;
  border-bottom: 6px solid #18191c;
}
</style>

