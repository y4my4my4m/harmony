<template>
  <BaseModal 
    :show="show" 
    @close="$emit('close')"
    :title="modalTitle"
    :subtitle="modalSubtitle"
    icon="users"
    :compact="false"
  >
    <div class="group-chat-invite-content">
      <!-- User Search Section -->
      <div class="search-section">
        <div class="section-header">
          <h3 class="section-title">Add People</h3>
          <p class="section-description">
            Search for users to {{ isNewGroup ? 'create a group chat with' : 'add to this conversation' }}
          </p>
        </div>

        <div class="search-input-container">
          <input
            v-model="searchQuery"
            ref="searchInput"
            type="text"
            placeholder="Search users or @user@domain.com"
            class="search-input"
            @input="handleSearch"
            @keydown.escape="clearSearch"
            @keydown.enter.prevent="selectFirstResult"
          />
          <button 
            v-if="searchQuery"
            @click="clearSearch"
            class="clear-search-btn"
          >
            <Icon name="x" />
          </button>
        </div>

        <!-- Search Results -->
        <div v-if="searchQuery" class="search-results">
          <div v-if="isSearching" class="search-loading">
            <Icon name="loader" class="spinning" />
            <span>Searching...</span>
          </div>
          <div v-else-if="searchResults.length === 0" class="no-results">
            <Icon name="search" />
            <span>No users found</span>
          </div>
          <div 
            v-else
            v-for="user in searchResults"
            :key="user.id"
            class="search-result-item"
            @click="toggleUserSelection(user)"
            :class="{ selected: isUserSelected(user.id) }"
          >
            <Avatar
              :src="user.avatar_url"
              :alt="user.display_name || user.username"
              size="sm"
              class="user-avatar"
            />
            <div class="user-info">
              <div class="user-name"><DisplayName :user-id="user.id" :fallback="user.display_name || user.username" :truncate="true" /></div>
              <div class="user-handle">{{ formatUserHandle(user) }}</div>
            </div>
            <div class="selection-indicator">
              <Icon v-if="isUserSelected(user.id)" name="check" />
              <Icon v-else name="plus" />
            </div>
          </div>
        </div>
      </div>

      <!-- Selected Users Section -->
      <div v-if="selectedUsers.length > 0" class="selected-users-section">
        <div class="section-header">
          <h3 class="section-title">Selected Users ({{ selectedUsers.length }})</h3>
          <button @click="clearAllSelections" class="clear-all-btn">
            Clear All
          </button>
        </div>

        <div class="selected-users-list">
          <div 
            v-for="user in selectedUsers"
            :key="user.id"
            class="selected-user-item"
          >
            <Avatar
              :src="user.avatar_url"
              :alt="user.display_name || user.username"
              size="xs"
              class="user-avatar"
            />
            <span class="user-name"><DisplayName :user-id="user.id" :fallback="user.display_name || user.username" :truncate="true" /></span>
            <button 
              @click="removeUserFromSelection(user.id)"
              class="remove-user-btn"
              :title="`Remove ${user.display_name || user.username}`"
            >
              <Icon name="x" />
            </button>
          </div>
        </div>
      </div>

      <!-- Group Chat Settings (for new groups) -->
      <div v-if="isNewGroup && selectedUsers.length > 0" class="group-settings-section">
        <div class="section-header">
          <h3 class="section-title">Group Settings</h3>
          <p class="section-description">Configure your new group chat</p>
        </div>

        <div class="setting-row">
          <label for="groupName" class="setting-label">Group Name (Optional)</label>
          <input
            id="groupName"
            v-model="groupName"
            type="text"
            :placeholder="`Chat with ${getGroupNamePreview()}`"
            class="setting-input"
            maxlength="100"
          />
        </div>

        <div class="setting-row">
          <label class="setting-label">
            <input
              v-model="isPrivateGroup"
              type="checkbox"
              class="setting-checkbox"
            />
            Private Group
          </label>
          <p class="setting-description">
            Only invited members can join. {{ isPrivateGroup ? 'Members must be added manually.' : 'Members can invite others.' }}
          </p>
        </div>
      </div>

      <!-- Existing Participants (for adding to existing conversation) -->
      <div v-if="!isNewGroup && (existingParticipants?.length ?? 0) > 0" class="existing-participants-section">
        <div class="section-header">
          <h3 class="section-title">Current Participants ({{ existingParticipants?.length ?? 0 }})</h3>
        </div>

        <div class="participants-list">
          <div 
            v-for="participant in (existingParticipants ?? [])"
            :key="participant.id"
            class="participant-item"
          >
            <Avatar
              :src="participant.avatar_url"
              :alt="participant.display_name || participant.username"
              size="sm"
              class="user-avatar"
            />
            <div class="user-info">
              <div class="user-name"><DisplayName :user-id="participant.id" :fallback="participant.display_name || participant.username" :truncate="true" /></div>
              <div class="user-handle">{{ formatUserHandle(participant) }}</div>
            </div>
            <div v-if="participant.id === currentUserId" class="you-badge">You</div>
          </div>
        </div>
      </div>

      <!-- ActivityPub Federation Notice -->
      <div v-if="hasExternalUsers" class="federation-notice">
        <Icon name="federation" />
        <div class="notice-content">
          <strong>Federated Group Chat</strong>
          <p>This conversation includes users from other servers. Messages will be federated according to ActivityPub standards.</p>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="modal-footer-content">
        <button @click="$emit('close')" class="footer-button secondary">
          Cancel
        </button>
        <button 
          @click="handleCreateOrAddUsers"
          :disabled="selectedUsers.length === 0 || isProcessing"
          class="footer-button primary"
        >
          <Icon v-if="isProcessing" name="loader" class="spinning" />
          <Icon v-else-if="isNewGroup" name="users" />
          <Icon v-else name="user-plus" />
          {{ actionButtonText }}
        </button>
      </div>
    </template>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { debug } from '@/utils/debug'
