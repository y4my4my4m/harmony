<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="isVisible" class="threads-modal-overlay" @click.self="close">
        <div class="threads-modal">
          <!-- Header -->
          <div class="modal-header">
            <div class="header-left">
              <Icon name="thread" />
              <h2>Threads</h2>
            </div>
            <div class="header-actions">
              <button
                v-if="canCreate"
                type="button"
                class="new-thread-btn"
                :disabled="creating"
                @click="startCreating"
              >
                <Icon name="plus" :size="16" />
                <span>{{ $t('threadCreate.button') }}</span>
              </button>
              <div class="search-box">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M21.53 20.47l-3.66-3.66C19.195 15.24 20 13.214 20 11c0-4.97-4.03-9-9-9s-9 4.03-9 9 4.03 9 9 9c2.215 0 4.24-.804 5.808-2.13l3.66 3.66c.147.146.34.22.53.22s.385-.073.53-.22c.295-.293.295-.767.002-1.06zM3.5 11c0-4.135 3.365-7.5 7.5-7.5s7.5 3.365 7.5 7.5-3.365 7.5-7.5 7.5-7.5-3.365-7.5-7.5z"/>
                </svg>
                <input 
                  v-model="searchQuery"
                  type="text" 
                  placeholder="Search for thread name"
                />
              </div>
              <button class="close-btn" aria-label="Close" @click="close">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>

          <!-- Thread Lists -->
          <div class="modal-content">
            <form v-if="creating" class="new-thread-form" @submit.prevent="submitNewThread">
              <label class="new-thread-label" for="new-thread-name">{{ $t('threadCreate.nameLabel') }}</label>
              <div class="new-thread-row">
                <input
                  id="new-thread-name"
                  ref="nameInput"
                  v-model="newThreadName"
                  type="text"
                  maxlength="100"
                  autocomplete="off"
                  :placeholder="$t('threadCreate.placeholder')"
                  :disabled="submitting"
                  @keydown.esc.stop.prevent="cancelCreating"
                />
                <button type="button" class="new-thread-cancel" :disabled="submitting" @click="cancelCreating">
                  {{ $t('common.cancel') }}
                </button>
                <button type="submit" class="new-thread-submit" :disabled="submitting || !newThreadName.trim()">
                  {{ $t('threadCreate.submit') }}
                </button>
              </div>
              <p v-if="createError" class="new-thread-error" role="alert">{{ createError }}</p>
            </form>

            <!-- Joined Threads Section -->
            <div v-if="joinedThreads.length > 0" class="thread-section">
              <h3 class="section-title">{{ joinedThreads.length }} joined threads</h3>
              <div class="thread-list">
                <button
                  v-for="thread in joinedThreads"
                  :key="thread.id"
                  class="thread-item"
                  @click="selectThread(thread)"
                >
                  <div class="thread-info">
                    <div class="thread-name">{{ thread.name }}</div>
                    <div class="thread-meta">
                      <Avatar 
                        :src="getCreatorAvatar(thread.created_by)" 
                        size="mini" 
                        class="creator-avatar"
                      />
                      <span class="creator-name"><DisplayName :userId="thread.created_by" :fallback="getCreatorName(thread.created_by)" /></span>
                      <span class="separator">:</span>
                      <span class="last-message">{{ thread.last_message_preview || 'No messages yet' }}</span>
                      <span class="dot">•</span>
                      <span class="time">{{ formatRelativeTime(thread.last_message_at) }}</span>
                    </div>
                  </div>
                  <Avatar 
                    v-if="thread.created_by"
                    :src="getCreatorAvatar(thread.created_by)" 
                    size="sm"
                    class="thread-avatar"
                  />
                </button>
              </div>
            </div>

            <!-- Older Threads Section -->
            <div v-if="olderThreads.length > 0" class="thread-section">
              <h3 class="section-title">Older threads</h3>
              <div class="thread-list">
                <button
                  v-for="thread in olderThreads"
                  :key="thread.id"
                  class="thread-item"
                  @click="selectThread(thread)"
                >
                  <div class="thread-info">
                    <div class="thread-name">{{ thread.name }}</div>
                    <div class="thread-meta">
                      <span class="started-by">Started by</span>
                      <span class="creator-name"><DisplayName :userId="thread.created_by" :fallback="getCreatorName(thread.created_by)" /></span>
                      <span class="dot">•</span>
                      <span class="time">Last active {{ formatRelativeTime(thread.last_message_at) }}</span>
                    </div>
                  </div>
                  <Avatar 
                    v-if="thread.created_by"
                    :src="getCreatorAvatar(thread.created_by)" 
                    size="sm"
                    class="thread-avatar"
                  />
                </button>
              </div>
            </div>

            <!-- Empty State -->
            <EmptyState
              v-if="!loading && filteredThreads.length === 0"
              :icon="searchQuery ? 'search' : 'thread'"
              :title="searchQuery ? $t('empty.threads.noMatchTitle') : $t('empty.threads.title')"
              :description="searchQuery ? $t('empty.threads.noMatchDescription') : $t('empty.threads.description')"
              :action-label="!searchQuery && canCreate && !creating ? $t('threadCreate.button') : undefined"
              @action="startCreating"
            />

            <!-- Loading -->
            <div v-if="loading" class="loading-state">
              <LoadingSpinner :size="32" />
              <p>Loading threads...</p>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useThreadsStore, isOptimisticThreadId } from '@/stores/useThreads'
