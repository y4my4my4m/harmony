<template>
  <div v-if="isVisible" class="file-upload-menu" @click.stop>
    <div class="menu-item" @click="handleFileUpload">
      <svg class="menu-icon" width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <polyline points="10,9 9,9 8,9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>{{ t('files.uploadFile') }}</span>
    </div>
    <input 
      ref="fileInput"
      type="file" 
      multiple 
      accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.zip,.rar"
      @change="onFileSelect"
      class="hidden-file-input"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';

export default defineComponent({
  name: 'FileUploadMenu',
  props: {
    isVisible: {
      type: Boolean,
      default: false
    }
  },
  emits: ['files-selected', 'close'],
  setup(props, { emit }) {
    const { t } = useI18n();
    const fileInput = ref<HTMLInputElement | null>(null);

    const handleFileUpload = () => {
      fileInput.value?.click();
    };

    const onFileSelect = (event: Event) => {
      const target = event.target as HTMLInputElement;
      const files = target.files;
      
      if (files && files.length > 0) {
        const fileArray = Array.from(files);
        emit('files-selected', fileArray);
        
        if (target) {
          target.value = '';
        }
      }
    };

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const menu = target.closest('.file-upload-menu');
      
      if (!menu && props.isVisible) {
        emit('close');
      }
    };

    onMounted(() => {
      document.addEventListener('click', handleClickOutside);
    });

    onUnmounted(() => {
      document.removeEventListener('click', handleClickOutside);
    });

    return {
      fileInput,
      handleFileUpload,
      onFileSelect,
      t
    };
  }
});
</script>

<style scoped>
.file-upload-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  backdrop-filter: blur(8px);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  padding: 8px;
  z-index: 1000;
  min-width: 160px;
  margin-bottom: 8px;
  pointer-events: auto; /* Add pointer events to ensure it's clickable */
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.2s;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
}

.menu-item:hover {
  background-color: var(--harmony-primary);
  color: var(--text-primary);
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
  .file-upload-menu {
    min-width: 150px;
  }
  
  .menu-item {
    padding: 10px 12px;
    font-size: 13px;
  }
}
</style>