import { useToast } from 'vue-toastification'
import { useDMStore } from '@/stores/useDM'
import { useAuthStore } from '@/stores/auth'
import BaseModal from '@/components/common/BaseModal.vue'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import DisplayName from '@/components/DisplayName.vue'
import type { DMUser } from '@/stores/useDM'

interface Props {
  show: boolean
  conversationId?: string // If provided, adding to existing conversation
  existingParticipants?: DMUser[] // Current participants in the conversation
}

const props = defineProps<Props>()
const emit = defineEmits<{
  close: []
  conversationCreated: [conversationId: string]
  usersAdded: [conversationId: string, userIds: string[]]
}>()

const toast = useToast()
const dmStore = useDMStore()
const authStore = useAuthStore()

const searchQuery = ref('')
const searchResults = ref<DMUser[]>([])
const selectedUsers = ref<DMUser[]>([])
const isSearching = ref(false)
const isProcessing = ref(false)
const searchInput = ref<HTMLInputElement>()
const searchTimeout = ref<NodeJS.Timeout>()

// Group settings (for new groups)
const groupName = ref('')
const isPrivateGroup = ref(false)

const isNewGroup = computed(() => !props.conversationId)
const currentUserId = computed(() => authStore.session?.user?.id)

const modalTitle = computed(() => {
  return isNewGroup.value ? 'Create Group Chat' : 'Add People'
})

const modalSubtitle = computed(() => {
  return isNewGroup.value 
    ? 'Start a conversation with multiple people'
    : 'Add more people to this conversation'
})

const actionButtonText = computed(() => {
  if (isProcessing.value) return 'Processing...'
  if (isNewGroup.value) {
    return selectedUsers.value.length === 1 
      ? 'Create Chat' 
      : `Create Group (${selectedUsers.value.length + 1})`
  }
  return selectedUsers.value.length === 1
    ? 'Add 1 Person'
    : `Add ${selectedUsers.value.length} People`
})

