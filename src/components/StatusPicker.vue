<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="isVisible" class="status-modal-overlay" @click.self="close">
        <div class="status-modal">
          <!-- Header -->
          <div class="modal-header">
            <h2>{{ hasCurrentStatus ? 'Edit Custom Status' : 'Set Custom Status' }}</h2>
            <button class="close-btn" @click="close">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.3 5.71a1 1 0 00-1.42 0L12 10.59 7.11 5.7A1 1 0 105.7 7.11L10.59 12 5.7 16.89a1 1 0 101.41 1.41L12 13.41l4.89 4.89a1 1 0 001.41-1.41L13.41 12l4.89-4.89a1 1 0 000-1.4z"/>
              </svg>
            </button>
          </div>

          <!-- Current Status Preview -->
          <div class="status-preview" v-if="hasCurrentStatus">
            <div class="preview-label">Current Status</div>
            <div class="preview-content">
              <img 
                v-if="currentStatus?.emoji_url" 
                :src="getEmojiUrl(currentStatus.emoji_url, 32)" 
                :alt="currentStatus.emoji || 'Emoji'"
                class="preview-emoji-img"
              />
              <span v-else-if="currentStatus?.emoji" class="preview-emoji">{{ currentStatus.emoji }}</span>
              <span class="preview-text">{{ currentStatusDisplayText }}</span>
            </div>
            <button class="clear-btn" @click="clearStatus">Clear Status</button>
          </div>

          <!-- Form -->
          <form @submit.prevent="saveStatus" class="status-form">
            <!-- Emoji & Text Row -->
            <div class="input-row emoji-row">
              <button 
                ref="emojiButtonRef"
                type="button" 
                class="emoji-btn"
                @click.stop="toggleEmojiPicker"
              >
                <img 
                  v-if="selectedEmoji?.url" 
                  :src="selectedEmoji.url" 
                  :alt="selectedEmoji.name || 'Emoji'"
                  class="selected-emoji-img"
                />
                <span v-else-if="selectedEmoji?.native" class="selected-emoji">
                  {{ selectedEmoji.native }}
                </span>
                <svg v-else width="24" height="24" viewBox="0 0 24 24" fill="currentColor" class="emoji-placeholder">
                  <path d="M12 2a10 10 0 1010 10A10 10 0 0012 2zm0 18a8 8 0 118-8 8 8 0 01-8 8zm2.44-9a1.5 1.5 0 101.5-1.5 1.5 1.5 0 00-1.5 1.5zM8.5 11a1.5 1.5 0 101.5-1.5A1.5 1.5 0 008.5 11zm7.56 3.15a.76.76 0 00-1.06-.21 4.85 4.85 0 01-6 0 .76.76 0 10-.85 1.26 6.33 6.33 0 007.7 0 .76.76 0 00.21-1.05z"/>
                </svg>
              </button>
              
              <input
                v-model="statusText"
                type="text"
                class="status-input"
                placeholder="What's happening?"
                maxlength="128"
              />
              
              <span class="char-count">{{ statusText.length }}/128</span>
            </div>

            <!-- Emoji Popup -->
            <EmojiPopup
              v-if="showEmojiPicker"
              @click.stop
              @sendEmoji="selectEmoji"
              :closeEmojiList="closeEmojiPicker"
              :emojiIconClicked="true"
              :position="'below'"
              :triggerElement="((emojiButtonRef as any) as HTMLElement | null) || undefined"
              @resetEmojiIconClicked="() => {}"
            />

            <!-- Activity: Custom = plain text/emoji only; others add a prefix (e.g. "Playing: ...") -->
            <div class="input-row activity-row">
              <label class="input-label">ACTIVITY</label>
              <div class="activity-selector">
                <button
                  v-for="activity in activityTypes"
                  :key="activity.value"
                  type="button"
                  class="activity-btn"
                  :class="{ active: selectedActivity === activity.value }"
                  :title="activity.value === 'custom' ? 'Plain text or emoji only (no prefix)' : undefined"
                  @click="selectedActivity = activity.value"
                >
                  <component :is="activity.icon" class="activity-icon" />
                  <span>{{ activity.label }}</span>
                </button>
              </div>
            </div>

            <!-- Duration -->
            <div class="input-row">
              <label class="input-label">Clear after</label>
              <select v-model="selectedDuration" class="duration-select">
                <option value="never">Don't clear</option>
                <option value="30m">30 minutes</option>
                <option value="1h">1 hour</option>
                <option value="4h">4 hours</option>
                <option value="today">Today</option>
                <option value="1w">This week</option>
              </select>
            </div>

            <!-- Actions -->
            <div class="form-actions">
              <button type="button" class="btn btn-secondary" @click="close">
                Cancel
              </button>
              <button 
                type="submit" 
                class="btn btn-primary"
                :disabled="saving"
              >
                {{ saving ? 'Saving...' : 'Save' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, h } from 'vue'
import { userDataService } from '@/services/userDataService'
import { getEmojiUrl } from '@/utils/emojiUtils'
import { formatCustomStatusDisplay } from '@/utils/customStatusDisplay'
import EmojiPopup from '@/components/EmojiPopup.vue'
import type { CustomUserStatus, Emoji } from '@/types'

interface Props {
  isVisible: boolean
  currentStatus?: CustomUserStatus | undefined
}

const props = defineProps<Props>()
const emit = defineEmits<{
  close: []
  'status-updated': [status: CustomUserStatus | undefined]
}>()

// Activity Icons as simple render functions
const PlayingIcon = { render: () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor' }, [h('path', { d: 'M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4-3c-.83 0-1.5-.67-1.5-1.5S18.67 9 19.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z' })] ) }
const ListeningIcon = { render: () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor' }, [h('path', { d: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z' })] ) }
const WatchingIcon = { render: () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor' }, [h('path', { d: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z' })] ) }
const CompetingIcon = { render: () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor' }, [h('path', { d: 'M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V19H7v2h10v-2h-4v-3.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z' })] ) }
const StreamingIcon = { render: () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor' }, [h('path', { d: 'M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z' })] ) }
const CustomIcon = { render: () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor' }, [h('path', { d: 'M12 2a10 10 0 1010 10A10 10 0 0012 2zm0 18a8 8 0 118-8 8 8 0 01-8 8zm2.44-9a1.5 1.5 0 101.5-1.5 1.5 1.5 0 00-1.5 1.5zM8.5 11a1.5 1.5 0 101.5-1.5A1.5 1.5 0 008.5 11zm7.56 3.15a.76.76 0 00-1.06-.21 4.85 4.85 0 01-6 0 .76.76 0 10-.85 1.26 6.33 6.33 0 007.7 0 .76.76 0 00.21-1.05z' })] ) }

// Activity types
const activityTypes = [
  { value: 'custom', label: 'Custom', icon: CustomIcon },
  { value: 'playing', label: 'Playing', icon: PlayingIcon },
  { value: 'listening', label: 'Listening', icon: ListeningIcon },
  { value: 'watching', label: 'Watching', icon: WatchingIcon },
  { value: 'competing', label: 'Competing', icon: CompetingIcon },
  { value: 'streaming', label: 'Streaming', icon: StreamingIcon },
]

// State
const statusText = ref('')
const selectedEmoji = ref<{ native?: string; name?: string; url?: string } | null>(null)
const selectedActivity = ref('custom')
const selectedDuration = ref('4h')
const showEmojiPicker = ref(false)
const saving = ref(false)
const emojiButtonRef = ref<HTMLElement | null>(null)

// Computed
const hasCurrentStatus = computed(() => {
  return props.currentStatus?.text || props.currentStatus?.emoji
})
const currentStatusDisplayText = computed(() => formatCustomStatusDisplay(props.currentStatus))

// Methods
const selectEmoji = (emoji: Emoji) => {
  // EmojiPopup sends Emoji type with id, name, url
  // For custom emojis: url is present, id is the emoji UUID
  // For native emojis: url is empty, id is the unicode character
  if (emoji.url) {
    // Custom emoji - use URL, no native representation
    selectedEmoji.value = {
      native: undefined,
      name: emoji.name,
      url: emoji.url,
    }
  } else {
    // Native emoji - use unicode (id) as native
    selectedEmoji.value = {
      native: emoji.id, // id is the unicode for native emojis
      name: emoji.name,
      url: undefined,
    }
  }
  closeEmojiPicker()
}

const toggleEmojiPicker = () => {
  showEmojiPicker.value = !showEmojiPicker.value
}

const closeEmojiPicker = () => {
  showEmojiPicker.value = false
}

const calculateExpiresAt = (): string | undefined => {
  const now = new Date()
  switch (selectedDuration.value) {
    case '30m':
      return new Date(now.getTime() + 30 * 60 * 1000).toISOString()
    case '1h':
      return new Date(now.getTime() + 60 * 60 * 1000).toISOString()
    case '4h':
      return new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString()
    case 'today': {
      const endOfDay = new Date(now)
      endOfDay.setHours(23, 59, 59, 999)
      return endOfDay.toISOString()
    }
    case '1w':
      return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
    case 'never':
    default:
      return undefined
  }
}

/** Minutes for DB RPC (set_custom_status p_duration_minutes). undefined = don't clear. */
const getDurationMinutes = (): number | undefined => {
  const now = new Date()
  switch (selectedDuration.value) {
    case '30m': return 30
    case '1h': return 60
    case '4h': return 240
    case 'today': {
      const endOfDay = new Date(now)
      endOfDay.setHours(23, 59, 59, 999)
      return Math.max(1, Math.ceil((endOfDay.getTime() - now.getTime()) / 60000))
    }
    case '1w': return 7 * 24 * 60 // 10080
    case 'never':
    default:
      return undefined
  }
}

const saveStatus = async () => {
  const hasTextOrEmoji = !!(statusText.value.trim() || selectedEmoji.value)
  const hasActivity = selectedActivity.value !== 'custom'
  if (!hasTextOrEmoji && !hasActivity) {
    await clearStatus()
    return
  }

  saving.value = true
  try {
    const expiresAt = calculateExpiresAt()
    const status: CustomUserStatus = {
      text: statusText.value.trim() || '',
      ...(selectedEmoji.value?.native && { emoji: selectedEmoji.value.native }),
      ...(selectedEmoji.value?.url && { emoji_url: selectedEmoji.value.url }),
      type: selectedActivity.value as CustomUserStatus['type'],
      ...(expiresAt && { expiresAt }),
    }
    const durationMinutes = getDurationMinutes()
    await userDataService.setCustomStatus(status, durationMinutes)
    emit('status-updated', status)
    close()
  } catch (error) {
    console.error('Failed to save status:', error)
  } finally {
    saving.value = false
  }
}

const clearStatus = async () => {
  saving.value = true
  try {
    await userDataService.setCustomStatus(undefined)
    emit('status-updated', undefined)
    close()
  } catch (error) {
    console.error('Failed to clear status:', error)
  } finally {
    saving.value = false
  }
}

const close = () => {
  emit('close')
}

/** Map expiresAt back to duration selector value for edit mode */
function getDurationFromExpiresAt(expiresAt: string | undefined): string {
  if (!expiresAt) return 'never'
  const exp = new Date(expiresAt).getTime()
  const now = Date.now()
  const ms = exp - now
  const min = ms / (60 * 1000)
  if (min <= 35) return '30m'
  if (min <= 90) return '1h'
  if (min <= 4.5 * 60) return '4h'
  const endOfDay = new Date(now)
  endOfDay.setHours(23, 59, 59, 999)
  if (exp <= endOfDay.getTime() + 60000) return 'today'
  if (min <= 8 * 24 * 60) return '1w'
  return 'never'
}

watch(() => props.isVisible, (visible) => {
  if (visible) {
    statusText.value = props.currentStatus?.text || ''
    selectedEmoji.value = props.currentStatus?.emoji
      ? { native: props.currentStatus.emoji, url: (props.currentStatus as any).emoji_url || undefined }
      : (props.currentStatus as any)?.emoji_url
        ? { native: undefined, name: 'Emoji', url: (props.currentStatus as any).emoji_url }
        : null
    selectedActivity.value = props.currentStatus?.type || 'custom'
    selectedDuration.value = getDurationFromExpiresAt(props.currentStatus?.expiresAt)
    showEmojiPicker.value = false
  }
})
</script>

<style scoped>
.status-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}

.status-modal {
  background: var(--background-secondary);
  border-radius: 12px;
  width: 100%;
  max-width: 480px;
  max-height: 90vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 8px;
  border-radius: 4px;
  display: flex;
  transition: all 0.2s;
}

.close-btn:hover {
  background: var(--background-tertiary);
  color: var(--text-primary);
}

.status-preview {
  padding: 16px 24px;
  background: var(--background-tertiary);
  border-bottom: 1px solid var(--border-color);
}

.preview-label {
  font-size: 12px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  margin-bottom: 8px;
}

.preview-content {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-primary);
  font-size: 14px;
}

.preview-emoji {
  font-size: 20px;
}

.preview-emoji-img {
  width: 20px;
  height: 20px;
  object-fit: contain;
  flex-shrink: 0;
}

.clear-btn {
  margin-top: 12px;
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  padding: 8px 16px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}

.clear-btn:hover {
  background: var(--background-secondary);
  color: var(--text-primary);
  border-color: var(--text-muted);
}

.status-form {
  padding: 24px;
  flex: 1;
  overflow-y: auto;
}

.input-row {
  margin-bottom: 20px;
}

.emoji-row {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--background-tertiary);
  border-radius: 8px;
  padding: 8px 12px;
}

