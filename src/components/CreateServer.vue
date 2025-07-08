<template>
  <UnifiedModal
    v-model="isOpen"
    title="Create Your Server"
    subtitle="Build your own community"
    size="lg"
    :closable="true"
    @close="closeModal"
  >
    <template #icon>
      <svg viewBox="0 0 24 24">
        <path d="M12 2C13.1 2 14 2.9 14 4C14 5.1 13.1 6 12 6C10.9 6 10 5.1 10 4C10 2.9 10.9 2 12 2ZM21 9V7L15 1H5C3.89 1 3 1.89 3 3V19A2 2 0 0 0 5 21H11V19H5V3H13V9H21ZM17 13V11H15V13H13V15H15V17H17V15H19V13H17Z" fill="currentColor"/>
      </svg>
    </template>

    <!-- Content -->
    <div class="create-server-content">
      <!-- Server Icon Upload -->
      <div class="form-section">
        <label class="section-label">Server Icon</label>
        <div class="icon-upload-section">
          <div class="icon-preview" @click="triggerIconUpload">
            <img v-if="iconPreview" :src="iconPreview" alt="Server icon preview" />
            <div v-else class="default-icon">
              <svg viewBox="0 0 24 24" class="default-icon-svg">
                <path d="M12 2L2 7v10c0 5.55 3.84 9.74 9 11 5.16-1.26 9-5.45 9-11V7l-10-5z" fill="currentColor"/>
              </svg>
            </div>
            <div class="upload-overlay">
              <svg viewBox="0 0 24 24" class="upload-icon">
                <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z" fill="currentColor"/>
              </svg>
              <span>{{ iconPreview ? 'Change' : 'Upload' }}</span>
            </div>
          </div>
          <input 
            ref="iconInput" 
            type="file" 
            accept="image/*" 
            @change="handleIconUpload" 
            class="file-input"
          />
          <div class="icon-actions">
            <UnifiedButton size="sm" variant="secondary" @click="triggerIconUpload">
              Choose File
            </UnifiedButton>
            <UnifiedButton v-if="iconFile" size="sm" variant="ghost" @click="removeIcon">
              Remove
            </UnifiedButton>
          </div>
        </div>
      </div>

      <!-- Server Name -->
      <div class="form-section">
        <UnifiedInput
          v-model="serverName"
          label="Server Name"
          placeholder="My Awesome Server"
          :max-length="50"
          :error="serverNameError"
          required
          @input="validateServerName"
        />
      </div>

      <!-- Server Description -->
      <div class="form-section">
        <UnifiedInput
          v-model="description"
          type="textarea"
          label="Description"
          placeholder="Tell others what your server is about..."
          :max-length="200"
          :rows="3"
          hint="Optional"
        />
      </div>

      <!-- Privacy Settings -->
      <div class="form-section">
        <label class="section-label">Privacy</label>
        <div class="privacy-options">
          <div class="privacy-option" :class="{ active: !isPublic }" @click="isPublic = false">
            <div class="option-icon">
              <svg viewBox="0 0 24 24" class="privacy-icon">
                <path d="M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10A2,2 0 0,1 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z" fill="currentColor"/>
              </svg>
            </div>
            <div class="option-content">
              <h4 class="option-title">Private</h4>
              <p class="option-description">Only members with an invite can join</p>
            </div>
          </div>
          
          <div class="privacy-option" :class="{ active: isPublic }" @click="isPublic = true">
            <div class="option-icon">
              <svg viewBox="0 0 24 24" class="privacy-icon">
                <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M12,7A2,2 0 0,1 14,9A2,2 0 0,1 12,11A2,2 0 0,1 10,9A2,2 0 0,1 12,7M17,20H7V19C7,16.79 9.69,15 12,15C14.31,15 17,16.79 17,19V20Z" fill="currentColor"/>
              </svg>
            </div>
            <div class="option-content">
              <h4 class="option-title">Public</h4>
              <p class="option-description">Anyone can discover and join</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Preview Card -->
      <div class="form-section">
        <label class="section-label">Preview</label>
        <div class="server-preview">
          <div class="preview-icon">
            <img v-if="iconPreview" :src="iconPreview" alt="Preview" />
            <div v-else class="default-preview-icon">
              <svg viewBox="0 0 24 24">
                <path d="M12 2L2 7v10c0 5.55 3.84 9.74 9 11 5.16-1.26 9-5.45 9-11V7l-10-5z" fill="currentColor"/>
              </svg>
            </div>
          </div>
          <div class="preview-info">
            <h4 class="preview-name">{{ serverName.trim() || 'Server Name' }}</h4>
            <p class="preview-description">{{ description.trim() || 'No description provided' }}</p>
            <div class="preview-tags">
              <span class="tag">{{ isPublic ? 'Public' : 'Private' }}</span>
              <span class="tag">New</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Error Message -->
      <div v-if="errorMessage" class="error-banner">
        <svg viewBox="0 0 24 24" class="error-icon">
          <path d="M12,2L13.09,8.26L22,9L13.09,9.74L12,16L10.91,9.74L2,9L10.91,8.26L12,2Z" fill="currentColor"/>
        </svg>
        <span>{{ errorMessage }}</span>
      </div>
    </div>

    <template #actions>
      <UnifiedButton variant="secondary" @click="closeModal">
        Cancel
      </UnifiedButton>
      <UnifiedButton 
        variant="success" 
        @click="createServer"
        :disabled="!canCreate || isCreating"
        :loading="isCreating"
        loading-text="Creating..."
      >
        Create Server
      </UnifiedButton>
    </template>
  </UnifiedModal>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useAuthStore } from '@/stores/auth';
