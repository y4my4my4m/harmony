<template>
  <div class="list-detail-view">
    <!-- Header -->
    <div class="list-header">
      <button class="back-btn" @click="router.push({ name: 'Lists' })">
        <svg width="20" height="20" viewBox="0 0 24 24">
          <path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.42-1.41L7.83 13H20v-2z"/>
        </svg>
      </button>
      <div class="header-info">
        <h1 class="list-title">{{ list?.title || 'List' }}</h1>
        <span class="member-count" v-if="list">{{ members.length }} members</span>
      </div>
      <div class="header-actions">
        <button class="action-btn" @click="showMembersPanel = !showMembersPanel">
          <svg width="20" height="20" viewBox="0 0 24 24">
            <path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
          </svg>
          Members
        </button>
        <button class="action-btn edit" @click="showEditModal = true">
          <svg width="16" height="16" viewBox="0 0 24 24">
            <path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Members Panel -->
    <div v-if="showMembersPanel" class="members-panel">
      <div class="members-header">
        <h3>Members ({{ members.length }})</h3>
        <div class="search-member">
          <input
            v-model="memberSearchQuery"
            type="text"
            placeholder="Search users to add..."
            @input="searchUsersToAdd"
          />
        </div>
      </div>

      <!-- Search results -->
      <div v-if="searchResults.length > 0" class="search-results">
        <div
          v-for="user in searchResults"
          :key="user.id"
          class="user-row"
        >
          <img :src="user.avatar_url || '/default_avatar.webp'" class="user-avatar" :alt="user.username" />
          <div class="user-info">
            <span class="user-name">{{ user.display_name || user.username }}</span>
            <span class="user-handle">@{{ user.username }}</span>
          </div>
          <button
            class="add-btn"
            @click="addMember(user.id)"
            :disabled="isMember(user.id)"
          >
            {{ isMember(user.id) ? 'Added' : 'Add' }}
          </button>
        </div>
      </div>

      <!-- Current members -->
      <div class="current-members">
        <div
          v-for="member in members"
          :key="member.account_id"
          class="user-row"
        >
          <img :src="member.account?.avatar_url || '/default_avatar.webp'" class="user-avatar" :alt="member.account?.username" />
          <div class="user-info">
            <span class="user-name">{{ member.account?.display_name || member.account?.username }}</span>
            <span class="user-handle">@{{ member.account?.username }}</span>
          </div>
          <button class="remove-btn" @click="removeMember(member.account_id)">
            Remove
          </button>
        </div>
        <div v-if="members.length === 0" class="empty-members">
          No members yet. Search above to add followed users.
        </div>
      </div>
    </div>

    <!-- Timeline -->
    <div class="list-timeline" v-if="!showMembersPanel">
      <PostsContainer
        :posts="timelinePosts"
        :is-loading="isLoading || isLoadingMore"
        :has-more="hasMore"
        loading-message="Loading timeline..."
        empty-title="No posts yet"
        empty-message="Add members to this list to see their posts here."
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
import { debug } from '@/utils/debug'
import { useActivityPubStore, type UserListMember } from '@/stores/useActivityPub'
import { supabase } from '@/supabase'
import PostsContainer from '@/components/common/PostsContainer.vue'
import type { TimelinePost } from '@/types'

const router = useRouter()
const route = useRoute()
const activityPubStore = useActivityPubStore()

const list = ref<any>(null)
const members = ref<UserListMember[]>([])
const timelinePosts = ref<TimelinePost[]>([])
const isLoading = ref(false)
const isLoadingMore = ref(false)
const hasMore = ref(false)
const showMembersPanel = ref(false)
const showEditModal = ref(false)
const memberSearchQuery = ref('')
const searchResults = ref<any[]>([])

const listId = route.params.listId as string

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

.members-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
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
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-color);
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
  background: var(--harmony-primary, #0EA5E9);
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

.empty-members {
  text-align: center;
  padding: 20px;
  color: var(--text-secondary);
  font-size: 13px;
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

.empty-timeline {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 48px;
  text-align: center;
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 12px;
}

.empty-timeline h3 {
  margin: 0 0 8px;
  color: var(--text-primary);
}

.empty-timeline p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 14px;
}

.load-more-btn {
  display: block;
  width: 100%;
  padding: 12px;
  background: none;
  border: none;
  border-top: 1px solid var(--border-color);
  color: var(--harmony-primary);
  font-weight: 600;
  cursor: pointer;
}

.load-more-btn:hover {
  background: var(--background-hover);
}
</style>