const hasExternalUsers = computed(() => {
  return selectedUsers.value.some(user => !user.is_local) ||
         (props.existingParticipants?.some(user => !user.is_local) ?? false)
})

const handleSearch = () => {
  if (searchTimeout.value) {
    clearTimeout(searchTimeout.value)
  }

  searchTimeout.value = setTimeout(async () => {
    let query = searchQuery.value.trim()
    if (!query || !currentUserId.value) {
      searchResults.value = []
      return
    }
    // Allow @ prefix: strip leading @ so "y4my4m" and "@y4my4m" both work
    if (query.startsWith('@')) {
      query = query.slice(1).trim()
    }

    isSearching.value = true
    try {
      await dmStore.searchUsers(query, currentUserId.value)
      debug.log('Search completed, raw results:', dmStore.searchResults.length)
      debug.log('Selected users before filtering:', selectedUsers.value.map(u => ({ id: u.id, username: u.username })))
      
      searchResults.value = dmStore.searchResults.filter(user => {
        if (user.id === currentUserId.value) return false
        if (props.existingParticipants?.some(p => p.id === user.id)) return false
        if (selectedUsers.value.some(s => s.id === user.id)) return false
        return true
      })
      
      debug.log('Filtered search results:', searchResults.value.length)
    } catch (error) {
      debug.error('Search failed:', error)
      toast.error('Failed to search users')
    } finally {
      isSearching.value = false
    }
  }, 300)
}

const clearSearch = () => {
  searchQuery.value = ''
  searchResults.value = []
}

const refreshSearchResults = () => {
  // Re-filter the current dmStore.searchResults with updated selected users
  if (dmStore.searchResults.length > 0) {
    debug.log('Refreshing search results:', {
      totalResults: dmStore.searchResults.length,
      selectedUsers: selectedUsers.value.map(u => ({ id: u.id, username: u.username, hasId: !!u.id })),
      existingParticipants: props.existingParticipants?.map(p => p.id) || []
    })
    
    searchResults.value = dmStore.searchResults.filter(user => {
      if (user.id === currentUserId.value) {
        debug.log('Filtering out current user:', user.id)
        return false
      }
      if (props.existingParticipants?.some(p => p.id === user.id)) {
        debug.log('Filtering out existing participant:', user.id)
        return false
      }
      if (selectedUsers.value.some(s => s.id === user.id)) {
        debug.log('Filtering out already selected user:', user.id, 'comparing with selected:', selectedUsers.value.map(s => s.id))
        return false
      }
      debug.log('Keeping user in results:', user.id)
      return true
    })
    
    debug.log('Final search results count:', searchResults.value.length)
  }
}

const selectFirstResult = () => {
  if (searchResults.value.length > 0) {
    toggleUserSelection(searchResults.value[0])
  }
}

const toggleUserSelection = (user: DMUser) => {
  debug.log('Toggling user selection:', { user, hasId: !!user.id })
  
  const index = selectedUsers.value.findIndex(u => u.id === user.id)
  if (index > -1) {
    selectedUsers.value.splice(index, 1)
  } else {
    selectedUsers.value.push(user)
  }
  
  debug.log('Selected users after toggle:', selectedUsers.value.map(u => ({ id: u.id, username: u.username })))
  
  refreshSearchResults()
}

const isUserSelected = (userId: string): boolean => {
  return selectedUsers.value.some(u => u.id === userId)
}

const removeUserFromSelection = (userId: string) => {
  const index = selectedUsers.value.findIndex(u => u.id === userId)
  if (index > -1) {
    selectedUsers.value.splice(index, 1)
    refreshSearchResults()
  }
}

const clearAllSelections = () => {
  selectedUsers.value = []
  refreshSearchResults()
}

