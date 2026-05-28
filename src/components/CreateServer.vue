<template>
  <div class="create-server-overlay" @click.self="closeModal">
    <div class="create-server-modal">
      <!-- Header -->
      <div class="modal-header">
        <div class="header-content">
          <div class="icon-container">
            <svg viewBox="0 0 24 24" class="server-icon">
              <path d="M12 2C13.1 2 14 2.9 14 4C14 5.1 13.1 6 12 6C10.9 6 10 5.1 10 4C10 2.9 10.9 2 12 2ZM21 9V7L15 1H5C3.89 1 3 1.89 3 3V19A2 2 0 0 0 5 21H11V19H5V3H13V9H21ZM17 13V11H15V13H13V15H15V17H17V15H19V13H17Z" fill="currentColor"/>
            </svg>
          </div>
          <div class="header-text">
            <h2 class="modal-title">{{ $t('server.createYourServer') }}</h2>
            <p class="modal-subtitle">{{ $t('server.buildCommunity') }}</p>
          </div>
        </div>
        <button @click="closeModal" class="close-button">
          <svg viewBox="0 0 24 24" class="close-icon">
            <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
          </svg>
        </button>
      </div>

      <!-- Content -->
      <div class="modal-content">
        <!-- Server Icon Upload -->
        <div class="section">
          <label class="section-label">{{ $t('server.serverIcon') }}</label>
          <div class="icon-upload-section">
            <div class="icon-preview" @click="triggerIconUpload">
              <img v-if="iconPreview" :src="iconPreview" :alt="$t('server.serverIcon')" />
              <div v-else class="default-icon">
                <svg viewBox="0 0 24 24" class="default-icon-svg">
                  <path d="M12 2L2 7v10c0 5.55 3.84 9.74 9 11 5.16-1.26 9-5.45 9-11V7l-10-5z" fill="currentColor"/>
                </svg>
              </div>
              <div class="upload-overlay">
                <svg viewBox="0 0 24 24" class="upload-icon">
                  <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z" fill="currentColor"/>
                </svg>
                <span>{{ iconPreview ? $t('common.edit') : $t('common.upload') }}</span>
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
              <button type="button" class="icon-btn" @click="triggerIconUpload">
                {{ $t('files.browse') }}
              </button>
              <button v-if="iconFile" type="button" class="icon-btn secondary" @click="removeIcon">
                {{ $t('common.remove') }}
              </button>
            </div>
          </div>
        </div>

        <!-- Server Name -->
        <div class="section">
          <label class="section-label">{{ $t('server.serverName') }} *</label>
          <div class="input-container">
            <input
              v-model="serverName"
              type="text"
              class="modern-input"
              data-testid="create-server-name-input"
              :placeholder="$t('server.placeholders.serverName')"
              maxlength="28"
              @input="validateServerName"
            />
            <div class="input-accent"></div>
          </div>
          <div class="input-feedback">
            <span class="char-count">{{ serverName.length }}/28</span>
            <span v-if="serverNameError" class="error-text">{{ serverNameError }}</span>
          </div>
        </div>

        <!-- Server Description -->
        <div class="section">
          <label class="section-label">{{ $t('server.description') }} <span class="optional">({{ $t('common.optional') }})</span></label>
          <div class="input-container">
            <textarea
              v-model="description"
              class="modern-textarea"
              :placeholder="$t('server.placeholders.description')"
              maxlength="200"
              rows="3"
            ></textarea>
            <div class="input-accent"></div>
          </div>
          <div class="input-feedback">
            <span class="char-count">{{ description.length }}/200</span>
          </div>
        </div>

        <!-- Privacy Settings -->
        <div class="section">
          <label class="section-label">{{ $t('server.privacySettings') }}</label>
          <div class="privacy-options">
            <div class="privacy-option" :class="{ active: !isPublic }" @click="isPublic = false">
              <div class="option-icon">
                <svg viewBox="0 0 24 24" class="privacy-icon">
                  <path d="M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10A2,2 0 0,1 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z" fill="currentColor"/>
                </svg>
              </div>
              <div class="option-content">
                <h4 class="option-title">{{ $t('server.private') }}</h4>
                <p class="option-description">{{ $t('server.privateDesc') }}</p>
              </div>
            </div>
            
            <div class="privacy-option" :class="{ active: isPublic }" @click="isPublic = true">
              <div class="option-icon">
                <svg viewBox="0 0 24 24" class="privacy-icon">
                  <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M12,7A2,2 0 0,1 14,9A2,2 0 0,1 12,11A2,2 0 0,1 10,9A2,2 0 0,1 12,7M17,20H7V19C7,16.79 9.69,15 12,15C14.31,15 17,16.79 17,19V20Z" fill="currentColor"/>
                </svg>
              </div>
              <div class="option-content">
                <h4 class="option-title">{{ $t('server.public') }}</h4>
                <p class="option-description">{{ $t('server.publicDesc') }}</p>
              </div>
            </div>
          </div>
        </div>

        <!-- Preview Card -->
        <div class="section">
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
      </div>

      <!-- Actions -->
      <div class="modal-actions">
        <button @click="closeModal" class="action-btn secondary">
          Cancel
        </button>
        <button 
          @click="createServer" 
          class="action-btn primary"
          data-testid="create-server-btn"
          :disabled="!canCreate || isCreating"
        >
          <span v-if="!isCreating">{{ $t('server.createButton') }}</span>
          <span v-else class="loading">
            <svg class="loading-spinner" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="31.416" stroke-dashoffset="31.416">
                <animate attributeName="stroke-dasharray" dur="2s" values="0 31.416;15.708 15.708;0 31.416" repeatCount="indefinite"/>
                <animate attributeName="stroke-dashoffset" dur="2s" values="0;-15.708;-31.416" repeatCount="indefinite"/>
              </circle>
            </svg>
            Creating...
          </span>
        </button>
      </div>

      <!-- Error Message -->
      <div v-if="errorMessage" class="error-banner">
        <svg viewBox="0 0 24 24" class="error-icon">
          <path d="M12,2L13.09,8.26L22,9L13.09,9.74L12,16L10.91,9.74L2,9L10.91,8.26L12,2Z" fill="currentColor"/>
        </svg>
        <span>{{ errorMessage }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { debug } from '@/utils/debug'
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useAuthStore } from '@/stores/auth';
import { useRouter } from 'vue-router';
import { useToast } from 'vue-toastification';

