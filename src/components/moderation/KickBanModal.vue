<template>
  <Teleport to="body">
    <div v-if="show" class="modal-overlay" @click="$emit('close')">
      <div class="modal-container" @click.stop>
        <div class="modal-header" :class="{ 'ban-header': mode === 'ban' }">
          <h2 class="modal-title">{{ mode === 'ban' ? `Ban ${displayName}` : `Kick ${displayName}` }}</h2>
          <button class="modal-close" @click="$emit('close')">
            <svg width="24" height="24" viewBox="0 0 24 24">
              <path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
            </svg>
          </button>
        </div>

        <div class="modal-body">
          <div class="user-preview">
            <img
              :src="user.avatar_url || '/default_avatar.png'"
              :alt="displayName"
              class="user-avatar"
            />
            <div class="user-info">
              <span class="user-display-name">{{ displayName }}</span>
              <span class="user-username">@{{ user.username }}</span>
            </div>
          </div>

          <div v-if="mode === 'ban'" class="warning-banner">
            This user will be permanently banned from the server and will not be able to rejoin until unbanned.
          </div>

          <div class="form-group">
            <label for="mod-reason">Reason</label>
            <textarea
              id="mod-reason"
              v-model="reason"
              class="form-textarea"
              :placeholder="`Why are you ${mode === 'ban' ? 'banning' : 'kicking'} this user?`"
              maxlength="512"
              rows="2"
            />
          </div>

          <div class="form-group">
            <label for="delete-messages">Delete Message History</label>
            <select id="delete-messages" v-model="deleteSeconds" class="form-select">
              <option v-for="opt in deleteOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-cancel" @click="$emit('close')" :disabled="isLoading">Cancel</button>
          <button
            class="btn-confirm"
            :class="{ 'btn-ban': mode === 'ban' }"
            @click="confirm"
            :disabled="isLoading"
          >
            <span v-if="isLoading" class="loading-spinner"></span>
            <span v-else>{{ mode === 'ban' ? 'Ban' : 'Kick' }}</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { moderationService, DELETE_MESSAGE_OPTIONS, type DeleteMessageDuration } from '@/services/ModerationService'

const props = defineProps<{
  show: boolean
  mode: 'kick' | 'ban'
  user: { id: string; username: string; display_name?: string | null; avatar_url?: string | null }
  serverId: string
}>()

const emit = defineEmits<{
  close: []
  done: [result: { success: boolean; messagesDeleted?: number }]
}>()

const reason = ref('')
const deleteSeconds = ref<DeleteMessageDuration>(0)
const isLoading = ref(false)
const deleteOptions = DELETE_MESSAGE_OPTIONS

const displayName = computed(() => props.user.display_name || props.user.username)

async function confirm() {
  isLoading.value = true
  try {
    const action = props.mode === 'ban' ? moderationService.banMember : moderationService.kickMember
    const result = await action(props.serverId, props.user.id, reason.value || undefined, deleteSeconds.value)
    emit('done', result)
  } finally {
    isLoading.value = false
    reason.value = ''
    deleteSeconds.value = 0
  }
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 16px;
}

.modal-container {
  background: var(--bg-secondary, #2b2d31);
  border-radius: 8px;
  width: 100%;
  max-width: 440px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 16px 0;
}

.modal-title {
  font-size: 1.15rem;
  font-weight: 600;
  color: var(--text-primary, #f2f3f5);
  margin: 0;
}

.modal-close {
  background: none;
  border: none;
  color: var(--text-muted, #949ba4);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
}
.modal-close:hover {
  color: var(--text-primary, #f2f3f5);
}

.modal-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.user-preview {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bg-tertiary, #1e1f22);
  border-radius: 8px;
}

.user-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
}

.user-info {
  display: flex;
  flex-direction: column;
}

.user-display-name {
  font-weight: 600;
  color: var(--text-primary, #f2f3f5);
  font-size: 0.95rem;
}

.user-username {
  color: var(--text-muted, #949ba4);
  font-size: 0.8rem;
}

.warning-banner {
  padding: 10px 12px;
  background: rgba(237, 66, 69, 0.15);
  border-left: 3px solid #ed4245;
  border-radius: 4px;
  color: #f9a8aa;
  font-size: 0.85rem;
  line-height: 1.4;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group label {
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--text-secondary, #b5bac1);
}

.form-textarea,
.form-select {
  background: var(--bg-tertiary, #1e1f22);
  border: 1px solid var(--border-color, #3f4147);
  border-radius: 4px;
  padding: 10px;
  color: var(--text-primary, #f2f3f5);
  font-size: 0.9rem;
  resize: none;
  font-family: inherit;
}
.form-textarea:focus,
.form-select:focus {
  outline: none;
  border-color: var(--accent-color, #5865f2);
}

.form-select {
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23949ba4' d='M6 8.825a.5.5 0 0 1-.354-.146l-4-4a.5.5 0 0 1 .708-.708L6 7.617l3.646-3.646a.5.5 0 0 1 .708.708l-4 4A.5.5 0 0 1 6 8.825z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  padding-right: 30px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 16px 16px;
}

.btn-cancel,
.btn-confirm {
  padding: 8px 20px;
  border-radius: 4px;
  font-size: 0.875rem;
  font-weight: 500;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
}

.btn-cancel {
  background: transparent;
  color: var(--text-secondary, #b5bac1);
}
.btn-cancel:hover:not(:disabled) {
  text-decoration: underline;
}

.btn-confirm {
  background: var(--accent-color, #5865f2);
  color: #fff;
}
.btn-confirm:hover:not(:disabled) {
  background: var(--accent-hover, #4752c4);
}
.btn-confirm.btn-ban {
  background: #ed4245;
}
.btn-confirm.btn-ban:hover:not(:disabled) {
  background: #c03537;
}

.btn-confirm:disabled,
.btn-cancel:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 480px) {
  .modal-container {
    max-width: 100%;
  }
  .modal-footer {
    flex-direction: column-reverse;
  }
  .btn-cancel,
  .btn-confirm {
    width: 100%;
    justify-content: center;
  }
}
</style>
