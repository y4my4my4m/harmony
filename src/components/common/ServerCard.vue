<template>
  <div class="server-card" :class="{ 
    'server-card--featured': server.is_featured,
    'server-card--has-banner': serverBannerUrl,
  }">
    <!-- Server banner background (semi-transparent overlay) -->
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
        <div v-if="server.is_featured" class="server-card__featured-badge">
          <svg viewBox="0 0 24 24" class="featured-icon">
            <path d="M12,2L15.09,8.26L22,9L17,14L18.18,21L12,17.77L5.82,21L7,14L2,9L8.91,8.26L12,2Z" fill="currentColor"/>
          </svg>
        </div>
      </div>
      
      <div class="server-card__status">
        <div class="status-dot status-dot--online"></div>
        <span class="status-text">{{ $t('server.active') }}</span>
      </div>
    </div>
    
    <div class="server-card__content">
      <h3 class="server-card__name">{{ server.name }}</h3>
      <p class="server-card__description">
        {{ server.description || $t('server.noDescriptionAvailable') }}
      </p>
      
      <div class="server-card__info">
        <div class="server-card__stats">
          <div class="stat-item">
            <svg viewBox="0 0 24 24" class="stat-icon">
              <path d="M16 4C16.5 4 17 4.5 17 5V18.5A1.5 1.5 0 0 1 15.5 20H3.5A1.5 1.5 0 0 1 2 18.5V5C2 4.5 2.5 4 3 4H16M16 2H3C1.3 2 0 3.3 0 5V18.5A3.5 3.5 0 0 0 3.5 22H15.5A3.5 3.5 0 0 0 19 18.5V5C19 3.3 17.7 2 16 2M6 7V9H14V7H6M6 11V13H14V11H6M6 15V17H10V15H6Z" fill="currentColor"/>
            </svg>
            <span class="stat-text">{{ formatMemberCount(server.member_count) }}</span>
          </div>
          
          <div v-if="server.category" class="stat-item">
            <svg viewBox="0 0 24 24" class="stat-icon">
              <path d="M5,9V21H1V9H5M9,21A2,2 0 0,1 7,19V9C7,8.45 7.22,7.95 7.59,7.59L14.17,1L15.23,2.06C15.5,2.33 15.67,2.7 15.67,3.11L15.64,3.43L14.69,8H21C21.53,8 22,8.2 22.39,8.59C22.78,8.98 23,9.45 23,10V12C23,12.26 22.95,12.5 22.86,12.73L19.84,19.78C19.54,20.5 18.83,21 18,21H9M9,19H18.03L21,12V10H12.21L13.34,4.68L9,9.03V19Z" fill="currentColor"/>
            </svg>
            <span class="stat-text">{{ translateCategory(server.category) }}</span>
          </div>
        </div>

        <div v-if="!server.is_featured" class="server-card__owner" @click="handleOwnerClick" :title="$t('server.viewOwnerProfile')">
          <Avatar 
            :src="ownerAvatar" 
            :name="ownerName"
            size="sm"
            class="owner-avatar"
          />
          <span class="owner-name"><DisplayName :userId="server.owner" :fallback="ownerName" :truncate="true" /></span>
        </div>
      </div>
    </div>

    <div class="server-card__actions">
      <button 
        v-if="isJoined" 
        @click="handleLeave" 
        class="btn btn--danger btn--server-action"
        :disabled="isLoading"
      >
        <span v-if="!isLoading">{{ $t('server.leave') }}</span>
        <span v-else>{{ $t('server.leaving') }}</span>
      </button>
      
      <button 
        v-else 
        @click="handleJoin" 
        class="btn btn--primary btn--server-action"
        :disabled="isLoading"
      >
        <span v-if="!isLoading">{{ $t('server.join') }}</span>
        <span v-else>{{ $t('server.joining') }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { debug } from '@/utils/debug'
import { useI18n } from 'vue-i18n'
import { useUserData } from '@/composables/useUserData'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'
import type { PublicServerWithStats } from '@/stores/usePublicServers'
import ServerIcon from './ServerIcon.vue'
import { getServerBannerUrl, getRawServerBannerUrl } from '@/utils/serverUtils'

const { t } = useI18n()

interface Props {
  server: PublicServerWithStats
  isJoined: boolean
  isLoading?: boolean
}

interface Emits {
  (e: 'join', serverId: string): void
  (e: 'leave', serverId: string): void
  (e: 'viewOwnerProfile', userId: string): void
}

const props = withDefaults(defineProps<Props>(), {
  isLoading: false,
})

const emit = defineEmits<Emits>()

const { getUserAvatarUrl, getUserDisplayName, getUser, fetchUserProfile } = useUserData()

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

// Local state to track if we're loading owner data
const loadingOwnerData = ref(false)

onMounted(async () => {
  if (!getUser(props.server.owner).value) {
    debug.log('ServerCard: Owner not in cache, fetching from database...')
    loadingOwnerData.value = true
    try {
      await fetchUserProfile(props.server.owner, true) // Force refresh
      debug.log('ServerCard: Owner profile fetched successfully')
    } catch (error) {
      debug.error('ServerCard: Failed to fetch owner profile:', error)
    } finally {
      loadingOwnerData.value = false
    }
  }
})

const ownerAvatar = computed(() => {
  const user = getUser(props.server.owner).value
  const avatarUrl = getUserAvatarUrl(props.server.owner).value
  
  debug.log('ServerCard: Owner user:', user)
  debug.log('ServerCard: Owner avatar URL:', avatarUrl)
  debug.log('ServerCard: Loading state:', loadingOwnerData.value)
  
  if (avatarUrl && avatarUrl !== '/default_avatar.webp') {
    return avatarUrl
  }
  
  return null
})

const ownerName = computed(() => {
  const displayName = getUserDisplayName(props.server.owner).value
  debug.log('ServerCard: Owner display name:', displayName)
  return displayName || 'Loading...'
})

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

const handleJoin = () => {
  emit('join', props.server.id)
}

const handleLeave = () => {
  emit('leave', props.server.id)
}

const translateCategory = (category?: string): string => {
  if (!category) return ''
  const categoryMap: Record<string, string> = {
    'Gaming': t('server.categoryGaming'),
    'Technology': t('server.categoryTechnology'),
    'Art & Design': t('server.categoryArtDesign'),
    'Music': t('server.categoryMusic'),
    'Education': t('server.categoryEducation'),
    'Entertainment': t('server.categoryEntertainment'),
    'Community': t('server.categoryCommunity'),
    'Science': t('server.categoryScience'),
    'Sports': t('server.categorySports'),
    'Other': t('server.categoryOther')
  }
  return categoryMap[category] || category
}

const handleOwnerClick = (event: Event) => {
  event.stopPropagation()
  emit('viewOwnerProfile', props.server.owner)
}
</script>

<style scoped>
.server-card {
  background: var(--background-secondary);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.06));
  border-radius: 12px;
  padding: 16px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.server-card:hover {
  border-color: var(--border-hover, rgba(255, 255, 255, 0.12));
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
}

