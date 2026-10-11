<template>
  <div class="list-detail-view">
    <!-- Header -->
    <div class="list-header">
      <button
        type="button"
        class="back-btn"
        :aria-label="t('activitypub.listsA11y.back')"
        :title="t('activitypub.listsA11y.back')"
        @click="router.push({ name: 'Lists' })"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.42-1.41L7.83 13H20v-2z"/>
        </svg>
      </button>
      <div class="header-info">
        <h1 class="list-title">{{ list?.title || t('activitypub.listsA11y.list') }}</h1>
        <span class="member-count" v-if="list">{{ t('activitypub.listsA11y.members', { count: members.length }, members.length) }}</span>
      </div>
      <div class="header-actions">
        <button
          type="button"
          class="action-btn"
          data-testid="list-members-toggle"
          :aria-expanded="showMembersPanel"
          aria-controls="list-members-panel"
          @click="showMembersPanel = !showMembersPanel"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
          </svg>
          {{ t('activitypub.listsA11y.membersTitle') }}
        </button>
        <button
          type="button"
          class="action-btn edit"
          data-testid="list-edit"
          :aria-label="t('activitypub.listsA11y.edit')"
          :title="t('activitypub.listsA11y.edit')"
          @click="editList"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Members Panel -->
    <section
      v-if="showMembersPanel"
      id="list-members-panel"
      class="members-panel"
      aria-labelledby="list-members-heading"
    >
      <div class="members-header">
        <h2 id="list-members-heading" class="members-heading">{{ t('activitypub.listsA11y.membersCount', { count: members.length }, members.length) }}</h2>
        <div class="search-member">
          <input
            v-model="memberSearchQuery"
            type="search"
            :aria-label="t('activitypub.listsA11y.searchToAdd')"
            :placeholder="t('activitypub.listsA11y.searchToAdd')"
            @input="searchUsersToAdd"
          />
        </div>
      </div>

      <!-- Search results -->
      <ul v-if="searchResults.length > 0" class="search-results" :aria-label="t('activitypub.listsA11y.searchResultsLabel')">
        <li
          v-for="user in searchResults"
          :key="user.id"
          class="user-row"
        >
          <img :src="user.avatar_url || '/default_avatar.webp'" class="user-avatar" alt="" />
          <div class="user-info">
            <span class="user-name">{{ user.display_name || user.username }}</span>
            <span class="user-handle">@{{ user.username }}</span>
          </div>
          <button
            type="button"
            class="add-btn"
            :aria-label="isMember(user.id) ? t('activitypub.listsA11y.addedNamed', { name: rowName(user) }) : t('activitypub.listsA11y.addNamed', { name: rowName(user) })"
            @click="addMember(user.id)"
            :disabled="isMember(user.id)"
          >
            {{ isMember(user.id) ? t('activitypub.listsA11y.added') : t('activitypub.listsA11y.add') }}
          </button>
        </li>
      </ul>

      <!-- Current members -->
      <div class="current-members">
        <ul v-if="members.length > 0" class="member-list" :aria-label="t('activitypub.listsA11y.membersTitle')">
          <li
            v-for="member in members"
            :key="member.account_id"
            class="user-row"
          >
            <img :src="member.account?.avatar_url || '/default_avatar.webp'" class="user-avatar" alt="" />
            <div class="user-info">
              <span class="user-name">{{ member.account?.display_name || member.account?.username }}</span>
              <span class="user-handle">@{{ member.account?.username }}</span>
            </div>
            <button
              type="button"
              class="remove-btn"
              :aria-label="t('activitypub.listsA11y.removeNamed', { name: rowName(member.account) })"
              @click="removeMember(member.account_id)"
            >
              {{ t('activitypub.listsA11y.remove') }}
            </button>
          </li>
        </ul>
        <EmptyState
          v-if="members.length === 0"
          size="sm"
          icon="users"
          :title="$t('empty.listMembers.title')"
          :description="$t('empty.listMembers.description')"
        />
      </div>
    </section>

    <!-- Timeline -->
    <div class="list-timeline" v-if="!showMembersPanel">
      <PostsContainer
        :posts="timelinePosts"
        :is-loading="isLoading || isLoadingMore"
        :has-more="hasMore"
        :loading-message="t('common.loading')"
        :feed-label="list?.title || t('activitypub.listsA11y.list')"
        :empty-title="$t('empty.listTimeline.title')"
        :empty-message="$t('empty.listTimeline.description')"
        empty-icon="list"
        @load-more="loadMore"
        @reply="$emit('reply-to-post', $event)"
        @favorite="$emit('favorite-post', $event)"
        @reblog="$emit('reblog-post', $event)"
        @bookmark="$emit('bookmark-post', $event)"
        @delete="$emit('delete-post', $event)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAnnouncer } from '@/composables/useAnnouncer'
import { plainDisplayName } from '@/utils/plainDisplayName'
import { debug } from '@/utils/debug'
import { useActivityPubStore, type UserListMember } from '@/stores/useActivityPub'
import { supabase } from '@/supabase'
import PostsContainer from '@/components/common/PostsContainer.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import type { TimelinePost } from '@/types'

const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const { polite } = useAnnouncer()
const activityPubStore = useActivityPubStore()

const list = ref<any>(null)
const members = ref<UserListMember[]>([])
const timelinePosts = ref<TimelinePost[]>([])
const isLoading = ref(false)
const isLoadingMore = ref(false)
const hasMore = ref(false)
const showMembersPanel = ref(false)
const memberSearchQuery = ref('')
const searchResults = ref<any[]>([])