import { threadService } from '@/services/ThreadService'
import { useServerPermissions } from '@/composables/useServerPermissions'
import { useUserData } from '@/composables/useUserData'
import { formatDistanceToNow } from 'date-fns'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import type { ThreadWithDetails } from '@/services/ThreadService'
import Icon from '@/components/common/Icon.vue'
import EmptyState from '@/components/common/EmptyState.vue'

interface Props {
  isVisible: boolean
  channelId?: string
  serverId?: string
}

const props = defineProps<Props>()
const emit = defineEmits<{
  close: []
  'select-thread': [thread: ThreadWithDetails]
}>()

const { getUserDisplayName, getUserAvatarUrl } = useUserData()

const threadsStore = useThreadsStore()
// Indexed threads, optimistic ones included, render before the read returns.
const threads = computed<ThreadWithDetails[]>(() =>
  props.channelId ? threadsStore.channelThreads(props.channelId, { includeArchived: true }) : []
)
const fetching = ref(false)
const loading = computed(() => fetching.value && threads.value.length === 0)
const searchQuery = ref('')

const filteredThreads = computed(() => {
  if (!searchQuery.value) return threads.value
  const query = searchQuery.value.toLowerCase()
  return threads.value.filter(t => 
    t.name.toLowerCase().includes(query)
  )
})

// Split into joined and older threads
const joinedThreads = computed(() => 
  filteredThreads.value.filter(t => t.is_member)
)

const olderThreads = computed(() => 
  filteredThreads.value.filter(t => !t.is_member)
)

const loadThreads = async () => {
  if (!props.channelId) return

  fetching.value = true
  try {
    await threadsStore.loadChannelThreads(props.channelId, { includeArchived: true })
  } catch (error) {
    console.error('Failed to load threads:', error)
  } finally {
    fetching.value = false
  }
}

const getCreatorName = (userId?: string) => {
  if (!userId) return 'Unknown'
  return getUserDisplayName(userId).value
}

const getCreatorAvatar = (userId?: string) => {
  if (!userId) return '/default_avatar.webp'
  return getUserAvatarUrl(userId).value
}

const formatRelativeTime = (date?: Date | string | null) => {
  if (!date) return ''
  try {
    const d = typeof date === 'string' ? new Date(date) : date
    return formatDistanceToNow(d, { addSuffix: false }) + ' ago'
  } catch {
    return ''
  }
}

const { t } = useI18n()
const { canCreateThreads } = useServerPermissions()
const canCreate = computed(() => !!props.channelId && canCreateThreads.value)

const creating = ref(false)
const submitting = ref(false)
const newThreadName = ref('')
const createError = ref('')
const nameInput = ref<HTMLInputElement | null>(null)

const startCreating = () => {
  creating.value = true
  createError.value = ''
  void nextTick(() => nameInput.value?.focus())
}

