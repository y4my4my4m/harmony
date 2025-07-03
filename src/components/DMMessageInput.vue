<template>
  <div class="dm-message-input">
    <!-- Reply indicator -->
    <div v-if="replyingTo" class="reply-preview">
      <div class="reply-content">
        <i class="icon-reply"></i>
        <span>Replying to message</span>
      </div>
      <button @click="clearReply" class="clear-reply">
        <i class="icon-close"></i>
      </button>
    </div>

    <!-- Input area -->
    <div class="input-container">
      <div class="input-wrapper">
        <textarea
          ref="messageInput"
          v-model="messageText"
          @keydown="handleKeyDown"
          @input="handleInput"
          placeholder="Type a message..."
          class="message-textarea"
          rows="1"
        ></textarea>
        
        <!-- Emoji picker button -->
        <button
          @click="toggleEmojiPicker"
          class="emoji-button"
          type="button"
        >
          😊
        </button>
        
        <!-- File upload button -->
        <button
          @click="triggerFileUpload"
          class="file-button"
          type="button"
        >
          📎
        </button>
        
        <!-- Send button -->
        <button
          @click="sendMessage"
          :disabled="!canSend"
          class="send-button"
          type="button"
        >
          <i class="icon-send"></i>
        </button>
      </div>
      
      <!-- Hidden file input -->
      <input
        ref="fileInput"
        type="file"
        multiple
        @change="handleFileSelect"
        class="hidden-file-input"
        accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt"
      />
    </div>

    <!-- File preview -->
    <div v-if="selectedFiles.length > 0" class="file-preview">
      <div
        v-for="(file, index) in selectedFiles"
        :key="index"
        class="file-preview-item"
      >
        <img
          v-if="file.type.startsWith('image/')"
          :src="getFilePreview(file)"
          :alt="file.name"
          class="file-preview-image"
        />
        <div v-else class="file-preview-generic">
          <div class="file-icon">📄</div>
          <div class="file-name">{{ file.name }}</div>
        </div>
        <button
          @click="removeFile(index)"
          class="remove-file"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- Emoji picker (placeholder) -->
    <div v-if="showEmojiPicker" class="emoji-picker">
      <div class="emoji-grid">
        <button
          v-for="emoji in commonEmojis"
          :key="emoji"
          @click="insertEmoji(emoji)"
          class="emoji-option"
        >
          {{ emoji }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, type Ref } from 'vue'
import type { MessagePart } from '@/types'

interface Props {
  otherUserId: string
  replyingTo?: string | null
}

interface Emits {
  (e: 'sendMessage', content: MessagePart[], replyTo?: string): void
  (e: 'clearReply'): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const messageText = ref('')
const selectedFiles: Ref<File[]> = ref([])
const showEmojiPicker = ref(false)
const messageInput: Ref<HTMLTextAreaElement | null> = ref(null)
const fileInput: Ref<HTMLInputElement | null> = ref(null)

const commonEmojis = ['😊', '😂', '❤️', '👍', '👎', '😭', '🔥', '💯', '😍', '🤔', '😎', '🎉', '👏', '🙏']

const canSend = computed(() => {
  return messageText.value.trim().length > 0 || selectedFiles.value.length > 0
})

const handleKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    sendMessage()
  }
}

const handleInput = () => {
  // Auto-resize textarea
  nextTick(() => {
    if (messageInput.value) {
      messageInput.value.style.height = 'auto'
      messageInput.value.style.height = messageInput.value.scrollHeight + 'px'
    }
  })
}

const sendMessage = async () => {
  if (!canSend.value) return

  const parts: MessagePart[] = []

  // Add text content
  if (messageText.value.trim()) {
    parts.push({
      type: 'text',
      text: messageText.value.trim()
    })
  }

  // Add file attachments
  for (const file of selectedFiles.value) {
    // In a real implementation, you would upload the file first
    // and get the URL back from your file storage service
    const mockUrl = URL.createObjectURL(file)
    
    parts.push({
      type: 'file',
      url: mockUrl,
      fileType: getFileType(file)
    })
  }

  // Emit the message
  emit('sendMessage', parts, props.replyingTo || undefined)

  // Clear input
  messageText.value = ''
  selectedFiles.value = []
  
  // Reset textarea height
  if (messageInput.value) {
    messageInput.value.style.height = 'auto'
  }
}

const clearReply = () => {
  emit('clearReply')
}