const listId = route.params.listId as string

const rowName = (user: { display_name?: string | null; username?: string | null } | null | undefined) =>
  plainDisplayName(user?.display_name, user?.username || '')

// The list form lives in ListsView, which opens it from ?edit=<id>.
const editList = () => {
  router.push({ name: 'Lists', query: { edit: listId } })
}

const isMember = (userId: string): boolean => {
  return members.value.some(m => m.account_id === userId)
}

const loadList = async () => {
  try {
    await activityPubStore.loadLists()
    list.value = activityPubStore.lists.find(l => l.id === listId) || null
  } catch (error) {
    debug.error('Failed to load list:', error)
  }
}

const loadMembers = async () => {
  try {
    members.value = await activityPubStore.loadListMembers(listId)
  } catch (error) {
    debug.error('Failed to load list members:', error)
  }
}

const loadTimeline = async () => {
  isLoading.value = true
  try {
    timelinePosts.value = await activityPubStore.getListTimeline(listId, { limit: 20 })
    hasMore.value = timelinePosts.value.length >= 20
  } catch (error) {
    debug.error('Failed to load list timeline:', error)
  } finally {
    isLoading.value = false
  }
}

const loadMore = async () => {
  if (isLoadingMore.value) return
  isLoadingMore.value = true
  try {
    const lastPost = timelinePosts.value[timelinePosts.value.length - 1]
    const morePosts = await activityPubStore.getListTimeline(listId, {
      limit: 20,
      before: lastPost?.created_at
    })
    timelinePosts.value.push(...morePosts)
    hasMore.value = morePosts.length >= 20
  } catch (error) {
    debug.error('Failed to load more posts:', error)
  } finally {
    isLoadingMore.value = false
  }
}

const searchUsersToAdd = async () => {
  const query = memberSearchQuery.value.trim()
  if (!query) {
    searchResults.value = []
    return
  }

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, domain')
      .or(`username.ilike.%${query}%,display_name.ilike.%${query}%`)
      .limit(10)

    if (error) throw error
    searchResults.value = data || []
    polite(t('activitypub.listsA11y.searchResults', { count: searchResults.value.length }, searchResults.value.length), { key: 'list-member-search' })
  } catch (error) {
    debug.error('Failed to search users:', error)
  }
}

const addMember = async (userId: string) => {
  try {
    await activityPubStore.addToList(listId, userId)
    await loadMembers()
    searchResults.value = searchResults.value.filter(u => u.id !== userId)
  } catch (error: any) {
    debug.error('Failed to add member:', error)
  }
}

const removeMember = async (userId: string) => {
  try {
    await activityPubStore.removeFromList(listId, userId)
    members.value = members.value.filter(m => m.account_id !== userId)
  } catch (error) {
    debug.error('Failed to remove member:', error)
  }
}

onMounted(async () => {
  await Promise.all([loadList(), loadMembers()])
  await loadTimeline()
})
</script>

<style scoped>
.list-detail-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--background-primary, #1a1a2e);
}

.list-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color, #2b2d31);
  background: var(--background-secondary, #1e1f22);
}

.back-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 8px;
  border-radius: 6px;
}

.back-btn:hover {
  background: var(--background-hover);
  color: var(--text-primary);
}

.header-info {
  flex: 1;
}

.list-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary, #f2f3f5);
}

.member-count {
  font-size: 13px;
  color: var(--text-secondary, #b5bac1);
}

.header-actions {
  display: flex;
  gap: 8px;
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--background-tertiary, #2b2d31);
  border: none;
  color: var(--text-secondary);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
}

.action-btn:hover {
  background: var(--background-hover);
  color: var(--text-primary);
}

.members-panel {
  border-bottom: 1px solid var(--border-color, #2b2d31);
  max-height: 400px;
  overflow-y: auto;
  padding: 16px;
}

.members-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.members-heading {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.search-member input::-webkit-search-cancel-button {
  -webkit-appearance: none;
  appearance: none;
}

.search-member input {
  padding: 6px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--background-primary);
  color: var(--text-primary);
  font-size: 13px;
  width: 200px;
}

.search-results {
  margin: 0 0 12px;
  padding: 0 0 12px;
  list-style: none;
  border-bottom: 1px solid var(--border-color);
}

.member-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.user-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: 6px;
}

.user-row:hover {
  background: var(--background-hover);
}

.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
}

.user-info {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.user-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.user-handle {
  font-size: 12px;
  color: var(--text-secondary);
}

.add-btn, .remove-btn {
  padding: 4px 12px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border: none;
}

.add-btn {
  background: var(--harmony-primary);
  color: var(--text-primary);
}

.add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.remove-btn {
  background: var(--danger, #ef4444);
  color: var(--text-primary);
}

.list-timeline {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 48px;
  color: var(--text-secondary);
}

.loading-spinner {
  width: 24px;
  height: 24px;
  border: 3px solid var(--border-color);
  border-top-color: var(--harmony-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

.load-more-btn {
  display: block;
  width: 100%;
  padding: 12px;
  background: none;
  border: none;
  border-top: 1px solid var(--border-color);
  color: var(--text-link);
  font-weight: 600;
  cursor: pointer;
}

.load-more-btn:hover {
  background: var(--background-hover);
}
</style>