.emoji-btn {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  background: var(--background-secondary);
  border: 1px dashed var(--border-color);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s;
  flex-shrink: 0;
}

.emoji-btn:hover {
  border-style: solid;
  border-color: var(--harmony-primary);
}

.selected-emoji {
  font-size: 24px;
  line-height: 1;
}

.selected-emoji-img {
  width: 24px;
  height: 24px;
  object-fit: contain;
}

.emoji-placeholder {
  color: var(--text-muted);
}

.status-input {
  flex: 1;
  background: none;
  border: none;
  color: var(--text-primary);
  font-size: 15px;
  outline: none;
  min-width: 0;
}

.status-input::placeholder {
  color: var(--text-muted);
}

.char-count {
  font-size: 12px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.input-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  margin-bottom: 8px;
}

.activity-selector {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.activity-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px 8px;
  background: var(--background-tertiary);
  border: 2px solid transparent;
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.activity-btn:hover {
  background: var(--background-primary);
  color: var(--text-primary);
}

.activity-btn.active {
  border-color: var(--harmony-primary);
  background: var(--harmony-primary-alpha, rgba(14, 165, 233, 0.15));
  color: var(--harmony-primary);
}

.activity-icon {
  width: 20px;
  height: 20px;
}

.duration-select {
  width: 100%;
  padding: 12px;
  background: var(--background-tertiary);
  border: none;
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
  outline: none;
}

.duration-select:focus {
  box-shadow: 0 0 0 2px var(--harmony-primary);
}

.duration-select option {
  background: var(--background-secondary);
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 24px;
}

.btn {
  padding: 12px 24px;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
}

.btn-secondary {
  background: var(--background-tertiary);
  color: var(--text-primary);
}

.btn-secondary:hover {
  background: var(--background-primary);
}

.btn-primary {
  background: var(--harmony-primary);
  color: var(--text-primary);
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Modal transitions */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}

.modal-enter-active .status-modal,
.modal-leave-active .status-modal {
  transition: transform 0.2s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .status-modal,
.modal-leave-to .status-modal {
  transform: scale(0.95);
}

/* Mobile */
@media (max-width: 520px) {
  .status-modal {
    margin: 16px;
    max-height: calc(100vh - 32px);
  }
  
  .activity-selector {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>

