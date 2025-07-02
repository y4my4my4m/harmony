<template>
  <div class="server-emoji-management">
    <div class="settings-section">
      <h2 class="section-title">Emoji</h2>
      <p class="section-description">
        Manage custom emojis for your server
      </p>
    </div>

    <div class="settings-card">
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

    <div class="settings-card">
      <div class="form-group">
        <label class="form-label">Upload Emoji</label>
        <div class="emoji-upload-area">
          <div class="upload-dropzone" @click="triggerFileInput" @dragover.prevent @drop="handleDrop">
            <svg class="upload-icon" width="48" height="48" viewBox="0 0 24 24">
              <path fill="currentColor" d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/>
            </svg>
            <p class="upload-text">
              <strong>Click to upload</strong> or drag and drop
            </p>
            <p class="upload-hint">
              PNG, JPG, GIF up to 256KB • Recommended size: 128x128px
            </p>
          </div>
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
        <p class="empty-text">No custom emojis yet</p>
        <p class="empty-hint">Upload your first emoji to get started</p>
      </div>

      <div v-else class="emoji-grid">
        <div
          v-for="emoji in emojis"
          :key="emoji.id"
          class="emoji-item"
        >
          <div class="emoji-preview">
            <img
              :src="emoji.url"
              :alt="emoji.name"
              class="emoji-image"
              @error="handleImageError"
            />
          </div>
          <div class="emoji-details">
            <div class="emoji-name">:{{ emoji.name }}:</div>
            <div class="emoji-meta">
              <span class="emoji-uploader">{{ formatUploader(emoji.uploader) }}</span>
              <span class="emoji-date">{{ formatDate(emoji.created_at) }}</span>
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
              class="action-btn delete-btn"
              @click="deleteEmoji(emoji.id)"
              title="Delete emoji"
              :disabled="loading"
            >
              <svg width="16" height="16" viewBox="0 0 24 24">
                <path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useToast } from 'vue-toastification'
import { uploadEmoji } from '@/services/emojiService'
import type { Emoji } from '@/types'

interface Props {
  emojis: Emoji[]
  allowCrossServer: boolean
  serverId: string
  ownerId: string
  loading: boolean
}

interface Emits {
  (e: 'update:emojis', value: Emoji[]): void
  (e: 'update:allowCrossServer', value: boolean): void
  (e: 'emoji-uploaded', emoji: Emoji): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const toast = useToast()
const emojiFileInput = ref<HTMLInputElement>()
const uploadingEmoji = ref(false)

const handleCrossServerToggle = (event: Event) => {
  const target = event.target as HTMLInputElement
  emit('update:allowCrossServer', target.checked)
}

const triggerFileInput = () => {
  emojiFileInput.value?.click()
}

const handleDrop = (event: DragEvent) => {
  event.preventDefault()
  const files = event.dataTransfer?.files
  if (files && files.length > 0) {
    handleEmojiFile(files[0])
  }
}

const handleEmojiUpload = (event: Event) => {
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
    const newEmoji = await uploadEmoji(props.serverId, props.ownerId, file)
    
    if (newEmoji) {
      emit('emoji-uploaded', newEmoji)
    } else {
      toast.error('Failed to upload emoji')
    }
  } catch (error) {
    console.error('Error uploading emoji:', error)
    toast.error('Failed to upload emoji')
  } finally {
    uploadingEmoji.value = false
  }
}

const copyEmojiName = async (name: string) => {
  try {
    await navigator.clipboard.writeText(`:${name}:`)
    toast.success('Emoji name copied to clipboard')
  } catch (error) {
    console.error('Failed to copy emoji name:', error)
    toast.error('Failed to copy emoji name')
  }
}

const deleteEmoji = async (emojiId: string) => {
  if (!confirm('Are you sure you want to delete this emoji?')) {
    return
  }

  // TODO: Implement emoji deletion in the service
  console.log('Delete emoji:', emojiId)
  toast.info('Emoji deletion not yet implemented')
}

const handleImageError = (event: Event) => {
  const img = event.target as HTMLImageElement
  img.style.display = 'none'
}

const formatUploader = (_uploaderId: string) => {
  // TODO: Get actual username from user ID
  return 'Unknown User'
}

const formatDate = (date: Date) => {
  return new Date(date).toLocaleDateString()
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
  gap: 16px;
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
  margin-bottom: 8px;
}

.upload-dropzone {
  border: 2px dashed var(--h-chat-light);
  border-radius: 8px;
  padding: 32px;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s ease;
  background-color: var(--h-chat-darker);
}

.upload-dropzone:hover {
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