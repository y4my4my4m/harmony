<template>
  <div class="server-emoji-management">
    <div class="settings-section">
      <h2 class="section-title">Emoji</h2>
      <p class="section-description">
        {{ permissions.canUpload ? 'Manage custom emojis for your server' : 'View server emojis' }}
      </p>
    </div>

    <div class="settings-card" v-if="permissions.canManageCrossServer">
      <div class="form-group">
        <div class="setting-row">
          <div class="setting-info">
            <label class="form-label">Allow Cross-Server Emojis</label>
            <div class="form-hint">
              Allow members to use emojis from other servers they're in
            </div>
          </div>
          <div class="setting-control">
            <label class="toggle-switch">
              <input
                type="checkbox"
                :checked="allowCrossServer"
                @change="handleCrossServerToggle"
                :disabled="loading"
              />
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-card" v-if="permissions.canUpload">
      <div class="form-group">
        <label class="form-label">Upload Emoji</label>
        <div 
          class="emoji-upload-area"
          :class="{ 'dragover': isDragOver }"
          @drop="handleDrop"
          @dragover.prevent="isDragOver = true"
          @dragleave="isDragOver = false"
          @click="triggerFileInput"
        >
          <svg class="upload-icon" width="48" height="48" viewBox="0 0 24 24">
            <path fill="currentColor" d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/>
          </svg>
          <h3 class="upload-text">Click to upload or drag and drop</h3>
          <p class="upload-hint">PNG, JPG, GIF up to 256KB</p>
          
          <input
            ref="emojiFileInput"
            type="file"
            accept="image/*"
            class="hidden-file-input"
            @change="handleEmojiUpload"
            :disabled="loading"
          />
        </div>
      </div>
    </div>

    <div class="settings-card">
      <div class="emoji-list-header">
        <h3 class="emoji-list-title">Server Emojis</h3>
        <div class="emoji-count">{{ emojis.length }} / 50</div>
      </div>
      
      <div v-if="emojis.length === 0" class="empty-state">
        <svg class="empty-icon" width="64" height="64" viewBox="0 0 24 24">
          <path fill="currentColor" d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M7,9.5C7,8.7 7.7,8 8.5,8C9.3,8 10,8.7 10,9.5C10,10.3 9.3,11 8.5,11C7.7,11 7,10.3 7,9.5M14,17.5H10C10,16.1 11.1,15 12.5,15C13.9,15 15,16.1 15,17.5H14M14,9.5C14,8.7 14.7,8 15.5,8C16.3,8 17,8.7 17,9.5C17,10.3 16.3,11 15.5,11C14.7,11 14,10.3 14,9.5Z"/>
        </svg>
        <h4 class="empty-text">No emojis yet</h4>
        <p class="empty-hint">
          {{ permissions.canUpload 
            ? 'Upload your first emoji to get started' 
            : 'This server has no custom emojis' 
          }}
        </p>
      </div>
      
      <div v-else class="emoji-grid">
        <div 
          v-for="emoji in emojis" 
          :key="emoji.id"
          class="emoji-item"
        >
          <div class="emoji-preview">
            <img :src="emoji.url" :alt="emoji.name" class="emoji-image" />
          </div>
          <div class="emoji-details">
            <div class="emoji-name">:{{ emoji.name }}:</div>
            <div class="emoji-meta">
              <span>{{ formatFileSize(emoji.file_size || 0) }}</span>
              <span>{{ formatDate(emoji.created_at) }}</span>
            </div>
          </div>
          <div class="emoji-actions">
            <button
              class="action-btn copy-btn"
              @click="copyEmojiName(emoji.name)"
              title="Copy emoji name"
            >
              <svg width="16" height="16" viewBox="0 0 24 24">
                <path fill="currentColor" d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z"/>
              </svg>
            </button>
            <button
              v-if="permissions.canDelete"
              class="action-btn delete-btn"
              @click="confirmDeleteEmoji(emoji)"
              :disabled="deletingEmoji === emoji.id"
              title="Delete emoji"
            >
              <svg width="16" height="16" viewBox="0 0 24 24">
                <path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Permission Notice for Read-Only Users -->
    <div v-if="!permissions.canUpload && !permissions.canDelete" class="permission-notice">
      <div class="notice-content">
        <svg class="notice-icon" width="20" height="20" viewBox="0 0 24 24">
          <path fill="#faa61a" d="M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z"/>
        </svg>
        <div class="notice-text">
          <h4>View Only Access</h4>
          <p>You can view server emojis but cannot upload or delete them. Only the server owner and users with emoji management permissions can modify emojis.</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useToast } from 'vue-toastification'