import { useRouter } from 'vue-router';
import { useToast } from 'vue-toastification';
import UnifiedModal from './shared/UnifiedModal.vue';
import UnifiedButton from './shared/UnifiedButton.vue';
import UnifiedInput from './shared/UnifiedInput.vue';

const emit = defineEmits<{
  close: []
}>();

const isOpen = ref(true);
const serverName = ref('');
const description = ref('');
const isPublic = ref(false);
const iconFile = ref<File | null>(null);
const iconPreview = ref<string | null>(null);
const serverNameError = ref('');
const errorMessage = ref('');
const isCreating = ref(false);

const serverChannelStore = useServerChannelStore();
const authStore = useAuthStore();
const router = useRouter();
const toast = useToast();

const iconInput = ref<HTMLInputElement>();

const canCreate = computed(() => {
  return serverName.value.trim().length > 0 && !serverNameError.value;
});

const validateServerName = () => {
  if (serverName.value.trim().length === 0) {
    serverNameError.value = 'Server name is required';
  } else if (serverName.value.trim().length < 2) {
    serverNameError.value = 'Server name must be at least 2 characters';
  } else if (serverName.value.trim().length > 50) {
    serverNameError.value = 'Server name is too long';
  } else {
    serverNameError.value = '';
  }
};

const triggerIconUpload = () => {
  iconInput.value?.click();
};

const handleIconUpload = (event: Event) => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  
  if (file) {
    if (file.size > 5 * 1024 * 1024) { // 5MB limit
      toast.error('Icon file size must be less than 5MB');
      return;
    }
    
    iconFile.value = file;
    const reader = new FileReader();
    reader.onload = (e) => {
      iconPreview.value = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  }
};

const removeIcon = () => {
  iconFile.value = null;
  iconPreview.value = null;
  if (iconInput.value) {
    iconInput.value.value = '';
  }
};

const closeModal = () => {
  isOpen.value = false;
  emit('close');
};

