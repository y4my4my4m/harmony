<template>
  <Teleport to="body">
    <div v-if="show" class="modal-overlay" @click="$emit('close')">
      <div class="modal-container" @click.stop>
        <div class="modal-header" :class="{ 'ban-header': mode === 'ban' }">
          <h2 class="modal-title">{{ mode === 'ban' ? 'Ban Member' : 'Kick Member' }}</h2>
          <button class="modal-close" @click="$emit('close')">
            <svg width="24" height="24" viewBox="0 0 24 24">
              <path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
            </svg>
          </button>
        </div>

        <div class="modal-body">
          <div v-if="needsMemberSelect && !selectedMember" class="form-group">
            <label for="member-search">Member</label>
            <div class="member-search-wrapper">
              <input
                id="member-search"
                ref="memberSearchInput"
                v-model="memberSearch"
                type="text"
                class="form-input"
                placeholder="Search for a member..."
                autocomplete="off"
                @focus="showDropdown = true"
              />
              <div v-if="showDropdown && filteredMembers.length > 0" class="member-list">
                <div
                  v-for="m in filteredMembers"
                  :key="m.id"
                  class="member-option"
                  @click="selectMember(m)"
                >
                  <Avatar :src="m.avatar_url" :alt="m.display_name || m.username" size="xs" />
                  <span>{{ m.display_name || m.username }}</span>
                  <span class="member-option-username">@{{ m.username }}</span>
                </div>
              </div>
              <div v-if="showDropdown && memberSearch && filteredMembers.length === 0" class="member-list member-list-empty">
                <span>No members found</span>
              </div>
            </div>
          </div>

          <div v-if="targetUser" class="user-preview">
            <Avatar
              :src="targetUser.avatar_url"
              :alt="targetDisplayName"
              size="sm"
            />
            <div class="user-info">
              <span class="user-display-name">{{ targetDisplayName }}</span>
              <span class="user-username">@{{ targetUser.username }}</span>
            </div>
            <button v-if="needsMemberSelect" class="clear-member-btn" @click="clearSelectedMember" title="Change member">
              <svg width="16" height="16" viewBox="0 0 24 24">
                <path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
              </svg>
            </button>
          </div>

          <div v-if="mode === 'ban' && targetUser" class="warning-banner">
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
            :disabled="isLoading || !targetUser"
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
import { ref, computed, watch, nextTick } from 'vue'
import { moderationService, DELETE_MESSAGE_OPTIONS, type DeleteMessageDuration } from '@/services/ModerationService'
import { userDataService } from '@/services/userDataService'
import { getUserIdsForServer, getProfiles } from '@/services/usersService'
import { useAuthStore } from '@/stores/auth'
import Avatar from '@/components/common/Avatar.vue'

interface MemberInfo {
  id: string
  username: string
  display_name?: string | null
  avatar_url?: string | null
}

const props = defineProps<{
  show: boolean
  mode: 'kick' | 'ban'
  user: MemberInfo
  serverId: string
}>()

const emit = defineEmits<{
  close: []
  done: [result: { success: boolean; messagesDeleted?: number }]
}>()

const authStore = useAuthStore()
const reason = ref('')
const deleteSeconds = ref<DeleteMessageDuration>(0)
const isLoading = ref(false)
const deleteOptions = DELETE_MESSAGE_OPTIONS

const memberSearch = ref('')
const memberSearchInput = ref<HTMLInputElement | null>(null)
const selectedMember = ref<MemberInfo | null>(null)
const serverMembers = ref<MemberInfo[]>([])
const showDropdown = ref(false)

const needsMemberSelect = computed(() => !props.user.id)

const targetUser = computed<MemberInfo | null>(() => {
  if (props.user.id) return props.user;
  return selectedMember.value;
})

const targetDisplayName = computed(() => targetUser.value?.display_name || targetUser.value?.username || '')

const currentUserId = computed(() => authStore.session?.user?.id || '')

