<template>
  <div class="authorize-view" data-testid="authorize-interaction">
    <header class="authorize-header">
      <button type="button" class="authorize-icon-button" :aria-label="t('common.back')" @click="leave">
        <Icon name="arrow-left" :size="20" />
      </button>
      <h1>{{ t('authorizeInteraction.title') }}</h1>
    </header>

    <div class="authorize-scroll">
      <div class="authorize-inner">
        <p v-if="state.status === 'loading'" class="authorize-muted" role="status" data-testid="authorize-loading">
          {{ t('authorizeInteraction.resolving', { uri: uriText }) }}
        </p>

        <div v-else-if="state.status === 'error'" class="authorize-error" role="alert" data-testid="authorize-error">
          <p>{{ state.invalid ? t('authorizeInteraction.invalid') : t('authorizeInteraction.notFound') }}</p>
          <code v-if="uriText" class="authorize-uri">{{ uriText }}</code>
          <button type="button" class="authorize-button" @click="leave">{{ t('authorizeInteraction.home') }}</button>
        </div>

        <section v-else-if="state.status === 'actor'" class="authorize-card" data-testid="authorize-actor">
          <div class="authorize-identity">
            <Avatar :src="state.user.avatar_url" size="lg" alt="" aria-hidden="true" />
            <div class="authorize-names">
              <span class="authorize-display-name">{{ plainDisplayName }}</span>
              <span class="authorize-handle" data-testid="authorize-handle">{{ fullHandle }}</span>
            </div>
          </div>
          <p v-if="state.user.bio" class="authorize-bio">{{ bioText }}</p>
          <div class="authorize-actions">
            <button
              v-if="!isSelf"
              type="button"
              class="authorize-button"
              :class="{ 'is-secondary': relation !== 'none' }"
              :disabled="followBusy"
              :aria-pressed="relation !== 'none'"
              data-testid="authorize-follow"
              @click="toggleFollow"
            >
              {{ followLabel }}
            </button>
            <router-link
              v-if="profilePath"
              :to="profilePath"
              class="authorize-button is-secondary"
              data-testid="authorize-open-profile"
            >
              {{ t('authorizeInteraction.openProfile') }}
            </router-link>
          </div>
        </section>

        <section v-else-if="state.status === 'post'" class="authorize-card" data-testid="authorize-post">
          <div class="authorize-identity">
            <Avatar :src="state.post.author?.avatar_url" size="md" alt="" aria-hidden="true" />
            <div class="authorize-names">
              <span class="authorize-display-name">{{ state.post.author?.display_name || state.post.author?.username }}</span>
              <span class="authorize-handle">{{ postAuthorHandle }}</span>
            </div>
          </div>
          <p v-if="postText" class="authorize-post-text" data-testid="authorize-post-text">{{ postText }}</p>
          <div class="authorize-actions">
            <router-link
              :to="`/social/post/${state.post.id}`"
              class="authorize-button"
              data-testid="authorize-open-post"
            >
              {{ t('authorizeInteraction.openPost') }}
            </router-link>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import Avatar from '@/components/common/Avatar.vue'
import { activityPubService } from '@/services/activityPubService'
import { postResolverService } from '@/services/PostResolverService'
import { runtimeConfig } from '@/services/runtimeConfig'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { useProfileStore } from '@/stores/useProfile'
import { services } from '@/services'
import { parseInteractionUri, postPreviewText, profileRouteHandle } from '@/utils/authorizeInteraction'
import { debug } from '@/utils/debug'
import type { FederatedUser, TimelinePost } from '@/types'

type State =
  | { status: 'loading' }
  | { status: 'error'; invalid: boolean }
  | { status: 'actor'; user: FederatedUser }
  | { status: 'post'; post: TimelinePost }

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const toast = useToast()
const activityPubStore = useActivityPubStore()
const profileStore = useProfileStore()

const state = ref<State>({ status: 'loading' })
const relation = ref<'none' | 'following' | 'requested'>('none')
const followBusy = ref(false)

const uriText = computed(() => {
  const value = route.query.uri
  return typeof value === 'string' ? value : Array.isArray(value) ? String(value[0] ?? '') : ''
})

const handleOf = (user: { username?: string; domain?: string | null; is_local?: boolean } | null | undefined) => {
  if (!user?.username) return ''
  return user.is_local === false && user.domain ? `@${user.username}@${user.domain}` : `@${user.username}`
}

