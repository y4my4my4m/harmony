<template>
  <div class="lists-view">
    <div class="lists-header">
      <h1 class="lists-title">Lists</h1>
      <button class="create-list-btn" @click="showCreateModal = true">
        <span class="icon">+</span>
        New List
      </button>
    </div>

    <!-- Loading State -->
    <div v-if="isLoadingLists" class="lists-loading">
      <LoadingSpinner :size="32" />
      <span>Loading lists...</span>
    </div>

    <!-- Empty State -->
    <div v-else-if="lists.length === 0" class="lists-empty">
      <div class="empty-icon">📋</div>
      <h2>No lists yet</h2>
      <p>Lists let you organize followed accounts and create custom timelines.</p>
      <button class="create-first-btn" @click="showCreateModal = true">
        Create your first list
      </button>
    </div>

    <!-- Lists Grid -->
    <div v-else class="lists-grid">
      <div 
        v-for="list in lists" 
        :key="list.id"
        class="list-card"
        @click="openList(list)"
      >
        <div class="list-card-header">
          <h3 class="list-title">{{ list.title }}</h3>
          <div class="list-badges">
            <span v-if="list.is_exclusive" class="badge exclusive" title="Exclusive list">
              ⭐
            </span>
            <span v-if="list.is_public" class="badge public" title="Public list">
              🌐
            </span>
          </div>
        </div>
        <p v-if="list.description" class="list-description">
          {{ list.description }}
        </p>
        <div class="list-meta">
          <span class="members-count">
            {{ list.members_count || 0 }} {{ list.members_count === 1 ? 'member' : 'members' }}
          </span>
          <span class="replies-policy">
            {{ formatRepliesPolicy(list.replies_policy) }}
          </span>
        </div>
        <div class="list-actions" @click.stop>
          <button class="action-btn edit" @click="editList(list)" title="Edit list">
            ✏️
          </button>
          <button class="action-btn delete" @click="confirmDeleteList(list)" title="Delete list">
            🗑️
          </button>
        </div>
      </div>
    </div>

    <!-- Create/Edit Modal -->
    <Teleport to="body">
      <div v-if="showCreateModal || editingList" class="modal-overlay" @click="closeModal">
        <div class="modal-content" @click.stop>
          <h2>{{ editingList ? 'Edit List' : 'Create New List' }}</h2>
          <form @submit.prevent="handleSubmit">
            <div class="form-group">
              <label for="title">Title *</label>
              <input
                id="title"
                v-model="formData.title"
                type="text"
                required
                placeholder="e.g., Friends, News, Tech"
                maxlength="64"
              />
            </div>
            <div class="form-group">
              <label for="description">Description</label>
              <textarea
                id="description"
                v-model="formData.description"
                placeholder="What is this list for?"
                maxlength="255"
                rows="2"
              />
            </div>
            <div class="form-group">
              <label for="replies_policy">Show replies to</label>
              <select id="replies_policy" v-model="formData.replies_policy">
                <option value="list">List members only</option>
                <option value="followed">Anyone you follow</option>
                <option value="none">No replies</option>
              </select>
            </div>
            <div class="form-group checkbox">
              <label>
                <input v-model="formData.is_exclusive" type="checkbox" />
                <span>Exclusive list</span>
              </label>
              <p class="help-text">Hide list members from your home timeline</p>
            </div>
            <div class="form-group checkbox">
              <label>
                <input v-model="formData.is_public" type="checkbox" />
                <span>Public list</span>
              </label>
              <p class="help-text">Allow others to view this list</p>
            </div>
            <div class="modal-actions">
              <button type="button" class="btn-cancel" @click="closeModal">
                Cancel
              </button>
              <button type="submit" class="btn-submit" :disabled="isSubmitting">
                {{ editingList ? 'Save Changes' : 'Create List' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>

    <!-- Delete Confirmation Modal -->
    <Teleport to="body">
      <div v-if="listToDelete" class="modal-overlay" @click="listToDelete = null">
        <div class="modal-content delete-modal" @click.stop>
          <h2>Delete List</h2>
          <p>Are you sure you want to delete "{{ listToDelete.title }}"?</p>
          <p class="warning">This action cannot be undone.</p>
          <div class="modal-actions">
            <button class="btn-cancel" @click="listToDelete = null">
              Cancel
            </button>
            <button class="btn-delete" :disabled="isDeleting" @click="handleDelete">
              Delete List
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, reactive } from 'vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { useRouter } from 'vue-router'
import { debug } from '@/utils/debug'
import { useActivityPubStore, type UserList } from '@/stores/useActivityPub'

// Router
const router = useRouter()

const activityPubStore = useActivityPubStore()

// State
const isLoadingLists = ref(false)
const showCreateModal = ref(false)
const editingList = ref<UserList | null>(null)
const listToDelete = ref<UserList | null>(null)
const isSubmitting = ref(false)
const isDeleting = ref(false)

// Form data
const formData = reactive({
  title: '',
  description: '',
  replies_policy: 'list' as 'followed' | 'list' | 'none',
  is_exclusive: false,
  is_public: false
})

// Computed
const lists = computed(() => activityPubStore.lists)

const formatRepliesPolicy = (policy: string) => {
  switch (policy) {
    case 'followed': return 'Replies to followed'
    case 'list': return 'Replies to list'
    case 'none': return 'No replies'
    default: return policy
  }
}

const loadLists = async () => {
  isLoadingLists.value = true
  try {
    await activityPubStore.loadLists()
  } catch (error) {
    debug.error('Failed to load lists:', error)
  } finally {
    isLoadingLists.value = false
  }
}

const openList = (list: UserList) => {
  router.push({ name: 'ListDetail', params: { listId: list.id } })
}

// Edit list
const editList = (list: UserList) => {
  editingList.value = list
  formData.title = list.title
  formData.description = list.description || ''
  formData.replies_policy = list.replies_policy
  formData.is_exclusive = list.is_exclusive
  formData.is_public = list.is_public
}

// Confirm delete
const confirmDeleteList = (list: UserList) => {
  listToDelete.value = list
}

const closeModal = () => {
  showCreateModal.value = false
  editingList.value = null
  formData.title = ''
  formData.description = ''
  formData.replies_policy = 'list'
  formData.is_exclusive = false
  formData.is_public = false
}

const handleSubmit = async () => {
  if (!formData.title.trim()) return

  isSubmitting.value = true
  try {
    if (editingList.value) {
      await activityPubStore.updateList(editingList.value.id, {
        title: formData.title,
        description: formData.description || undefined,
        replies_policy: formData.replies_policy,
        is_exclusive: formData.is_exclusive,
        is_public: formData.is_public
      })
    } else {
      await activityPubStore.createList({
        title: formData.title,
        description: formData.description || undefined,
        replies_policy: formData.replies_policy,
        is_exclusive: formData.is_exclusive,
        is_public: formData.is_public
      })
    }
    closeModal()
  } catch (error) {
    debug.error('Failed to save list:', error)
  } finally {
    isSubmitting.value = false
  }
}

const handleDelete = async () => {
  if (!listToDelete.value) return

  isDeleting.value = true
  try {
    await activityPubStore.deleteList(listToDelete.value.id)
    listToDelete.value = null
  } catch (error) {
    debug.error('Failed to delete list:', error)
  } finally {
    isDeleting.value = false
  }
}

onMounted(() => {
  loadLists()
})
</script>

<style scoped>
.lists-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 1.5rem;
  background: var(--background-primary, #1a1a2e);
}

.lists-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}

