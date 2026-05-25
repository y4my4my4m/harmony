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
              <div class="color-picker">
                <!-- Main color options row -->
                <div class="color-row">
                  <!-- Default color -->
                  <div class="color-option-wrapper">
                    <button
                      class="color-swatch large"
                      :class="{ selected: isDefaultColor }"
                      :style="{ backgroundColor: DEFAULT_COLOR }"
                      @click="selectDefaultColor"
                      @mouseenter="showTooltip($event, 'Default')"
                      @mouseleave="hideTooltip"
                    >
                      <svg v-if="isDefaultColor" class="check-icon" viewBox="0 0 24 24">
                        <path fill="currentColor" d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z"/>
                      </svg>
                    </button>
                  </div>
                  
                  <!-- Custom color -->
                  <div class="color-option-wrapper">
                    <button
                      ref="customSwatchRef"
                      class="color-swatch large custom-color-swatch"
                      :class="{ selected: !isDefaultColor }"
                      :style="{ backgroundColor: customColor }"
                      @click="openColorPicker"
                      @mouseenter="showTooltip($event, 'Custom')"
                      @mouseleave="hideTooltip"
                    >
                      <svg v-if="!isDefaultColor" class="check-icon" viewBox="0 0 24 24">
                        <path fill="currentColor" d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z"/>
                      </svg>
                      <!-- Pencil icon when not selected -->
                      <svg v-else class="pencil-icon" viewBox="0 0 24 24" width="16" height="16">
                        <path fill="currentColor" d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/>
                      </svg>
                    </button>
                    
                    <!-- Hidden native color input for the color wheel -->
                    <input
                      ref="colorInputRef"
                      type="color"
                      class="hidden-color-input"
                      :value="customColor"
                      @input="onColorPickerChange"
                    />
                  </div>
                </div>
                
                <!-- Quick select colors grid -->
                <div class="color-grid">
                  <button
                    v-for="color in quickColors"
                    :key="color"
                    class="color-swatch"
                    :class="{ selected: selectedColor === color && !isDefaultColor }"
                    :style="{ backgroundColor: color }"
                    @click="selectQuickColor(color)"
                  >
                    <svg v-if="selectedColor === color && !isDefaultColor" class="check-icon" viewBox="0 0 24 24">
                      <path fill="currentColor" d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z"/>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <button class="btn btn-primary" :disabled="!isValid || isSaving" @click="save">
              {{ isSaving ? 'Saving...' : 'Done' }}
            </button>
          </div>
        </div>
        
        <!-- Tooltip -->
        <div 
          v-if="tooltip.visible"
          class="color-tooltip"
          :style="{ top: tooltip.y + 'px', left: tooltip.x + 'px' }"
        >
          {{ tooltip.text }}
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useServerChannelStore } from '@/stores/useServerChannel';
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
const customColor = ref('#3ba55c');
const isSaving = ref(false);
const colorInputRef = ref<HTMLInputElement | null>(null);
const customSwatchRef = ref<HTMLElement | null>(null);

// Tooltip state
const tooltip = ref<{ visible: boolean; text: string; x: number; y: number }>({
  visible: false,
  text: '',
  x: 0,
  y: 0
});

// Quick select colors (excluding default)
const quickColors = [
  '#43b581', '#3ba55c', '#faa61a', '#ed4245',
  '#eb459e', '#9b59b6', '#e67e22', '#f47b67',
  '#99aab5', '#607d8b', '#57f287', '#fee75c',
  '#5dadec', '#71368a', '#1abc9c', '#e74c3c',
  '#f1c40f', '#2ecc71', '#e91e63', '#00bcd4'
];

// Computed
const isDefaultColor = computed(() => selectedColor.value === DEFAULT_COLOR);

const isValid = computed(() => true);

const isEditMode = computed(() => {
  return props.folder !== null && props.folder !== undefined;
});

// Reset form when modal opens
watch(() => props.isOpen, (open) => {
  if (open) {
    if (props.folder) {
      folderName.value = props.folder.name;
      selectedColor.value = props.folder.color || DEFAULT_COLOR;
      if (props.folder.color && props.folder.color !== DEFAULT_COLOR) {
        customColor.value = props.folder.color;
      }
    } else {
      folderName.value = '';
      selectedColor.value = DEFAULT_COLOR;
    }
  }
});

// Color selection methods
const selectDefaultColor = () => {
  selectedColor.value = DEFAULT_COLOR;
};

const selectQuickColor = (color: string) => {
  customColor.value = color;
  selectedColor.value = color;
};

const openColorPicker = () => {
  // Trigger the native color input
  colorInputRef.value?.click();
};

const onColorPickerChange = (event: Event) => {
  const input = event.target as HTMLInputElement;
  customColor.value = input.value;
  selectedColor.value = input.value;
};

// Tooltip methods
const showTooltip = (event: MouseEvent, text: string) => {
  const target = event.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  tooltip.value = {
    visible: true,
    text,
    x: rect.left + rect.width / 2,
    y: rect.bottom + 8
  };
};

const hideTooltip = () => {
  tooltip.value.visible = false;
};

const close = () => {
  emit('close');
};

const save = async () => {
  if (!isValid.value || isSaving.value) return;

  isSaving.value = true;

  try {
    if (isEditMode.value && props.folder) {
      // Update existing folder
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
      // Create new folder
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
  border-bottom: 1px solid var(--h-black-lighter);
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
  background: var(--h-black-lighter);
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