const emit = defineEmits<{
  close: []
}>();

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
  } else if (serverName.value.trim().length > 28) {
    serverNameError.value = 'Server name must be 28 characters or fewer';
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

    debug.log('Creating server with data:', serverData);
    const result = await serverChannelStore.createServer(serverData);
    debug.log('Server creation result:', result);
    
    // Handle icon upload if file exists
    if (iconFile.value && result) {
      debug.log('Uploading server icon...');
      try {
        const { uploadServerIcon } = await import('@/utils/fileUpload');
        const uploadResult = await uploadServerIcon(iconFile.value, result.id);
        
        if (uploadResult.success && uploadResult.url) {
          // Update server with icon URL
          await serverChannelStore.updateServer({
            id: result.id,
            icon: uploadResult.url
          });
          debug.log('Server icon uploaded successfully:', uploadResult.url);
        } else {
          debug.error('Server icon upload failed:', uploadResult.error);
          toast.warning('Server created but icon upload failed. You can update it later in server settings.');
        }
      } catch (uploadError) {
        debug.error('Server icon upload error:', uploadError);
        toast.warning('Server created but icon upload failed. You can update it later in server settings.');
      }
    }

    toast.success('Server created successfully!');
    closeModal();

    if (result) {
      serverChannelStore.setCurrentServer(result.id);
      await serverChannelStore.fetchCategoriesAndChannels(result.id, undefined, true);

      const firstTextChannel = serverChannelStore.channels.find(ch => ch.type === 0);
      if (firstTextChannel) {
        serverChannelStore.setCurrentChannel(firstTextChannel.id);
        router.push({ name: 'ChatChannel', params: { serverId: result.id, channelId: firstTextChannel.id } });
      } else {
        router.push({ name: 'Chat' });
      }
    }
  } catch (error: any) {
    debug.error('Server creation error:', error);
    errorMessage.value = error.message || "An unexpected error occurred";
  } finally {
    isCreating.value = false;
  }
};
</script>

<style scoped>
.create-server-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: 1000;
  animation: fadeIn 0.3s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.create-server-modal {
  background: rgba(47, 49, 54, 0.98);
  backdrop-filter: blur(20px);
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 
    0 32px 64px rgba(0, 0, 0, 0.5),
    0 0 0 1px rgba(255, 255, 255, 0.05),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  width: 100%;
  max-width: 600px;
  max-height: 90vh;
  overflow: hidden;
  animation: slideUp 0.3s ease-out;
  position: relative;
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(20px) scale(0.95); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.create-server-modal::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(87, 242, 135, 0.5), transparent);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px 32px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.header-content {
  display: flex;
  align-items: center;
  gap: 16px;
}

.icon-container {
  width: 48px;
  height: 48px;
  background: linear-gradient(135deg, #57f287, #00d166);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.server-icon {
  width: 24px;
  height: 24px;
  color: var(--text-primary);
}

.header-text {
  flex: 1;
}

.modal-title {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 4px;
}

.modal-subtitle {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.close-button {
  width: 32px;
  height: 32px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.3s ease;
}

.close-button:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.2);
}

