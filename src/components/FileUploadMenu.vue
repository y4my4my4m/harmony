<!--
  FileUploadMenu - the composer's + menu (upload a file, create a poll) on
  components/a11y/AppMenu.vue, anchored to the attach button. The file input
  stays mounted outside the menu: the menu closes while the system file picker
  is open, and the input must still receive its change event.
-->
<template>
  <AppMenu
    v-if="isVisible"
    :id="menuId"
    class="file-upload-menu"
    :anchor="anchor"
    :initial-focus="initialFocus"
    :label="t('messageA11y.composer.attachMenu')"
    @close="(reason) => emit('close', reason)"
  >
    <button type="button" role="menuitem" class="menu-item" data-testid="upload-menu-file" @click="handleFileUpload">
      <svg class="menu-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <polyline points="10,9 9,9 8,9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>{{ t('files.uploadFile') }}</span>
    </button>
    <button v-if="allowDrive" type="button" role="menuitem" class="menu-item" data-testid="upload-menu-drive" @click="handlePickDrive">
      <Icon name="hard-drive" :size="20" class="menu-icon" />
      <span>{{ t('drive.composer.fromDriveMenu') }}</span>
    </button>
    <button v-if="allowPoll" type="button" role="menuitem" class="menu-item" data-testid="upload-menu-poll" @click="handleCreatePoll">
      <Icon name="bar-chart-2" :size="20" class="menu-icon" />
      <span>{{ t('polls.create') }}</span>
    </button>
  </AppMenu>
  <input
    ref="fileInput"
    type="file"
    multiple
    accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.zip,.rar"
    class="hidden-file-input"
    tabindex="-1"
    aria-hidden="true"
    data-testid="composer-file-input"
    @change="onFileSelect"
  />
</template>

<script setup lang="ts">
import { ref } from 'vue';
import Icon from '@/components/common/Icon.vue';
import AppMenu from '@/components/a11y/AppMenu.vue';
import type { MenuCloseReason } from '@/composables/useMenu';
import { useT } from '@/composables/useT';

withDefaults(defineProps<{
  isVisible?: boolean;
  allowPoll?: boolean;
  /** Offers files from Drive; the parent handles `pick-drive`. */
  allowDrive?: boolean;
  /** The attach button: the menu opens beside it and focus returns to it. */
  anchor?: HTMLElement | null;
  menuId?: string;
  initialFocus?: 'first' | 'last';
}>(), {
  isVisible: false,
  allowPoll: false,
  allowDrive: false,
  anchor: null,
  menuId: undefined,
  initialFocus: 'first',
});

const emit = defineEmits<{
  'files-selected': [files: File[]];
  close: [reason?: MenuCloseReason];
  'create-poll': [];
  'pick-drive': [];
}>();

const { t } = useT();
const fileInput = ref<HTMLInputElement | null>(null);

const handlePickDrive = () => {
  emit('pick-drive');
  emit('close', 'select');
};

const handleFileUpload = () => {
  fileInput.value?.click();
  emit('close', 'select');
};

const handleCreatePoll = () => {
  emit('create-poll');
};

const onFileSelect = (event: Event) => {
  const target = event.target as HTMLInputElement;
  const files = target.files;
  if (files && files.length > 0) {
    emit('files-selected', Array.from(files));
    target.value = '';
  }
};
</script>

<style>
/* The menu element is AppMenu's; scoped styles reach only the slot content. */
.app-menu.file-upload-menu {
  background: var(--background-floating);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-large);
  padding: 8px;
  min-width: 160px;
}

@media (max-width: 768px) {
  .app-menu.file-upload-menu {
    min-width: 150px;
  }
}
</style>

<style scoped>
.menu-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 16px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-weight: 500;
}

.menu-item:hover,
.menu-item:focus {
  background-color: var(--harmony-primary-fill);
  color: var(--text-on-primary);
  outline: none;
}

.menu-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.hidden-file-input {
  display: none;
}

@media (max-width: 768px) {
  .menu-item {
    padding: 10px 12px;
    font-size: 13px;
  }
}
</style>
