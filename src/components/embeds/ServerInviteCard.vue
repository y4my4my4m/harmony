<template>
  <article class="server-invite-card" :class="{ 'server-invite-card--loading': loading, 'server-invite-card--error': error }">
    <!-- Loading state -->
    <div v-if="loading" class="server-invite-card__skeleton">
      <div class="skeleton-icon"></div>
      <div class="skeleton-content">
        <div class="skeleton-title"></div>
        <div class="skeleton-meta"></div>
      </div>
    </div>
    
    <!-- Error state -->
    <div v-else-if="error" class="server-invite-card__error">
      <div class="error-icon">⚠️</div>
      <div class="error-content">
        <span class="error-title">Invalid Invite</span>
        <span class="error-message">{{ error }}</span>
      </div>
    </div>
    
    <!-- Server invite content -->
    <template v-else-if="serverData">
      <div class="server-invite-card__icon">
        <img 
          v-if="hasCustomIcon" 
          :src="serverData.icon_url" 
          :alt="serverData.name"
          class="server-image"
        />
        <div v-else class="default-server-icon">
          {{ serverInitial }}
        </div>
      </div>
      
      <div class="server-invite-card__content">
        <h4 class="server-name">{{ serverData.name }}</h4>
        <div class="server-meta">
          <span v-if="serverData.online_count !== undefined" class="online-count">
            <span class="online-dot"></span>
            {{ serverData.online_count }} Online
          </span>
          <span class="member-count">
            <span class="member-icon">👥</span>
            {{ serverData.member_count || '?' }} Members
          </span>
        </div>
        <div v-if="serverData.description" class="server-description">
          {{ serverData.description }}
        </div>
      </div>
      
      <div class="server-invite-card__actions">
        <button 
          v-if="!isJoined && !isJoining"
          class="join-button"
          @click="handleJoin"
          :disabled="isJoining"
        >
          Join Server
        </button>
        <button 
          v-else-if="isJoined"
          class="joined-button"
          @click="handleGoToServer"
        >
          Go to Server
        </button>
        <div v-else class="joining-spinner">
          <span class="spinner"></span>
          Joining...
        </div>
      </div>

      <InviteAcceptModal
        :show="showAcceptModal"
        :server-name="serverData?.name || ''"
        :description="serverData?.description"
        :member-count="serverData?.member_count || 0"
        :icon-url="hasCustomIcon ? serverData?.icon_url : null"
        :banner-url="bannerUrl"
        :joining="isJoining"
        @close="showAcceptModal = false"
        @accept="handleAcceptConfirmed"
      />

      <ServerRulesModal
        :show="showRules"
        :server-name="serverData?.name || ''"
        :server-rules="serverRules"
        :instance-rules="pendingInstanceRules"
        :instance-name="instanceName"
        :joining="isJoining"
        @close="showRules = false"
        @agree="confirmJoin"
      />
    </template>
  </article>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { debug } from '@/utils/debug'
import { useToast } from 'vue-toastification';
import { useAuthStore } from '@/stores/auth';
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings';
import { getInviteInfo, type InviteInfo } from '@/services/inviteService';
import { useInviteJoin } from '@/composables/useInviteJoin';
import { getServerIconUrl, getServerBannerUrl } from '@/utils/serverUtils';
import ServerRulesModal from '@/components/invite/ServerRulesModal.vue';
import InviteAcceptModal from '@/components/invite/InviteAcceptModal.vue';

const props = defineProps<{
  inviteCode: string;
  inviteUrl: string;
}>();

const emit = defineEmits<{
  (e: 'joined', serverId: string): void;
}>();

const toast = useToast();
const authStore = useAuthStore();
const instanceSettings = useInstanceSettingsStore();

const loading = ref(true);
const error = ref<string | null>(null);
const info = ref<InviteInfo | null>(null);
const isJoined = ref(false);
const showAcceptModal = ref(false);

const {
  isJoining,
  showRules,
  serverRules,
  pendingInstanceRules,
  requestJoin,
  confirmJoin,
  openServer,
} = useInviteJoin(info, {
  onJoined: (serverId) => {
    isJoined.value = true;
    emit('joined', serverId);
  },
});

const instanceName = computed(() => instanceSettings.settings.instanceName);

// template-compat view over the shared InviteInfo shape
const serverData = computed(() => {
  if (!info.value) return null;
  return {
    name: info.value.serverName,
    icon_url: info.value.icon ? getServerIconUrl(info.value.icon) : undefined,
    description: info.value.description ?? undefined,
    member_count: info.value.memberCount,
    online_count: undefined as number | undefined,
    server_id: info.value.serverId,
  };
});