const createServer = async () => {
  if (!canCreate.value) return;

  validateServerName();
  if (serverNameError.value) return;

  const userId = authStore.session?.user?.id;
  if (!userId) {
    errorMessage.value = "Authentication required";
    return;
  }

  isCreating.value = true;
  errorMessage.value = '';

  try {
    const serverData = {
      name: serverName.value.trim(),
      description: description.value.trim() || undefined,
      public: isPublic.value,
      owner: userId
    };

    console.log('Creating server with data:', serverData);
    const result = await serverChannelStore.createServer(serverData);
    console.log('Server creation result:', result);
    
    // Handle icon upload if file exists
    if (iconFile.value && result) {
      console.log('Uploading server icon...');
      try {
        const { uploadServerIcon } = await import('@/utils/fileUpload');
        const uploadResult = await uploadServerIcon(iconFile.value, result.id);
        
        if (uploadResult.success && uploadResult.url) {
          // Update server with icon URL
          await serverChannelStore.updateServer({
            id: result.id,
            icon: uploadResult.url
          });
          console.log('Server icon uploaded successfully:', uploadResult.url);
        } else {
          console.error('Server icon upload failed:', uploadResult.error);
          toast.warning('Server created but icon upload failed. You can update it later in server settings.');
        }
      } catch (uploadError) {
        console.error('Server icon upload error:', uploadError);
        toast.warning('Server created but icon upload failed. You can update it later in server settings.');
      }
    }

    toast.success('Server created successfully!');
    closeModal();
    // Refresh the page to show the new server
    router.go(0);
  } catch (error: any) {
    console.error('Server creation error:', error);
    errorMessage.value = error.message || "An unexpected error occurred";
  } finally {
    isCreating.value = false;
  }
};
</script>

<style scoped>
.create-server-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.form-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.section-label {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.icon-upload-section {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.icon-preview {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  border: 2px solid var(--border-secondary);
  overflow: hidden;
  cursor: pointer;
  position: relative;
  background: var(--bg-secondary);
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.icon-preview:hover {
  border-color: var(--harmony-success);
  transform: scale(1.05);
}

.icon-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.default-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--text-tertiary);
}

.default-icon-svg {
  width: 32px;
  height: 32px;
}

.upload-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.2s ease;
  color: #ffffff;
  font-size: 10px;
  font-weight: 500;
  gap: 4px;
}

.icon-preview:hover .upload-overlay {
  opacity: 1;
}

.upload-icon {
  width: 16px;
  height: 16px;
}

.file-input {
  display: none;
}

.icon-actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.privacy-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-4);
}

.privacy-option {
  padding: var(--space-4);
  background: var(--bg-secondary);
  border: 1px solid var(--border-secondary);
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.privacy-option:hover {
  background: var(--bg-tertiary);
  border-color: var(--border-primary);
}

.privacy-option.active {
  background: rgba(34, 197, 94, 0.1);
  border-color: var(--harmony-success);
}

.option-icon {
  width: 32px;
  height: 32px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.privacy-option.active .option-icon {
  background: rgba(34, 197, 94, 0.2);
}

.privacy-icon {
  width: 16px;
  height: 16px;
  color: var(--text-secondary);
}

.privacy-option.active .privacy-icon {
  color: var(--harmony-success);
}

.option-content {
  flex: 1;
}

.option-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 var(--space-1);
}

.option-description {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  margin: 0;
}

.server-preview {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4);
  background: var(--bg-secondary);
  border: 1px solid var(--border-secondary);
  border-radius: var(--radius-lg);
}

.preview-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--bg-tertiary);
  flex-shrink: 0;
}

.preview-icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.default-preview-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--text-tertiary);
}

.default-preview-icon svg {
  width: 24px;
  height: 24px;
}

.preview-info {
  flex: 1;
}

.preview-name {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 var(--space-1);
}

.preview-description {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  margin: 0 0 var(--space-2);
}

.preview-tags {
  display: flex;
  gap: var(--space-1);
}

.tag {
  font-size: 10px;
  padding: 2px 6px;
  background: rgba(34, 197, 94, 0.2);
  color: var(--harmony-success);
  border-radius: var(--radius-sm);
  font-weight: 500;
}

.error-banner {
  padding: var(--space-3) var(--space-4);
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: var(--radius-md);
  color: var(--harmony-danger);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
}

.error-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

@media (max-width: 768px) {
  .privacy-options {
    grid-template-columns: 1fr;
  }
  
  .icon-upload-section {
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  
  .icon-actions {
    flex-direction: row;
    justify-content: center;
  }
}
</style>