.close-icon {
  width: 16px;
  height: 16px;
  color: var(--text-secondary);
}

.modal-content {
  padding: 32px;
  max-height: 60vh;
  overflow-y: auto;
  width: 100%;
}

.section {
  margin-bottom: 32px;
  width: 100%;
}

.section:last-child {
  margin-bottom: 0;
}

.section-label {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 12px;
}

.optional {
  font-weight: 400;
  color: var(--text-secondary);
  font-size: 12px;
}

.icon-upload-section {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
}

.icon-preview {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, 0.1);
  overflow: hidden;
  cursor: pointer;
  position: relative;
  background: linear-gradient(135deg, var(--background-secondary), var(--background-tertiary));
  transition: all 0.3s ease;
  flex-shrink: 0;
}

.icon-preview:hover {
  border-color: rgba(87, 242, 135, 0.5);
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
  color: var(--text-secondary);
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
  transition: opacity 0.3s ease;
  color: var(--text-primary);
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
  gap: 8px;
}

.icon-btn {
  padding: 8px 16px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: all 0.3s ease;
}

.icon-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.2);
}

.icon-btn.secondary {
  color: #ed4245;
  border-color: rgba(237, 66, 69, 0.3);
}

.icon-btn.secondary:hover {
  background: rgba(237, 66, 69, 0.1);
  border-color: rgba(237, 66, 69, 0.5);
}

.input-container {
  position: relative;
  width: 100%;
}

.modern-input,
.modern-textarea {
  width: 100%;
  padding: 16px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  color: var(--text-primary);
  font-size: 16px;
  transition: all 0.3s ease;
  box-sizing: border-box;
  resize: vertical;
  min-width: 0; /* Allow shrinking */
}

.modern-input:focus,
.modern-textarea:focus {
  outline: none;
  border-color: #57f287;
  background: rgba(255, 255, 255, 0.08);
  box-shadow: 0 0 0 3px rgba(87, 242, 135, 0.1);
}

.modern-input::placeholder,
.modern-textarea::placeholder {
  color: var(--text-muted);
}

.input-accent {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 2px;
  background: linear-gradient(90deg, #57f287, #00d166);
  border-radius: 1px;
  width: 0;
  transition: width 0.3s ease;
}

.modern-input:focus + .input-accent,
.modern-textarea:focus + .input-accent {
  width: 100%;
}

.input-feedback {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
  min-height: 20px;
}

.char-count {
  font-size: 12px;
  color: var(--text-muted);
}

.error-text {
  font-size: 12px;
  color: #ed4245;
  font-weight: 500;
}

.privacy-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  width: 100%;
}

.privacy-option {
  padding: 16px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0; /* Allow shrinking */
}

.privacy-option:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.2);
}

.privacy-option.active {
  background: rgba(87, 242, 135, 0.1);
  border-color: #57f287;
}

.option-icon {
  width: 32px;
  height: 32px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.privacy-option.active .option-icon {
  background: rgba(87, 242, 135, 0.2);
}

.privacy-icon {
  width: 16px;
  height: 16px;
  color: var(--text-secondary);
}

.privacy-option.active .privacy-icon {
  color: #57f287;
}

.option-content {
  flex: 1;
}

.option-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 4px;
}

.option-description {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
}

.server-preview {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  width: 100%;
  box-sizing: border-box;
}

.preview-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--background-secondary);
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
  color: var(--text-secondary);
}

.default-preview-icon svg {
  width: 24px;
  height: 24px;
}

.preview-info {
  flex: 1;
}

.preview-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 4px;
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

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 24px 32px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.action-btn {
  padding: 12px 24px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-btn.secondary {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-secondary);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.action-btn.secondary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}

.action-btn.primary {
  background: linear-gradient(135deg, #57f287, #00d166);
  color: var(--text-primary);
  box-shadow: 0 4px 15px rgba(87, 242, 135, 0.3);
}

.action-btn.primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(87, 242, 135, 0.4);
}

.loading {
  display: flex;
  align-items: center;
  gap: 8px;
}

.spinner {
  width: 16px;
  height: 16px;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.error-banner {
  margin: 0 32px 24px;
  padding: 12px 16px;
  background: rgba(237, 66, 69, 0.1);
  border: 1px solid rgba(237, 66, 69, 0.3);
  border-radius: 8px;
  color: #ed4245;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.error-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

@media (max-width: 768px) {
  .create-server-modal {
    margin: 16px;
    max-width: none;
  }
  
  .modal-header,
  .modal-content,
  .modal-actions {
    padding: 16px 20px;
  }
  
  .privacy-options {
    grid-template-columns: 1fr;
    gap: 12px;
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