.lists-title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-primary, #fff);
  margin: 0;
}

.create-list-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.625rem 1rem;
  background: var(--harmony-primary, #6366f1);
  color: var(--text-primary);
  border: none;
  border-radius: 0.5rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}

.create-list-btn:hover {
  background: var(--harmony-primary-hover, #4f46e5);
}

.create-list-btn .icon {
  font-size: 1.25rem;
  line-height: 1;
}

/* Loading */
.lists-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding: 3rem;
  color: var(--text-secondary, #a0a0a0);
}


/* Empty State */
.lists-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 3rem;
  text-align: center;
}

.empty-icon {
  font-size: 4rem;
  margin-bottom: 1rem;
}

.lists-empty h2 {
  color: var(--text-primary, #fff);
  margin: 0 0 0.5rem 0;
}

.lists-empty p {
  color: var(--text-secondary, #a0a0a0);
  max-width: 300px;
  margin: 0 0 1.5rem 0;
}

.create-first-btn {
  padding: 0.75rem 1.5rem;
  background: var(--harmony-primary, #6366f1);
  color: var(--text-primary);
  border: none;
  border-radius: 0.5rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}

.create-first-btn:hover {
  background: var(--harmony-primary-hover, #4f46e5);
}

/* Lists Grid */
.lists-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

.list-card {
  position: relative;
  background: var(--background-secondary, #16213e);
  border: 1px solid var(--border-primary, #333);
  border-radius: 0.75rem;
  padding: 1rem;
  cursor: pointer;
  transition: border-color 0.2s, transform 0.15s;
}

.list-card:hover {
  border-color: var(--harmony-primary, #6366f1);
  transform: translateY(-2px);
}

.list-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 0.5rem;
}

.list-title {
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--text-primary, #fff);
  margin: 0;
}

.list-badges {
  display: flex;
  gap: 0.25rem;
}

.badge {
  font-size: 0.875rem;
}

.list-description {
  color: var(--text-secondary, #a0a0a0);
  font-size: 0.875rem;
  margin: 0 0 0.75rem 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.list-meta {
  display: flex;
  gap: 1rem;
  font-size: 0.75rem;
  color: var(--text-tertiary, #666);
}

.list-actions {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  display: flex;
  gap: 0.25rem;
  opacity: 0;
  transition: opacity 0.2s;
}

.list-card:hover .list-actions {
  opacity: 1;
}

.action-btn {
  padding: 0.375rem;
  background: var(--background-tertiary, #0f0f1a);
  border: none;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: background 0.2s;
}

.action-btn:hover {
  background: var(--background-hover, #252550);
}

.action-btn.delete:hover {
  background: var(--danger, #ef4444);
}

/* Modal */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(4px);
}

.modal-content {
  background: var(--background-secondary, #16213e);
  border: 1px solid var(--border-primary, #333);
  border-radius: 1rem;
  padding: 1.5rem;
  width: 90%;
  max-width: 420px;
  max-height: 90vh;
  overflow-y: auto;
}

.modal-content h2 {
  color: var(--text-primary, #fff);
  margin: 0 0 1.5rem 0;
  font-size: 1.25rem;
}

.form-group {
  margin-bottom: 1rem;
}

.form-group label {
  display: block;
  color: var(--text-secondary, #a0a0a0);
  font-size: 0.875rem;
  margin-bottom: 0.375rem;
}

.form-group input[type="text"],
.form-group textarea,
.form-group select {
  width: 100%;
  padding: 0.625rem 0.875rem;
  background: var(--background-primary, #1a1a2e);
  border: 1px solid var(--border-primary, #333);
  border-radius: 0.5rem;
  color: var(--text-primary, #fff);
  font-size: 0.9375rem;
}

.form-group input:focus,
.form-group textarea:focus,
.form-group select:focus {
  outline: none;
  border-color: var(--harmony-primary, #6366f1);
}

.form-group.checkbox label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  color: var(--text-primary, #fff);
}

.form-group.checkbox input[type="checkbox"] {
  width: auto;
}

.help-text {
  font-size: 0.75rem;
  color: var(--text-tertiary, #666);
  margin: 0.25rem 0 0 1.5rem;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 1.5rem;
}

.btn-cancel,
.btn-submit,
.btn-delete {
  padding: 0.625rem 1.25rem;
  border-radius: 0.5rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}

.btn-cancel {
  background: transparent;
  border: 1px solid var(--border-primary, #333);
  color: var(--text-secondary, #a0a0a0);
}

.btn-cancel:hover {
  background: var(--background-hover, #252550);
}

.btn-submit {
  background: var(--harmony-primary, #6366f1);
  border: none;
  color: var(--text-primary);
}

.btn-submit:hover:not(:disabled) {
  background: var(--harmony-primary-hover, #4f46e5);
}

.btn-submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.delete-modal .warning {
  color: var(--danger, #ef4444);
  font-size: 0.875rem;
}

.btn-delete {
  background: var(--danger, #ef4444);
  border: none;
  color: var(--text-primary);
}

.btn-delete:hover:not(:disabled) {
  background: var(--danger-hover, #dc2626);
}

.btn-delete:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