const toggleEmojiPicker = () => {
  showEmojiPicker.value = !showEmojiPicker.value
}

const insertEmoji = (emoji: string) => {
  messageText.value += emoji
  showEmojiPicker.value = false
  messageInput.value?.focus()
}

const triggerFileUpload = () => {
  fileInput.value?.click()
}

const handleFileSelect = (event: Event) => {
  const target = event.target as HTMLInputElement
  if (target.files) {
    selectedFiles.value = [...selectedFiles.value, ...Array.from(target.files)]
  }
  // Reset input
  target.value = ''
}

const removeFile = (index: number) => {
  selectedFiles.value.splice(index, 1)
}

const getFilePreview = (file: File) => {
  return URL.createObjectURL(file)
}

const getFileType = (file: File): 'image' | 'video' | 'audio' | 'document' => {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return 'document'
}
</script>

<style scoped>
.dm-message-input {
  border-top: 1px solid var(--border, #e1e5e9);
  background: var(--surface, white);
}

.reply-preview {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  background: var(--surface-secondary, #f8f9fa);
  border-bottom: 1px solid var(--border, #e1e5e9);
}

.reply-content {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: var(--text-secondary, #666);
}

.clear-reply {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.25rem;
  border-radius: 4px;
  color: var(--text-secondary, #666);
  transition: background-color 0.2s;
}

.clear-reply:hover {
  background: var(--surface-hover, #e9ecef);
}

.input-container {
  padding: 1rem;
}

.input-wrapper {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  background: var(--input-bg, #f8f9fa);
  border: 1px solid var(--border, #e1e5e9);
  border-radius: 24px;
  padding: 0.5rem;
  transition: border-color 0.2s;
}

.input-wrapper:focus-within {
  border-color: var(--accent-color, #007acc);
}

.message-textarea {
  flex: 1;
  border: none;
  background: none;
  resize: none;
  outline: none;
  padding: 0.5rem 0.75rem;
  font-family: inherit;
  font-size: 0.875rem;
  line-height: 1.4;
  max-height: 120px;
  overflow-y: auto;
}

.message-textarea::placeholder {
  color: var(--text-secondary, #666);
}

.emoji-button,
.file-button,
.send-button {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.5rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.2s;
  font-size: 1.25rem;
}

.emoji-button:hover,
.file-button:hover {
  background: var(--surface-hover, #e9ecef);
}

.send-button {
  background: var(--accent-color, #007acc);
  color: white;
}

.send-button:hover:not(:disabled) {
  background: var(--accent-hover, #005999);
}

.send-button:disabled {
  background: var(--border, #e1e5e9);
  color: var(--text-secondary, #666);
  cursor: not-allowed;
}

.hidden-file-input {
  display: none;
}

.file-preview {
  display: flex;
  gap: 0.5rem;
  padding: 0 1rem 0.5rem;
  flex-wrap: wrap;
}

.file-preview-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem;
  background: var(--surface-secondary, #f8f9fa);
  border: 1px solid var(--border, #e1e5e9);
  border-radius: 8px;
  max-width: 200px;
}

.file-preview-image {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: 4px;
}

.file-preview-generic {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.file-icon {
  font-size: 1.5rem;
}

.file-name {
  font-size: 0.75rem;
  color: var(--text-secondary, #666);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
}

.remove-file {
  position: absolute;
  top: -8px;
  right: -8px;
  background: var(--danger-color, #dc3545);
  color: white;
  border: none;
  border-radius: 50%;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 0.75rem;
  transition: background-color 0.2s;
}

.remove-file:hover {
  background: var(--danger-hover, #c82333);
}

.emoji-picker {
  position: absolute;
  bottom: 100%;
  right: 1rem;
  background: var(--surface, white);
  border: 1px solid var(--border, #e1e5e9);
  border-radius: 8px;
  padding: 1rem;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  z-index: 10;
}

.emoji-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 0.5rem;
}

.emoji-option {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.5rem;
  border-radius: 4px;
  font-size: 1.25rem;
  transition: background-color 0.2s;
}

.emoji-option:hover {
  background: var(--surface-hover, #e9ecef);
}

.message-textarea::-webkit-scrollbar {
  width: 4px;
}

.message-textarea::-webkit-scrollbar-track {
  background: transparent;
}

.message-textarea::-webkit-scrollbar-thumb {
  background: var(--border, #c1c1c1);
  border-radius: 2px;
}
</style>