<template>
  <article
    class="server-card"
    :class="{
      'server-card--featured': server.is_featured,
      'server-card--has-banner': !!serverBannerUrl,
    }"
  >
    <div v-if="serverBannerUrl" class="server-card__banner" :style="bannerStyle">
      <div class="server-card__banner-overlay"></div>
    </div>

    <div class="server-card__header">
      <div class="server-card__icon">
        <ServerIcon
          :src="server.icon"
          :alt="`${server.name} icon`"
          size="lg"
          shape="big-rounded"
          @error="handleImageError"
        />
        <span
          v-if="server.is_featured"
          class="server-card__featured-badge"
          :title="$t('server.featuredCommunities')"
        >
          <Icon name="star" :size="11" :stroke-width="2.5" />
        </span>
      </div>
    </div>

    <div class="server-card__content">
      <h3 class="server-card__name">{{ server.name }}</h3>
      <p class="server-card__description">
        {{ server.description || $t('server.noDescriptionAvailable') }}
      </p>

      <div class="server-card__info">
        <div class="server-card__stats">
          <span class="stat-item">
            <Icon name="users" :size="13" class="stat-icon" />
            {{ formatMemberCount(server.member_count) }}
          </span>

          <span v-if="categoryLabel" class="stat-item">
            <Icon :name="categoryIconName" :size="13" class="stat-icon" />
            {{ categoryLabel }}
          </span>
        </div>

        <button
          v-if="!server.is_featured && server.owner"
          type="button"
          class="server-card__owner"
          :title="$t('server.viewOwnerProfile')"
          @click.stop="emit('viewOwnerProfile', server.owner)"
        >
          <Avatar
            :src="ownerAvatar"
            :name="ownerName"
            size="sm"
            class="owner-avatar"
          />
          <span class="owner-name"><DisplayName :userId="server.owner" :fallback="ownerName" :truncate="true" /></span>
        </button>
      </div>
    </div>

    <div class="server-card__actions">
      <button
        v-if="isJoined"
        type="button"
        class="btn btn-secondary server-card__action"
        :disabled="isLoading"
        @click="emit('open', server.id)"
      >
        {{ $t('server.open') }}
      </button>

      <button
        v-else
        type="button"
        class="btn btn-primary server-card__action"
        :disabled="isLoading"
        @click="emit('join', server.id)"
      >
        {{ isLoading ? $t('server.joining') : $t('server.join') }}
      </button>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUserData } from '@/composables/useUserData'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import DisplayName from '@/components/DisplayName.vue'
import type { PublicServerWithStats } from '@/stores/usePublicServers'
import ServerIcon from './ServerIcon.vue'
import { getServerBannerUrl, getRawServerBannerUrl } from '@/utils/serverUtils'
import { categoryIcon, categoryLabelKey } from '@/utils/serverDiscovery'

const { t } = useI18n()

interface Props {
  server: PublicServerWithStats
  isJoined: boolean
  isLoading?: boolean
}

interface Emits {
  (e: 'join', serverId: string): void
  (e: 'open', serverId: string): void
  (e: 'viewOwnerProfile', userId: string): void
}

const props = withDefaults(defineProps<Props>(), {
  isLoading: false,
})

const emit = defineEmits<Emits>()

const { getUserAvatarUrl, getUserDisplayName } = useUserData()

const bannerFailed = ref(false)

const serverBannerUrl = computed(() => {
  const transformed = getServerBannerUrl(props.server.banner, { width: 640, height: 200, quality: 80 })
  if (!transformed) return null
  if (bannerFailed.value) {
    return getRawServerBannerUrl(props.server.banner)
  }
  return transformed
})

const bannerStyle = computed(() => {
  const url = serverBannerUrl.value
  if (!url) return {}
  return { backgroundImage: `url(${url})` }
})

watch(() => props.server.banner, (bannerPath) => {
  bannerFailed.value = false
  const transformed = getServerBannerUrl(bannerPath, { width: 640, height: 200, quality: 80 })
  if (!transformed) return
  const img = new Image()
  img.onerror = () => { bannerFailed.value = true }
  img.src = transformed
}, { immediate: true })

const ownerAvatar = computed(() => {
  const avatarUrl = getUserAvatarUrl(props.server.owner).value
  return avatarUrl && avatarUrl !== '/default_avatar.webp' ? avatarUrl : null
})

const ownerName = computed(() => getUserDisplayName(props.server.owner).value || '')

// "other" carries no information on a card, whether chosen or inferred.
const categoryLabel = computed(() => {
  const category = props.server.discovery_category
  if (!category || category === 'other') return null
  const key = categoryLabelKey(category)
  return key ? t(key) : null
})

const categoryIconName = computed(() => categoryIcon(props.server.discovery_category ?? '') ?? 'tag')

const formatMemberCount = (count?: number): string => {
  if (!count) return `0 ${t('server.members')}`
  if (count === 1) return `1 ${t('server.member')}`
  if (count < 1000) return `${count} ${t('server.members')}`
  if (count < 1000000) return `${(count / 1000).toFixed(1)}k ${t('server.members')}`
  return `${(count / 1000000).toFixed(1)}m ${t('server.members')}`
}

const handleImageError = (event: Event) => {
  const img = event.target as HTMLImageElement
  img.src = '/default_server.webp'
}
</script>

<style scoped src="../PublicServers/discoveryButtons.css"></style>

<style scoped>
.server-card {
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  transition: border-color var(--transition-fast);
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.server-card:hover {
  border-color: var(--border-hover);
}

.server-card--featured {
  border-color: color-mix(in srgb, var(--harmony-primary) 35%, var(--border-primary));
}

.server-card--featured:hover {
  border-color: color-mix(in srgb, var(--harmony-primary) 55%, var(--border-primary));
}

.server-card__banner {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 100px;
  background-size: cover;
  background-position: center;
  z-index: 0;
}

.server-card__banner-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    transparent 30%,
    var(--background-secondary) 100%
  );
}

.server-card--has-banner .server-card__header,
.server-card--has-banner .server-card__content,
.server-card--has-banner .server-card__actions {
  position: relative;
  z-index: 1;
}

.server-card__header {
  display: flex;
  align-items: flex-start;
  margin-bottom: var(--space-3);
}

.server-card__icon {
  position: relative;
}

.server-card__featured-badge {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-full);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  border: 2px solid var(--background-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.server-card__content {
  flex: 1;
  margin-bottom: var(--space-3);
}

.server-card__name {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 var(--space-1);
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.server-card__description {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.45;
  margin: 0 0 var(--space-3);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.server-card__info {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.server-card__stats {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}

.stat-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.stat-icon {
  color: var(--text-muted);
}

.server-card__owner {
  display: flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  max-width: 100%;
  padding: 2px 6px 2px 2px;
  margin-left: -2px;
  background: none;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  color: inherit;
  font: inherit;
  transition: background-color var(--transition-fast);
}

.server-card__owner:hover {
  background: var(--background-modifier-hover);
}

.server-card__owner:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 1px;
}

.owner-name {
  min-width: 0;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  font-weight: var(--font-weight-medium);
}

.server-card__actions {
  display: flex;
}

.server-card__action {
  flex: 1;
  min-height: 36px;
}

@media (max-width: 768px) {
  .server-card {
    padding: 14px;
  }
}
</style>