const formatUserHandle = (user: DMUser): string => {
  if (!user.is_local && user.handle) {
    return user.handle
  }
  return user.is_local ? `@${user.username}` : `@${user.username}@${user.domain || 'unknown'}`
}

const stripShortcodes = (text: string): string => {
  if (!text) return text
  const stripped = text.replace(/:[a-zA-Z0-9_+-]+:/g, '').replace(/\s+/g, ' ').trim()
  return stripped || text
}

const getGroupNamePreview = (): string => {
  const names = selectedUsers.value.slice(0, 3).map(u => stripShortcodes(u.display_name || u.username))
  if (selectedUsers.value.length > 3) {
    return `${names.join(', ')} and ${selectedUsers.value.length - 3} others`
  }
  return names.join(', ')
}

const handleCreateOrAddUsers = async () => {
  if (selectedUsers.value.length === 0 || !currentUserId.value) return

  isProcessing.value = true
  try {
    if (isNewGroup.value) {
      await createGroupChat()
    } else {
      await addUsersToConversation()
    }
  } catch (error) {
    debug.error('Operation failed:', error)
    toast.error('Failed to process request')
  } finally {
    isProcessing.value = false
  }
}

const createDirectConversation = async () => {
  if (!currentUserId.value || selectedUsers.value.length !== 1) return;

  try {
    const conversationId = await dmStore.createOrGetConversation(
      currentUserId.value,
      selectedUsers.value[0].id
    );

    if (conversationId) {
      emit('conversationCreated', conversationId);
      emit('close');
      toast.success('Conversation created!');
    }
  } catch (error) {
    debug.error('Failed to create direct conversation:', error);
    throw error;
  }
};

const createGroupConversation = async () => {
  if (!currentUserId.value || selectedUsers.value.length <= 1) return;

  try {
    const conversationId = await dmStore.createGroupConversation({
      participantIds: [currentUserId.value, ...selectedUsers.value.map(u => u.id)],
      name: groupName.value || undefined,
      isPrivate: isPrivateGroup.value,
    });

    if (conversationId) {
      emit('conversationCreated', conversationId);
      emit('close');
      toast.success('Group conversation created!');
    } else {
      toast.error('Failed to create group conversation');
    }
  } catch (error) {
    debug.error('Failed to create group conversation:', error);
    throw error;
  }
};

const createGroupChat = async () => {
  if (selectedUsers.value.length === 1) {
    await createDirectConversation();
  } else {
    await createGroupConversation();
  }
};
const addUsersToConversation = async () => {
  if (!props.conversationId || !currentUserId.value) return

  try {
    const result = await dmStore.addUsersToConversation(
      props.conversationId,
      selectedUsers.value.map(u => u.id),
      currentUserId.value
    )

    if (result) {
      if (typeof result === 'string') {
        // New group conversation was created, navigate to it
        emit('conversationCreated', result)
        toast.success(`Created group conversation with ${selectedUsers.value.length} additional user${selectedUsers.value.length > 1 ? 's' : ''}`)
      } else {
        // Users were added to existing group conversation
        emit('usersAdded', props.conversationId, selectedUsers.value.map(u => u.id))
        toast.success(`Added ${selectedUsers.value.length} user${selectedUsers.value.length > 1 ? 's' : ''} to conversation`)
      }
      emit('close')
    } else {
      toast.error('Failed to add users to conversation')
    }
  } catch (error) {
    debug.error('Failed to add users to conversation:', error)
    toast.error('Failed to add users to conversation')
    throw error
  }
}

onMounted(() => {
  nextTick(() => {
    searchInput.value?.focus()
  })
})

watch(() => props.show, (show) => {
  if (show) {
    selectedUsers.value = []
    clearSearch()
    groupName.value = ''
    isPrivateGroup.value = false
    
    nextTick(() => {
      searchInput.value?.focus()
    })
  }
})
</script>

<style scoped>
.group-chat-invite-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.section-header {
  margin-bottom: var(--space-4);
}