const filteredMembers = computed(() => {
  const q = memberSearch.value.toLowerCase();
  const members = serverMembers.value.filter(m => m.id !== currentUserId.value);
  if (!q) return members.slice(0, 10);
  return members
    .filter(m => m.username?.toLowerCase().includes(q) || m.display_name?.toLowerCase().includes(q))
    .slice(0, 10);
})

function selectMember(m: MemberInfo) {
  selectedMember.value = m;
  showDropdown.value = false;
  memberSearch.value = '';
}

function clearSelectedMember() {
  selectedMember.value = null;
  memberSearch.value = '';
  nextTick(() => {
    showDropdown.value = true;
    memberSearchInput.value?.focus();
  });
}

watch(() => props.show, async (visible) => {
  if (visible && needsMemberSelect.value && serverMembers.value.length === 0) {
    const contextUsers = userDataService.getUsersInContext(props.serverId);
    if (contextUsers.length > 0) {
      serverMembers.value = contextUsers.map(u => ({
        id: u.id,
        username: u.username,
        display_name: u.displayName,
        avatar_url: u.avatarUrl
      }));
    } else {
      const userIds = await getUserIdsForServer(props.serverId);
      if (userIds.length > 0) {
        const profiles = await getProfiles(userIds);
        serverMembers.value = profiles.map(p => ({
          id: p.id,
          username: p.username,
          display_name: p.display_name,
          avatar_url: p.avatar_url
        }));
      }
    }
    nextTick(() => {
      showDropdown.value = true;
      memberSearchInput.value?.focus();
    });
  }
  if (!visible) {
    memberSearch.value = '';
    selectedMember.value = null;
    showDropdown.value = false;
    reason.value = '';
    deleteSeconds.value = 0;
  }
}, { immediate: true })

async function confirm() {
  if (!targetUser.value) return;
  isLoading.value = true
  try {
    const action = props.mode === 'ban' ? moderationService.banMember : moderationService.kickMember
    const result = await action(props.serverId, targetUser.value.id, reason.value || undefined, deleteSeconds.value)
    emit('done', result)
  } finally {
    isLoading.value = false
    reason.value = ''
    deleteSeconds.value = 0
    selectedMember.value = null
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
  border-color: var(--accent-color, #0EA5E9);
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
  background: var(--accent-color, #0EA5E9);
  color: var(--text-primary);
}
.btn-confirm:hover:not(:disabled) {
  background: var(--accent-hover, #0284C7);
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
  border-top-color: var(--text-primary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.form-input {
  background: var(--bg-tertiary, #1e1f22);
  border: 1px solid var(--border-color, #3f4147);
  border-radius: 4px;
  padding: 10px;
  color: var(--text-primary, #f2f3f5);
  font-size: 0.9rem;
  font-family: inherit;
  width: 100%;
  box-sizing: border-box;
}
.form-input:focus {
  outline: none;
  border-color: var(--accent-color, #0EA5E9);
}

.member-search-wrapper {
  position: relative;
}

.member-list {
  position: absolute;
  left: 0;
  right: 0;
  max-height: 180px;
  overflow-y: auto;
  margin-top: 4px;
  border-radius: 4px;
  background: var(--bg-tertiary, #1e1f22);
  border: 1px solid var(--border-color, #3f4147);
  z-index: 10;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.member-list-empty {
  padding: 12px;
  color: var(--text-muted, #949ba4);
  font-size: 0.85rem;
  text-align: center;
}

.member-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  font-size: 0.85rem;
  color: var(--text-primary, #f2f3f5);
}
.member-option:hover {
  background: rgba(255, 255, 255, 0.05);
}
.member-option.selected {
  background: rgba(14, 165, 233, 0.2);
}


.member-option-username {
  color: var(--text-muted, #949ba4);
  font-size: 0.78rem;
  margin-left: auto;
}

.clear-member-btn {
  background: none;
  border: none;
  color: var(--text-muted, #949ba4);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  margin-left: auto;
  flex-shrink: 0;
}
.clear-member-btn:hover {
  color: var(--text-primary, #f2f3f5);
  background: rgba(255, 255, 255, 0.08);
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