.server-card--featured {
  border-color: rgba(255, 215, 0, 0.2);
  background: linear-gradient(
    160deg,
    color-mix(in srgb, var(--harmony-primary) 12%, var(--background-secondary)) 0%,
    var(--background-secondary) 60%
  );
}

.server-card--featured:hover {
  border-color: rgba(255, 215, 0, 0.35);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
}

/* Server banner with semi-transparent overlay */
.server-card__banner {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 100px;
  background-size: cover;
  background-position: center;
  border-radius: 12px 12px 0 0;
  overflow: hidden;
  z-index: 0;
}

.server-card__banner-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    rgba(0, 0, 0, 0.35) 0%,
    transparent 50%,
    var(--background-secondary, #1e1f22) 100%
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
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 12px;
}

.server-card__featured-badge {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 22px;
  height: 22px;
  background: linear-gradient(135deg, #ffd700, #ffb800);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--background-secondary);
  box-shadow: 0 2px 6px rgba(255, 215, 0, 0.3);
}

.featured-icon {
  width: 11px;
  height: 11px;
  color: #1a1200;
}

.server-card__status {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-secondary);
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.status-dot--online {
  background: #3ba55c;
}

.server-card__content {
  flex: 1;
  margin-bottom: 12px;
}

.server-card__name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 4px 0;
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
  margin: 0 0 12px 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.server-card__info {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.server-card__stats {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-secondary);
}

.stat-icon {
  width: 13px;
  height: 13px;
  opacity: 0.6;
}

.server-card__owner {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  transition: opacity 0.15s ease;
  padding: 2px 0;
}

.server-card__owner:hover {
  opacity: 0.85;
}

.owner-name {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 500;
}

.server-card__actions {
  display: flex;
}

.btn {
  flex: 1;
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.15s ease, opacity 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 36px;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn--primary {
  background: var(--harmony-primary, #0EA5E9);
  color: #fff;
}

.btn--primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

.btn--danger {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.btn--danger:hover:not(:disabled) {
  background: rgba(237, 66, 69, 0.1);
  color: #ed4245;
  border-color: rgba(237, 66, 69, 0.25);
}

.btn-icon {
  width: 14px;
  height: 14px;
}

@media (max-width: 768px) {
  .server-card {
    padding: 14px;
  }
  
  .server-card__stats {
    flex-direction: column;
    gap: 4px;
  }
}
</style>
