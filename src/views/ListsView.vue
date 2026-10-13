<template>
  <div class="lists-view">
    <div class="lists-header">
      <button
        v-if="isMobile"
        type="button"
        class="nav-menu-btn"
        :aria-label="$t('activitypub.openNavigation')"
        @click="openLeftSidebar"
      >
        <Icon name="menu" :size="20" />
      </button>
      <h1 class="lists-title">{{ $t('activitypub.lists') }}</h1>
      <button type="button" class="create-list-btn" data-testid="list-create" @click="showCreateModal = true">
        <span class="icon" aria-hidden="true">+</span>
        {{ t('activitypub.listsA11y.newList') }}
      </button>
    </div>

    <!-- Loading State -->
    <div v-if="isLoadingLists" class="lists-loading" role="status">
      <LoadingSpinner :size="32" />
      <span>{{ t('activitypub.listsA11y.loading') }}</span>
    </div>

    <!-- Empty State -->
    <EmptyState
      v-else-if="lists.length === 0"
      icon="list"
      :title="$t('empty.lists.title')"
      :description="$t('empty.lists.description')"
      :action-label="$t('empty.lists.action')"
      @action="showCreateModal = true"
    />

    <!-- Lists Grid. The title link opens a list; the card around it is a larger
         pointer target for the same route. -->
    <ul v-else class="lists-grid">
      <li
        v-for="list in lists" 
        :key="list.id"
        class="list-card"
        data-testid="list-card"
        @click="openList(list)"
      >
        <div class="list-card-header">
          <h2 class="list-title">
            <RouterLink :to="{ name: 'ListDetail', params: { listId: list.id } }" class="list-link" @click.stop>
              {{ list.title }}
            </RouterLink>
          </h2>
          <div class="list-badges">
            <span v-if="list.is_exclusive" class="badge exclusive" role="img" :aria-label="t('activitypub.listsA11y.exclusive')" :title="t('activitypub.listsA11y.exclusive')">
              <Icon name="star" :size="14" />
            </span>
            <span v-if="list.is_public" class="badge public" role="img" :aria-label="t('activitypub.listsA11y.public')" :title="t('activitypub.listsA11y.public')">
              <Icon name="globe" :size="14" />
            </span>
          </div>
        </div>
        <p v-if="list.description" class="list-description">
          {{ list.description }}
        </p>
        <div class="list-meta">
          <span class="members-count">
            {{ t('activitypub.listsA11y.members', { count: list.members_count || 0 }, list.members_count || 0) }}
          </span>
          <span class="replies-policy">
            {{ formatRepliesPolicy(list.replies_policy) }}
          </span>
        </div>
        <div class="list-actions" @click.stop>
          <button
            type="button"
            class="action-btn edit"
            :title="t('activitypub.listsA11y.edit')"
            :aria-label="t('activitypub.listsA11y.editNamed', { title: list.title })"
            @click="editList(list)"
          >
            <Icon name="pencil" :size="16" />
          </button>
          <button
            type="button"
            class="action-btn delete"
            :title="t('activitypub.listsA11y.delete')"
            :aria-label="t('activitypub.listsA11y.deleteNamed', { title: list.title })"
            @click="confirmDeleteList(list)"
          >
            <Icon name="trash" :size="16" />
          </button>
        </div>
      </li>
    </ul>

    <!-- Create/Edit dialog -->
    <AppDialog
      :open="showCreateModal || !!editingList"
      class="lists-dialog"
      data-testid="list-dialog"
      @close="closeModal"
      v-slot="{ titleId }"
    >
      <div class="modal-content">
        <h2 :id="titleId">{{ editingList ? t('activitypub.listsA11y.editTitle') : t('activitypub.listsA11y.createTitle') }}</h2>
        <form @submit.prevent="handleSubmit">
          <div class="form-group">
            <label for="list-title">{{ t('activitypub.listsA11y.titleLabel') }}</label>
            <input
              id="list-title"
              v-model="formData.title"
              type="text"
              required
              aria-required="true"
              :placeholder="t('activitypub.listsA11y.titlePlaceholder')"
              maxlength="64"
            />
          </div>
          <div class="form-group">
            <label for="list-description">{{ t('activitypub.listsA11y.descriptionLabel') }}</label>
            <textarea
              id="list-description"
              v-model="formData.description"
              :placeholder="t('activitypub.listsA11y.descriptionPlaceholder')"
              maxlength="255"
              rows="2"
            />
          </div>
          <div class="form-group">
            <label for="list-replies-policy">{{ t('activitypub.listsA11y.repliesLabel') }}</label>
            <select id="list-replies-policy" v-model="formData.replies_policy">
              <option value="list">{{ t('activitypub.listsA11y.repliesList') }}</option>
              <option value="followed">{{ t('activitypub.listsA11y.repliesFollowed') }}</option>
              <option value="none">{{ t('activitypub.listsA11y.repliesNone') }}</option>
            </select>
          </div>
          <div class="form-group checkbox">
            <label>
              <input v-model="formData.is_exclusive" type="checkbox" aria-describedby="list-exclusive-help" />
              <span>{{ t('activitypub.listsA11y.exclusive') }}</span>
            </label>
            <p id="list-exclusive-help" class="help-text">{{ t('activitypub.listsA11y.exclusiveHelp') }}</p>
          </div>
          <div class="form-group checkbox">
            <label>
              <input v-model="formData.is_public" type="checkbox" aria-describedby="list-public-help" />
              <span>{{ t('activitypub.listsA11y.public') }}</span>
            </label>
            <p id="list-public-help" class="help-text">{{ t('activitypub.listsA11y.publicHelp') }}</p>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn-cancel" @click="closeModal">
              {{ t('common.cancel') }}
            </button>
            <button type="submit" class="btn-submit" :disabled="isSubmitting">
              {{ editingList ? t('activitypub.listsA11y.saveChanges') : t('activitypub.listsA11y.create') }}
            </button>
          </div>
        </form>
      </div>
    </AppDialog>
  </div>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import AppDialog from '@/components/a11y/AppDialog.vue'
