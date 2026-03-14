<template>
  <div class="server-card" :class="{ 
    'server-card--featured': server.is_featured,
  }">
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
        <svg viewBox="0 0 24 24" class="btn-icon">
          <path d="M19,3H16.3H7.7H5A2,2 0 0,0 3,5V7.7V16.3V19A2,2 0 0,0 5,21H7.7H16.3H19A2,2 0 0,0 21,19V16.3V7.7V5A2,2 0 0,0 19,3M15.6,17L12,13.4L8.4,17L7,15.6L10.6,12L7,8.4L8.4,7L12,10.6L15.6,7L17,8.4L13.4,12L17,15.6L15.6,17Z" fill="currentColor"/>
        </svg>
        <span v-if="!isLoading">{{ $t('server.leave') }}</span>
        <span v-else>{{ $t('server.leaving') }}</span>
      </button>
      
      <button 
        v-else 
        @click="handleJoin" 
        class="btn btn--primary btn--server-action"
        :disabled="isLoading"
      >
        <svg viewBox="0 0 24 24" class="btn-icon">
          <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z" fill="currentColor"/>
        </svg>
        <span v-if="!isLoading">{{ $t('server.join') }}</span>
        <span v-else>{{ $t('server.joining') }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { debug } from '@/utils/debug'
import { useI18n } from 'vue-i18n'
import { useUserData } from '@/composables/useUserData'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'
import type { PublicServerWithStats } from '@/stores/usePublicServers'
import ServerIcon from './ServerIcon.vue'

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

// Local state to track if we're loading owner data
const loadingOwnerData = ref(false)

// Fetch owner profile when component mounts
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
  
  // Return actual avatar URL if available and not default
  if (avatarUrl && avatarUrl !== '/default_avatar.webp') {
    return avatarUrl
  }
  
  // Return null to let Avatar component handle defaults
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
  background: var(--background-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: 16px;
  padding: 20px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  backdrop-filter: blur(10px);
}

.server-card:hover {
  transform: translateY(-4px);
  border-color: var(--harmony-primary);
  box-shadow: 
    0 8px 32px rgba(0, 0, 0, 0.3),
    0 0 0 1px var(--harmony-primary),
    inset 0 1px 0 var(--border-primary);
}

.server-card--featured {
  border-color: var(--harmony-primary);
  background: linear-gradient(135deg, var(--harmony-primary) 0%, var(--background-primary) 100%);
  padding: 12px 16px;
  border-radius: 12px;
}

.server-card--featured:hover {
  border-color: var(--harmony-primary);
  box-shadow: 
    0 8px 32px var(--harmony-primary),
    0 0 0 1px var(--harmony-primary),
    inset 0 1px 0 var(--border-primary);
}

.server-card--featured .server-card__header {
  margin-bottom: 8px;
}

.server-card--featured .server-card__content {
  margin-bottom: 12px;
}

.server-card--featured .server-card__description {
  font-size: 13px;
  margin-bottom: 8px;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}

.server-card--featured .server-card__info {
  gap: 8px;
}

.server-card--featured .server-card__stats {
  gap: 12px;
}

.server-card--featured .stat-item {
  font-size: 12px;
}

.server-card--featured .btn--server-action {
  padding: 8px 12px;
  font-size: 13px;
}

.server-card__header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
}

.server-card__featured-badge {
  position: absolute;
  top: -8px;
  right: -8px;
  width: 24px;
  height: 24px;
  background: linear-gradient(135deg, #ffd700, #ffed4e);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--background-primary);
}

.featured-icon {
  width: 12px;
  height: 12px;
  color: var(--text-primary);
}

.server-card__status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.status-dot--online {
  background: #57f287;
  box-shadow: 0 0 6px rgba(87, 242, 135, 0.5);
}

.server-card__content {
  margin-bottom: 20px;
}

.server-card__name {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.server-card__description {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.7);
  line-height: 1.4;
  margin: 0 0 16px 0;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.server-card__info {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.server-card__stats {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.6);
}

.stat-icon {
  width: 14px;
  height: 14px;
  opacity: 0.7;
}

.server-card__owner {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  padding: 4px 6px;
  border-radius: 6px;
  margin: -4px -6px;
}

.server-card__owner:hover {
  background: rgba(255, 255, 255, 0.1);
  transform: translateX(2px);
}

.owner-name {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.8);
  font-weight: 500;
  transition: color 0.2s ease;
}

.server-card__owner:hover .owner-name {
  color: rgba(255, 255, 255, 0.95);
}

.server-card__actions {
  display: flex;
  justify-content: stretch;
}

.btn {
  flex: 1;
  padding: 12px 20px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 44px;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn--primary {
  background: linear-gradient(135deg, #5865f2, #4752c4);
  color: var(--text-primary);
}

.btn--primary:hover:not(:disabled) {
  background: linear-gradient(135deg, #4752c4, #3c45a5);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(88, 101, 242, 0.4);
}

.btn--danger {
  background: linear-gradient(135deg, #ed4245, #c73e41);
  color: var(--text-primary);
}

.btn--danger:hover:not(:disabled) {
  background: linear-gradient(135deg, #c73e41, #a33234);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(237, 66, 69, 0.4);
}

.btn-icon {
  width: 16px;
  height: 16px;
}

/* Mobile responsive */
@media (max-width: 768px) {
  .server-card {
    padding: 16px;
  }
  
  .server-card__stats {
    flex-direction: column;
    gap: 8px;
  }
  
  .server-card__info {
    gap: 8px;
  }
}
</style>