const cancelCreating = () => {
  if (submitting.value) return
  creating.value = false
  newThreadName.value = ''
  createError.value = ''
}

const submitNewThread = async () => {
  const name = newThreadName.value.trim()
  if (!props.channelId || !name || submitting.value) return
  submitting.value = true
  createError.value = ''
  try {
    const id = await threadService.createChannelThread(props.channelId, name)
    const thread = await threadService.getThread(id, true)
    if (!thread) throw new Error('thread not readable after create')
    threadsStore.upsert(thread)
    creating.value = false
    newThreadName.value = ''
    emit('select-thread', thread)
    close()
  } catch (error) {
    console.error('Failed to create thread:', error)
    createError.value = t('threadCreate.failed')
  } finally {
    submitting.value = false
  }
}

// An optimistic thread has no server id to open yet.
const selectThread = (thread: ThreadWithDetails) => {
  if (isOptimisticThreadId(thread.id)) return
  emit('select-thread', thread)
  close()
}

const close = () => {
  emit('close')
}

watch(() => props.isVisible, (visible) => {
  if (visible) {
    loadThreads()
  } else {
    creating.value = false
    newThreadName.value = ''
    createError.value = ''
  }
})

const onKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && props.isVisible) close()
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  if (props.isVisible) {
    loadThreads()
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
.threads-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(4px);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.threads-modal {
  width: 100%;
  max-width: 540px;
  max-height: 80vh;
  background: var(--background-primary);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-large);
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
  gap: 12px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.thread-icon {
  color: var(--text-secondary);
}

.header-left h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.new-thread-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-radius: 4px;
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.new-thread-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.new-thread-form {
  margin-bottom: 16px;
  padding: 12px;
  border-radius: 6px;
  background: var(--background-tertiary);
}

.new-thread-label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-muted);
}

.new-thread-row {
  display: flex;
  gap: 8px;
}

.new-thread-row input {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--background-secondary);
  color: var(--text-primary);
}

.new-thread-cancel,
.new-thread-submit {
  padding: 8px 12px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}

.new-thread-cancel {
  background: transparent;
  color: var(--text-secondary);
}

.new-thread-submit {
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font-weight: 600;
}

.new-thread-submit:disabled,
.new-thread-cancel:disabled {
  opacity: 0.6;
  cursor: default;
}

.new-thread-error {
  margin: 8px 0 0;
  color: var(--error);
  font-size: 13px;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--background-tertiary);
  border-radius: 4px;
  padding: 6px 12px;
  flex: 1;
  min-width: 180px;
}

.search-box svg {
  color: var(--text-muted);
  flex-shrink: 0;
}

.search-box input {
  background: none;
  border: none;
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  width: 100%;
}

.search-box input::placeholder {
  color: var(--text-muted);
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px;
  display: flex;
  border-radius: 4px;
  transition: all 0.2s;
}

.close-btn:hover {
  background: var(--background-secondary);
  color: var(--text-primary);
}

.modal-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.thread-section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  margin: 0 0 8px 0;
}

.thread-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.thread-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 10px 12px;
  background: none;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
  color: var(--text-primary);
  transition: background 0.15s;
}

.thread-item:hover {
  background: var(--background-secondary);
}

.thread-info {
  flex: 1;
  min-width: 0;
}

.thread-name {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.thread-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-secondary);
}

.creator-avatar {
  flex-shrink: 0;
}

.creator-name {
  color: var(--harmony-primary);
  font-weight: 500;
}

.started-by {
  color: var(--text-muted);
}

.separator {
  color: var(--text-muted);
}

.last-message {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.dot {
  color: var(--text-muted);
}

.time {
  color: var(--text-muted);
  white-space: nowrap;
}

.thread-avatar {
  flex-shrink: 0;
  margin-left: 12px;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px;
  color: var(--text-secondary);
}

/* Modal transitions */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}

.modal-enter-active .threads-modal,
.modal-leave-active .threads-modal {
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .threads-modal,
.modal-leave-to .threads-modal {
  transform: scale(0.95);
  opacity: 0;
}
</style>