.section-title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 var(--space-1) 0;
}

.section-description {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0;
}

/* Search Section */
.search-input-container {
  position: relative;
  margin-bottom: var(--space-3);
}

.search-input {
  width: 100%;
  padding: var(--space-3) var(--space-4);
  padding-right: var(--space-10);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--background-secondary);
  color: var(--text-primary);
  font-size: var(--font-size-base);
  transition: all 0.2s ease;
}

.search-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
  box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.1);
}

.clear-search-btn {
  position: absolute;
  right: var(--space-2);
  top: 50%;
  transform: translateY(-50%);
  padding: var(--space-1);
  border: none;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all 0.2s ease;
}

.clear-search-btn:hover {
  color: var(--text-primary);
  background: var(--background-tertiary);
}

/* Search Results */
.search-results {
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--background-primary);
}

.search-loading,
.no-results {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-4);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.search-result-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  cursor: pointer;
  transition: all 0.2s ease;
  border-bottom: 1px solid var(--border-color);
}

.search-result-item:last-child {
  border-bottom: none;
}

.search-result-item:hover {
  background: var(--background-secondary);
}

.search-result-item.selected {
  background: rgba(14, 165, 233, 0.1);
  border-color: var(--harmony-primary);
}

.search-result-item .user-info {
  flex: 1;
  min-width: 0;
}

.search-result-item .user-name {
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin-bottom: 2px;
}

.search-result-item .user-handle {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.selection-indicator {
  color: var(--harmony-primary);
}

/* Selected Users Section */
.selected-users-section .section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.clear-all-btn {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--background-secondary);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all 0.2s ease;
}

.clear-all-btn:hover {
  background: var(--background-tertiary);
  color: var(--text-primary);
}

.selected-users-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.selected-user-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
}

.selected-user-item .user-name {
  color: var(--text-primary);
  font-weight: var(--font-weight-medium);
}

.remove-user-btn {
  padding: 2px;
  border: none;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: var(--radius-xs);
  transition: all 0.2s ease;
}

.remove-user-btn:hover {
  color: var(--error-primary);
  background: rgba(239, 68, 68, 0.1);
}

/* Group Settings */
.setting-row {
  margin-bottom: var(--space-4);
}

.setting-label {
  display: block;
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin-bottom: var(--space-2);
}

.setting-input {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--background-secondary);
  color: var(--text-primary);
  font-size: var(--font-size-base);
}

.setting-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.setting-checkbox {
  margin-right: var(--space-2);
}

.setting-description {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: var(--space-1) 0 0 0;
}

/* Existing Participants */
.participants-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.participant-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2);
}

.participant-item .user-info {
  flex: 1;
  min-width: 0;
}

.participant-item .user-name {
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin-bottom: 2px;
}

.participant-item .user-handle {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.you-badge {
  padding: 2px var(--space-1);
  background: var(--harmony-primary);
  color: var(--text-primary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  border-radius: var(--radius-xs);
}

/* Federation Notice */
.federation-notice {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
  background: rgba(14, 165, 233, 0.1);
  border: 1px solid rgba(14, 165, 233, 0.2);
  border-radius: var(--radius-md);
}

.federation-notice .notice-content strong {
  color: var(--text-primary);
  display: block;
  margin-bottom: var(--space-1);
}

.federation-notice .notice-content p {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  margin: 0;
}

/* Footer */
.modal-footer-content {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.footer-button {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: all 0.2s ease;
}

.footer-button.secondary {
  background: var(--background-secondary);
  color: var(--text-primary);
}

.footer-button.secondary:hover {
  background: var(--background-tertiary);
}

.footer-button.primary {
  background: var(--harmony-primary);
  color: var(--text-primary);
  border-color: var(--harmony-primary);
}

.footer-button.primary:hover:not(:disabled) {
  background: var(--harmony-primary-hover, #4f46e5);
}

.footer-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>