const actor = computed(() => (state.value.status === 'actor' ? state.value.user : null))
const fullHandle = computed(() => handleOf(actor.value as any))
const plainDisplayName = computed(() => {
  const name = actor.value?.display_name as unknown
  return typeof name === 'string' && name ? name : actor.value?.username ?? ''
})
const bioText = computed(() => {
  const bio = actor.value?.bio as unknown
  return typeof bio === 'string' ? bio : ''
})
const profilePath = computed(() => {
  const handle = actor.value ? profileRouteHandle(actor.value as any) : null
  return handle ? `/social/profile/${handle}` : null
})
const isSelf = computed(() => !!actor.value && actor.value.id === profileStore.profile?.id)
const followLabel = computed(() => relation.value === 'following'
  ? t('activitypub.following')
  : relation.value === 'requested' ? t('activitypub.requested') : t('activitypub.follow'))

const post = computed(() => (state.value.status === 'post' ? state.value.post : null))
const postText = computed(() => postPreviewText(post.value?.content))
const postAuthorHandle = computed(() => handleOf(post.value?.author as any))

async function loadRelation(userId: string) {
  relation.value = 'none'
  try {
    const relationships = await services.interactions.getUserRelationships([userId])
    const rel = relationships[userId] as { following?: boolean; followRequestPending?: boolean } | undefined
    relation.value = rel?.following ? 'following' : rel?.followRequestPending ? 'requested' : 'none'
  } catch (error) {
    debug.warn('Relationship lookup failed:', error)
  }
}

async function resolve(raw: string) {
  state.value = { status: 'loading' }
  const target = parseInteractionUri(raw, runtimeConfig.domain)
  if (!target) {
    state.value = { status: 'error', invalid: true }
    return
  }
  try {
    let user: FederatedUser | null = null
    let found: TimelinePost | null = null
    if (target.kind === 'handle') {
      user = await activityPubService.getUserByHandle(`${target.username}@${target.domain}`)
    } else if (target.kind === 'local-profile') {
      user = await activityPubService.getUserByHandle(target.username)
    } else if (target.kind === 'local-post') {
      found = await postResolverService.resolveById(target.postId)
    } else {
      found = await postResolverService.resolveByApUrl(target.url)
      if (!found) user = await activityPubService.lookupUserByUrl(target.url)
    }
    if (raw !== uriText.value) return
    if (found) {
      state.value = { status: 'post', post: found }
    } else if (user?.id) {
      state.value = { status: 'actor', user }
      await loadRelation(user.id)
    } else {
      state.value = { status: 'error', invalid: false }
    }
  } catch (error) {
    debug.warn('authorize_interaction lookup failed:', error)
    if (raw === uriText.value) state.value = { status: 'error', invalid: false }
  }
}

async function toggleFollow() {
  const user = actor.value
  if (!user || followBusy.value) return
  followBusy.value = true
  try {
    if (relation.value === 'none') {
      const result = await activityPubStore.followUser(user.id) as { following?: boolean; pending?: boolean } | undefined
      relation.value = result?.pending ? 'requested' : 'following'
    } else {
      await activityPubStore.unfollowUser(user.id)
      relation.value = 'none'
    }
  } catch (error) {
    debug.warn('Follow from authorize_interaction failed:', error)
    toast.error(t('authorizeInteraction.followFailed'))
  } finally {
    followBusy.value = false
  }
}

function leave() {
  if (window.history.length > 1) router.back()
  else router.push('/social/home')
}

watch(uriText, (raw) => { void resolve(raw) }, { immediate: true })
</script>

<style scoped>
.authorize-view {
  height: calc(100 * var(--app-vh));
  height: calc(100 * var(--app-dvh));
  display: flex;
  flex-direction: column;
  background: var(--background-primary);
  color: var(--text-primary);
}

.authorize-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 56px;
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-primary);
  flex-shrink: 0;
}

.authorize-header h1 {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  line-height: var(--line-height-tight);
}

.authorize-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-base);
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
}

.authorize-icon-button:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.authorize-scroll {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4) var(--space-4) var(--space-8);
}

.authorize-inner {
  max-width: 560px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.authorize-muted {
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.authorize-error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
  color: var(--text-secondary);
}

.authorize-error p {
  margin: 0;
}

.authorize-uri {
  max-width: 100%;
  overflow-wrap: anywhere;
  font-size: var(--font-size-sm);
  color: var(--text-muted);
}

.authorize-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  background: var(--background-secondary);
}

.authorize-identity {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.authorize-names {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.authorize-display-name {
  font-weight: var(--font-weight-semibold);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.authorize-handle {
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.authorize-bio,
.authorize-post-text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--text-secondary);
}

.authorize-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.authorize-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 36px;
  padding: var(--space-1) var(--space-4);
  border: 1px solid var(--harmony-primary);
  border-radius: var(--radius-base);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font: inherit;
  font-weight: var(--font-weight-semibold);
  text-decoration: none;
  cursor: pointer;
}

.authorize-button.is-secondary {
  background: none;
  color: var(--text-primary);
  border-color: var(--border-primary);
}

.authorize-button:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
