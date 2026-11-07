<template>
  <article
    class="profile-embed"
    :class="{ 'profile-embed--loading': state === 'loading', 'profile-embed--gone': state === 'gone' }"
    data-testid="profile-embed"
    :aria-label="state === 'ready' ? t('embeds.profile.label', { name: displayName }) : t('embeds.profile.title')"
  >
    <div v-if="state === 'loading'" class="profile-embed__skeleton" :aria-label="t('embeds.profile.loading')">
      <div class="skeleton-avatar"></div>
      <div class="skeleton-lines">
        <div class="skeleton-line"></div>
        <div class="skeleton-line skeleton-line--short"></div>
      </div>
    </div>

    <div v-else-if="state === 'gone'" class="profile-embed__gone" data-testid="profile-embed-unavailable">
      <Icon name="user-x" :size="22" class="gone-icon" />
      <div class="gone-text">
        <span class="gone-title">{{ t('embeds.profile.unavailable') }}</span>
        <span class="gone-handle">{{ requestedHandle }}</span>
      </div>
    </div>

    <template v-else-if="account">
      <button type="button" class="profile-embed__avatar" :aria-label="t('embeds.profile.open')" tabindex="-1" @click="openProfile">
        <Avatar :src="account.avatar_url" alt="" size="lg" />
      </button>
      <div class="profile-embed__body">
        <div class="profile-embed__name" data-testid="profile-embed-name">
          <DisplayName v-if="account.id" :user-id="account.id" :fallback="displayName" :truncate="true" />
          <template v-else>{{ displayName }}</template>
          <Icon v-if="account.locked" name="lock" :size="12" class="profile-embed__lock" :title="t('activitypub.lockedAccount')" />
        </div>
        <div class="profile-embed__handle" data-testid="profile-embed-handle">{{ handle }}</div>
        <p v-if="bio" class="profile-embed__bio" data-testid="profile-embed-bio">{{ bio }}</p>
        <div class="profile-embed__stats">
          <span v-if="followers !== null"><strong>{{ formatCount(followers) }}</strong> {{ t('activitypub.followers') }}</span>
          <span v-if="following !== null"><strong>{{ formatCount(following) }}</strong> {{ t('activitypub.following') }}</span>
          <span v-if="posts !== null"><strong>{{ formatCount(posts) }}</strong> {{ t('activitypub.monies') }}</span>
        </div>
      </div>
      <div class="profile-embed__actions">
        <button
          v-if="!isSelf && account.id"
          type="button"
          class="profile-embed__follow"
          :class="{ 'is-following': isFollowing || requested }"
          :disabled="followBusy"
          :aria-label="followLabel"
          data-testid="profile-embed-follow"
          @click="toggleFollowState"
        >{{ followText }}</button>
        <button type="button" class="profile-embed__open" data-testid="profile-embed-open" @click="openProfile">
          {{ t('embeds.profile.open') }}
        </button>
      </div>
    </template>
  </article>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'
import Icon from '@/components/common/Icon.vue'
import { activityPubService } from '@/services/activityPubService'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { useProfileStore } from '@/stores/useProfile'
import { usePostInteractions } from '@/composables/usePostInteractions'
import { FOLLOW_ACTION_KEYS, useFollowAction } from '@/composables/useFollowAction'
import { formatHandle } from '@/utils/handles'
import { profileHandleParam } from '@/utils/permalinks'
import { profileLinkFromUrl } from '@/utils/profileLinks'
import { plainDisplayName } from '@/utils/plainDisplayName'
import { profileCount } from '@/utils/profileCounts'
import { debug } from '@/utils/debug'
import type { EmbedPayload, FederatedUser, HarmonyProfileSummary } from '@/types'

const props = defineProps<{ payload: EmbedPayload }>()
const emit = defineEmits<{ load: [] }>()

const { t } = useI18n()
const router = useRouter()
const toast = useToast()
const activityPubStore = useActivityPubStore()
const profileStore = useProfileStore()
const { toggleFollow } = usePostInteractions()

const BIO_LENGTH = 160

type CardAccount = HarmonyProfileSummary & Partial<Pick<FederatedUser, 'manually_approves_followers'>> & {
  is_suspended?: boolean | null
  deleted_at?: string | null
  remote_counts_fetched_at?: string | null
}

/** The account the link names: the stored snapshot, else the URL's username and domain. */
const link = computed((): HarmonyProfileSummary | null => {
  const stored = props.payload.profile
  if (stored?.username) return { ...stored, domain: stored.domain ?? null }
  return profileLinkFromUrl(props.payload.url)
})

const account = ref<CardAccount | null>(null)
const state = ref<'loading' | 'ready' | 'gone'>('loading')
const requested = ref(false)
const followBusy = ref(false)

const requestedHandle = computed(() => (link.value ? formatHandle(link.value, { full: true }) : props.payload.url))

async function load(): Promise<void> {
  const target = link.value
  if (!target) {
    state.value = 'gone'
    emit('load')
    return
  }
  if (target.id) {
    account.value = target
    state.value = 'ready'
    emit('load')
    return
  }
  state.value = 'loading'
  try {
    const found = await activityPubService.getUserByHandle(target.domain ? `${target.username}@${target.domain}` : target.username)
    const user = found as unknown as CardAccount | null
    if (!user?.id || user.is_suspended || user.deleted_at) {
      state.value = 'gone'
    } else {
      account.value = { ...user, locked: user.manually_approves_followers === true }
      state.value = 'ready'
    }
  } catch (error) {
    debug.warn('Profile embed lookup failed:', error)
    state.value = 'gone'
  } finally {
    emit('load')
  }
}