import { uploadEmoji, deleteEmoji } from '@/services/emojiService'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'
import type { Emoji } from '@/types'

interface EmojiPermissions {
  canUpload: boolean
  canDelete: boolean
  canManageCrossServer: boolean
}

interface Props {
  emojis: Emoji[]
  allowCrossServer: boolean
  serverId: string
  ownerId: string
  loading: boolean
  permissions: EmojiPermissions
}

interface Emits {
  (e: 'update:emojis', value: Emoji[]): void
  (e: 'update:allowCrossServer', value: boolean): void
  (e: 'emoji-uploaded', emoji: Emoji): void
  (e: 'emoji-deleted', emojiId: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const toast = useToast()
const emojiCache = useEmojiCacheStore()
const emojiFileInput = ref<HTMLInputElement>()
const uploadingEmoji = ref(false)
const deletingEmoji = ref<string | null>(null)
const isDragOver = ref(false)

const handleCrossServerToggle = (event: Event) => {
  if (!props.permissions.canManageCrossServer) return
  const target = event.target as HTMLInputElement
  emit('update:allowCrossServer', target.checked)
}

const triggerFileInput = () => {
  if (!props.permissions.canUpload) return
  emojiFileInput.value?.click()
}

const handleDrop = (event: DragEvent) => {
  if (!props.permissions.canUpload) return
  event.preventDefault()
  isDragOver.value = false
  const files = event.dataTransfer?.files
  if (files && files.length > 0) {
    handleEmojiFile(files[0])
  }
}

const handleEmojiUpload = (event: Event) => {
  if (!props.permissions.canUpload) return
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) {
    handleEmojiFile(file)
  }
  // Clear input
  if (input) {
    input.value = ''
  }
}

const handleEmojiFile = async (file: File) => {
  if (!props.permissions.canUpload) {
    toast.error('You do not have permission to upload emojis')
    return
  }

  // Validate file
  if (!file.type.startsWith('image/')) {
    toast.error('Please select an image file')
    return
  }

  if (file.size > 256 * 1024) {
    toast.error('File size must be less than 256KB')
    return
  }

  if (props.emojis.length >= 50) {
    toast.error('Maximum of 50 emojis allowed per server')
    return
  }

  try {
    uploadingEmoji.value = true
    console.log('🎭 Uploading emoji with cache integration...')
    
    const newEmoji = await uploadEmoji(props.serverId, props.ownerId, file)
    
    if (newEmoji) {
      emit('emoji-uploaded', newEmoji)
      toast.success(`Emoji :${newEmoji.name}: uploaded successfully!`)
    }
  } catch (error) {
    console.error('Error uploading emoji:', error)
    toast.error('Failed to upload emoji')
  } finally {
    uploadingEmoji.value = false
  }
}

const confirmDeleteEmoji = async (emoji: Emoji) => {
  if (!props.permissions.canDelete) {
    toast.error('You do not have permission to delete emojis')
    return
  }

  if (!confirm(`Are you sure you want to delete :${emoji.name}:?`)) {
    return
  }

  try {
    deletingEmoji.value = emoji.id
    console.log('🗑️ Deleting emoji with cache integration...')
    
    const success = await deleteEmoji(emoji.id, props.serverId)
    
    if (success) {
      emit('emoji-deleted', emoji.id)
      toast.success(`Emoji :${emoji.name}: deleted successfully!`)
    }
  } catch (error) {
    console.error('Error deleting emoji:', error)
    toast.error('Failed to delete emoji')
  } finally {
    deletingEmoji.value = null
  }
}

const copyEmojiName = (name: string) => {
  navigator.clipboard.writeText(`:${name}:`)
  toast.success('Emoji name copied to clipboard!')
}

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

const formatDate = (dateString: string): string => {
  return new Date(dateString).toLocaleDateString()
}

// Get cache statistics
const getCacheStats = () => {
  return emojiCache.getCacheStats
}

// Get emoji analytics for this server
const getEmojiAnalytics = () => {
  return emojiCache.getServerEmojis(props.serverId).length
}
</script>

<style scoped>
.server-emoji-management {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.settings-section {
  margin-bottom: 8px;
}

.section-title {
  font-size: 24px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 8px 0;
}

.section-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0;
}

.permission-notice {
  padding: 16px;
  background-color: rgba(250, 166, 26, 0.1);
  border: 1px solid rgba(250, 166, 26, 0.3);
  border-radius: 8px;
}

.notice-content {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.notice-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: #faa61a;
}

.notice-text h4 {
  margin: 0 0 4px 0;
  font-size: 14px;
  font-weight: 600;
  color: #faa61a;
}

.notice-text p {
  margin: 0;
  font-size: 13px;
  color: #b9bbbe;
  line-height: 1.4;
}

.settings-card {
  background-color: var(--h-chat);
  border-radius: 8px;
  padding: 24px;
  border: 1px solid var(--h-chat-light);
}

.form-group {
  margin-bottom: 20px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-label {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: #b9bbbe;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.form-hint {
  font-size: 12px;
  color: #72767d;
  margin-top: 4px;
}

.setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.setting-info {
  flex: 1;
}

.setting-control {
  flex-shrink: 0;
}

.toggle-switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: #72767d;
  transition: 0.3s;
  border-radius: 24px;
}

.toggle-slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background-color: white;
  transition: 0.3s;
  border-radius: 50%;
}