const serverInitial = computed(() => {
  return serverData.value?.name?.charAt(0).toUpperCase() || 'S';
});

// Check if server has a custom icon (not the default fallback)
const hasCustomIcon = computed(() => {
  const iconUrl = serverData.value?.icon_url;
  return iconUrl && iconUrl !== '/default_server.webp';
});

async function loadInviteData() {
  loading.value = true;
  error.value = null;

  const { info: resolved, error: resolveError } = await getInviteInfo(props.inviteCode);
  if (resolveError || !resolved) {
    error.value = resolveError || 'Failed to load invite details';
    loading.value = false;
    return;
  }

  info.value = resolved;
  isJoined.value = resolved.isMember;
  loading.value = false;
  debug.log('🎫 Invite info loaded:', resolved);
}

const bannerUrl = computed(() =>
  info.value?.banner ? getServerBannerUrl(info.value.banner, { width: 960, height: 540 }) : null
);

// Join is a two-step consent: card button opens the invite panel, Accept there
// runs the shared pipeline (which may add the rules step)
function handleJoin() {
  if (!authStore.session?.user?.id) {
    toast.warning('Please log in to join servers');
    return;
  }
  showAcceptModal.value = true;
}

function handleAcceptConfirmed() {
  showAcceptModal.value = false;
  requestJoin();
}

function handleGoToServer() {
  if (info.value) void openServer(info.value.serverId);
}

onMounted(() => {
  loadInviteData();
});

watch(() => props.inviteCode, () => {
  loadInviteData();
});
</script>

<style scoped>
.server-invite-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: linear-gradient(135deg, #2a2d35 0%, #1e2024 100%);
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  margin: 8px 0;
  max-width: 420px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.server-invite-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
}

/* Icon */
.server-invite-card__icon {
  flex-shrink: 0;
}

.server-image {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  object-fit: cover;
}

.default-server-icon {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: linear-gradient(135deg, #0EA5E9 0%, #38BDF8 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}

/* Content */
.server-invite-card__content {
  flex: 1;
  min-width: 0;
}

.server-name {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.server-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
  font-size: 13px;
  color: #a0a0a0;
}

.online-count {
  display: flex;
  align-items: center;
  gap: 4px;
}

.online-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #3ba55c;
  box-shadow: 0 0 8px rgba(59, 165, 92, 0.5);
}

.member-count {
  display: flex;
  align-items: center;
  gap: 4px;
}

.member-icon {
  font-size: 12px;
}

.server-description {
  margin-top: 6px;
  font-size: 13px;
  color: var(--text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Actions */
.server-invite-card__actions {
  flex-shrink: 0;
}

.join-button {
  padding: 10px 20px;
  background: linear-gradient(135deg, #3ba55c 0%, #2d8049 100%);
  color: var(--text-primary);
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 2px 8px rgba(59, 165, 92, 0.3);
}

.join-button:hover:not(:disabled) {
  background: linear-gradient(135deg, #45c066 0%, #3ba55c 100%);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(59, 165, 92, 0.4);
}

.join-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.joined-button {
  padding: 10px 20px;
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-secondary);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.joined-button:hover {
  background: rgba(255, 255, 255, 0.15);
  border-color: rgba(255, 255, 255, 0.2);
}

.joining-spinner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  color: #a0a0a0;
  font-size: 14px;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-top-color: #3ba55c;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Loading skeleton */
.server-invite-card--loading {
  pointer-events: none;
}

.server-invite-card__skeleton {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.skeleton-icon {
  width: 56px;
  height: 56px;
  border-radius: 16px;
}

.skeleton-content {
  flex: 1;
}

.skeleton-title {
  width: 140px;
  height: 18px;
  border-radius: 4px;
  margin-bottom: 8px;
}

.skeleton-meta {
  width: 100px;
  height: 14px;
  border-radius: 4px;
}

.skeleton-icon,
.skeleton-title,
.skeleton-meta {
  background-color: #3a3d45;
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.04) 50%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.8s ease-in-out infinite;
}

@keyframes shimmer {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}

/* Error state */
.server-invite-card--error {
  border-color: rgba(237, 66, 69, 0.3);
  background: linear-gradient(135deg, #2d2024 0%, #1e1a1c 100%);
}

.server-invite-card__error {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.error-icon {
  font-size: 24px;
}

.error-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.error-title {
  font-size: 14px;
  font-weight: 600;
  color: #ed4245;
}

.error-message {
  font-size: 13px;
  color: #a0a0a0;
}
</style>