onMounted(load)
watch(() => props.payload.url, load)

const displayName = computed(() => plainDisplayName(account.value?.display_name, account.value?.username ?? ''))
const handle = computed(() => formatHandle(account.value, { full: true }))

/** The bio as text, at most BIO_LENGTH characters: stored markup and emoji parts read as text. */
const bio = computed(() => {
  const raw = account.value?.bio as unknown
  let text = ''
  if (typeof raw === 'string') {
    text = new DOMParser().parseFromString(raw.replace(/<br\s*\/?>/gi, ' ').replace(/<\/p>/gi, ' '), 'text/html').body.textContent ?? ''
  } else if (Array.isArray(raw)) {
    text = raw.map((part: any) => (typeof part === 'string' ? part : part?.text ?? (part?.name ? `:${part.name}:` : ''))).join('')
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > BIO_LENGTH ? `${text.slice(0, BIO_LENGTH - 1)}…` : text
})

const counts = computed(() => (account.value ? { ...account.value, is_local: account.value.is_local ?? !account.value.domain } : null))
const followers = computed(() => profileCount(counts.value as any, 'followers'))
const following = computed(() => profileCount(counts.value as any, 'following'))
const posts = computed(() => profileCount(counts.value as any, 'posts'))

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

const isSelf = computed(() => !!account.value?.id && account.value.id === profileStore.profile?.id)
const isFollowing = computed(() => !!account.value?.id && activityPubStore.isFollowing(account.value.id))
const { action: followAction } = useFollowAction(
  () => (account.value ? { ...account.value, is_local: account.value.is_local ?? !account.value.domain } : null),
  () => account.value?.locked === true,
)
const plainHandle = computed(() => handle.value.replace(/^@/, ''))
const followText = computed(() => {
  if (isFollowing.value) return t('activitypub.following')
  if (requested.value) return t('activitypub.requested')
  return t(FOLLOW_ACTION_KEYS[followAction.value].text)
})
const followLabel = computed(() => {
  if (isFollowing.value) return t('activitypub.profileA11y.followingUnfollow', { handle: plainHandle.value })
  if (requested.value) return t('activitypub.profileA11y.requestedCancel', { handle: plainHandle.value })
  return t(FOLLOW_ACTION_KEYS[followAction.value].label, { handle: plainHandle.value })
})

async function toggleFollowState(): Promise<void> {
  const id = account.value?.id
  if (!id || followBusy.value) return
  followBusy.value = true
  const wasFollowing = isFollowing.value
  try {
    const result = await toggleFollow(id, requested.value)
    if (result.error) {
      toast.error(t(wasFollowing ? 'activitypub.unfollowFailed' : 'activitypub.followFailed'))
      return
    }
    requested.value = !!result.pending
    if (result.following) activityPubStore.followedUsers.add(id)
    else activityPubStore.followedUsers.delete(id)
  } finally {
    followBusy.value = false
  }
}

function openProfile(): void {
  const param = profileHandleParam(account.value ?? link.value)
  if (param) void router.push({ name: 'UserProfile', params: { handle: param } })
}
</script>

<style scoped>
.profile-embed {
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 460px;
  margin: 8px 0;
  padding: 14px 16px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  background: var(--background-secondary);
  min-width: 0;
}

.profile-embed__avatar {
  flex-shrink: 0;
  padding: 0;
  border: none;
  background: none;
  border-radius: 50%;
  cursor: pointer;
}

.profile-embed__body {
  flex: 1;
  min-width: 0;
}

.profile-embed__name {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.profile-embed__lock {
  flex-shrink: 0;
  color: var(--text-muted);
}

.profile-embed__handle {
  overflow: hidden;
  font-size: 13px;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.profile-embed__bio {
  display: -webkit-box;
  margin: 6px 0 0;
  overflow: hidden;
  font-size: 13px;
  color: var(--text-muted);
  overflow-wrap: anywhere;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
}

.profile-embed__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}

.profile-embed__stats strong {
  color: var(--text-primary);
}

.profile-embed__actions {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  gap: 6px;
}

.profile-embed__follow,
.profile-embed__open {
  min-height: 32px;
  padding: 0 14px;
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.profile-embed__follow {
  border: none;
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
}

.profile-embed__follow.is-following {
  border: 1px solid var(--border-primary);
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
}

.profile-embed__follow:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.profile-embed__open {
  border: 1px solid var(--border-primary);
  background: transparent;
  color: var(--text-primary);
}

.profile-embed__open:hover,
.profile-embed__follow.is-following:hover {
  background: var(--background-modifier-active);
}

.profile-embed__follow:focus-visible,
.profile-embed__open:focus-visible {
  outline: 2px solid var(--brand-primary, #0EA5E9);
  outline-offset: 2px;
}

.profile-embed__gone {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-secondary);
}

.gone-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.gone-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.gone-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.gone-handle {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.profile-embed__skeleton {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.skeleton-avatar {
  flex-shrink: 0;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--background-modifier-hover);
}

.skeleton-lines {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
}

.skeleton-line {
  height: 12px;
  border-radius: 6px;
  background: var(--background-modifier-hover);
}

.skeleton-line--short {
  width: 50%;
}

@media (max-width: 480px) {
  .profile-embed {
    flex-wrap: wrap;
  }

  .profile-embed__actions {
    flex-direction: row;
    width: 100%;
  }

  .profile-embed__follow,
  .profile-embed__open {
    flex: 1;
  }
}
</style>