input:checked + .toggle-slider {
  background-color: #5865f2;
}

input:checked + .toggle-slider:before {
  transform: translateX(20px);
}

.emoji-upload-area {
  border: 2px dashed var(--h-chat-light);
  border-radius: 8px;
  padding: 32px;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s ease;
  background-color: var(--h-chat-darker);
}

.emoji-upload-area:hover,
.emoji-upload-area.dragover {
  border-color: #5865f2;
  background-color: rgba(88, 101, 242, 0.1);
}

.upload-icon {
  color: #72767d;
  margin-bottom: 12px;
}

.upload-text {
  font-size: 14px;
  color: #ffffff;
  margin: 0 0 4px 0;
}

.upload-hint {
  font-size: 12px;
  color: #72767d;
  margin: 0;
}

.hidden-file-input {
  display: none;
}

.emoji-list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.emoji-list-title {
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  margin: 0;
}

.emoji-count {
  font-size: 12px;
  color: #72767d;
  background-color: var(--h-chat-darker);
  padding: 4px 8px;
  border-radius: 12px;
}

.empty-state {
  text-align: center;
  padding: 40px 20px;
}

.empty-icon {
  color: #72767d;
  margin-bottom: 16px;
}

.empty-text {
  font-size: 16px;
  color: #b9bbbe;
  margin: 0 0 4px 0;
}

.empty-hint {
  font-size: 14px;
  color: #72767d;
  margin: 0;
}

.emoji-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.emoji-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background-color: var(--h-chat-darker);
  border-radius: 6px;
  border: 1px solid var(--h-chat-light);
}

.emoji-preview {
  flex-shrink: 0;
}

.emoji-image {
  width: 32px;
  height: 32px;
  object-fit: contain;
}

.emoji-details {
  flex: 1;
  min-width: 0;
}

.emoji-name {
  font-size: 14px;
  font-weight: 500;
  color: #ffffff;
  margin-bottom: 2px;
}

.emoji-meta {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: #72767d;
}

.emoji-actions {
  display: flex;
  gap: 4px;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: none;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
  color: #b9bbbe;
}

.action-btn:hover {
  background-color: var(--h-chat-light);
}

.copy-btn:hover {
  color: #57f287;
}

.delete-btn:hover {
  color: #ed4245;
}

.action-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@media (max-width: 768px) {
  .emoji-grid {
    grid-template-columns: 1fr;
  }
  
  .setting-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  
  .settings-card {
    padding: 16px;
  }
}
</style>