import { computed, onMounted, ref, reactive } from 'vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { debug } from '@/utils/debug'
import { useActivityPubStore, type UserList } from '@/stores/useActivityPub'
import { useLayoutState } from '@/composables/useLayoutState'
import { useConfirmDialog } from '@/composables/useConfirmDialog'

// Router
const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const { confirm } = useConfirmDialog()
const { isMobile, openLeftSidebar } = useLayoutState()

const activityPubStore = useActivityPubStore()

// State
const isLoadingLists = ref(false)
const showCreateModal = ref(false)
const editingList = ref<UserList | null>(null)
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
    case 'followed': return t('activitypub.listsA11y.policyFollowed')
    case 'list': return t('activitypub.listsA11y.policyList')
    case 'none': return t('activitypub.listsA11y.policyNone')
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

const confirmDeleteList = async (list: UserList) => {
  const confirmed = await confirm({
    title: t('activitypub.listsA11y.deleteTitle'),
    message: t('activitypub.listsA11y.deleteConfirm', { title: list.title }),
    confirmButtonText: t('activitypub.listsA11y.delete'),
    dangerAction: true,
  })
  if (!confirmed || isDeleting.value) return
  isDeleting.value = true
  try {
    await activityPubStore.deleteList(list.id)
  } catch (error) {
    debug.error('Failed to delete list:', error)
  } finally {
    isDeleting.value = false
  }
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

// ListDetailView's Edit button opens this view with ?edit=<list id>.
onMounted(async () => {
  await loadLists()
  const editId = route.query.edit
  const list = typeof editId === 'string' ? lists.value.find((l) => l.id === editId) : undefined
  if (list) editList(list)
})
</script>

<style scoped>
.lists-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 1.5rem;
  background: var(--background-primary);
}

.lists-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: 1.5rem;
}

/* The page has no header of the social or chat layouts; on mobile this is the
   way to the navigation drawer besides the edge swipe. */
.nav-menu-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
}

.nav-menu-btn:hover {
  background: var(--background-modifier-hover);
}

.lists-title {
  flex: 1;
  font-size: 1.5rem;
  font-weight: var(--font-weight-bold);
  color: var(--text-primary);
  margin: 0;
}

.create-list-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.625rem 1rem;
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
  border: none;
  border-radius: 0.5rem;
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: background 0.2s;
}

.create-list-btn:hover {
  background: var(--harmony-primary-fill-hover);
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
  color: var(--text-secondary);
}


/* Lists Grid */
.lists-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.list-card {
  position: relative;
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: 0.75rem;
  padding: 1rem;
  cursor: pointer;
  transition: border-color var(--transition-fast);
}

.list-card:hover {
  border-color: var(--harmony-primary);
}

.list-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 0.5rem;
}

.list-title {
  font-size: 1.125rem;
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0;
}

.list-link {
  color: inherit;
  text-decoration: none;
}

.list-link:hover {
  text-decoration: underline;
}

.list-link:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

.list-badges {
  display: flex;
  gap: 0.25rem;
}

.badge {
  font-size: 0.875rem;
}

.list-description {
  color: var(--text-secondary);
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
  color: var(--text-tertiary);
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

.list-card:hover .list-actions,
.list-card:focus-within .list-actions {
  opacity: 1;
}

.action-btn {
  padding: 0.375rem;
  background: var(--background-tertiary);
  border: none;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: background 0.2s;
}

.action-btn:hover {
  background: var(--background-modifier-hover);
}

.action-btn.delete:hover {
  background: var(--error);
}

:global(.lists-dialog) {
  width: 90%;
  max-width: 420px;
}

.modal-content {
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-xl);
  padding: 1.5rem;
  box-shadow: var(--shadow-modal);
  max-height: calc(90 * var(--app-vh));
  overflow-y: auto;
}

.modal-content h2 {
  color: var(--text-primary);
  margin: 0 0 1.5rem 0;
  font-size: 1.25rem;
}

.form-group {
  margin-bottom: 1rem;
}

.form-group label {
  display: block;
  color: var(--text-secondary);
  font-size: 0.875rem;
  margin-bottom: 0.375rem;
}

.form-group input[type="text"],
.form-group textarea,
.form-group select {
  width: 100%;
  padding: 0.625rem 0.875rem;
  background: var(--background-primary);
  border: 1px solid var(--border-primary);
  border-radius: 0.5rem;
  color: var(--text-primary);
  font-size: 0.9375rem;
}

.form-group input:focus,
.form-group textarea:focus,
.form-group select:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.form-group.checkbox label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  color: var(--text-primary);
}

.form-group.checkbox input[type="checkbox"] {
  width: auto;
}

.help-text {
  font-size: 0.75rem;
  color: var(--text-tertiary);
  margin: 0.25rem 0 0 1.5rem;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 1.5rem;
}

.btn-cancel,
.btn-submit {
  padding: 0.625rem 1.25rem;
  border-radius: 0.5rem;
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: background 0.2s;
}

.btn-cancel {
  background: transparent;
  border: 1px solid var(--border-primary);
  color: var(--text-secondary);
}

.btn-cancel:hover {
  background: var(--background-modifier-hover);
}

.btn-submit {
  background: var(--harmony-primary-fill);
  border: none;
  color: var(--text-on-primary);
}

.btn-submit:hover:not(:disabled) {
  background: var(--harmony-primary-fill-hover);
}

.btn-submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

</style>
