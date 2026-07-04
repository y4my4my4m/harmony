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
    </template>
  </article>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { debug } from '@/utils/debug'
import { useRouter } from 'vue-router';
import { useToast } from 'vue-toastification';
import { supabase } from '@/supabase';
import { useAuthStore } from '@/stores/auth';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { acceptInvite } from '@/services/inviteService';
import { getServerIconUrl } from '@/utils/serverUtils';

interface ServerInviteData {
  name: string;
  icon_url?: string;
  description?: string;
  member_count?: number;
  online_count?: number;
  server_id?: string;
}

const props = defineProps<{
  inviteCode: string;
  inviteUrl: string;
}>();

const emit = defineEmits<{
  (e: 'joined', serverId: string): void;
}>();

const router = useRouter();
const toast = useToast();
const authStore = useAuthStore();
const serverStore = useServerChannelStore();

const loading = ref(true);
const error = ref<string | null>(null);
const serverData = ref<ServerInviteData | null>(null);
const isJoining = ref(false);
const isJoined = ref(false);

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
  
  debug.log('🎫 Loading invite data for code:', props.inviteCode);
  
  try {
    // Step 1: Fetch invite details via SECURITY DEFINER RPC (post-20260520).
    // Direct `from('invites').select('*').eq('code', ...)` is blocked for
    // non-owners by the tightened RLS; the RPC returns one row by code.
    const { data: inviteRows, error: inviteError } = await supabase
      .rpc('lookup_invite_by_code', { p_code: props.inviteCode });

    const invite = Array.isArray(inviteRows) ? inviteRows[0] : null;
    debug.log('🎫 Invite query result:', { invite, inviteError });

    if (inviteError || !invite) {
      debug.error('🎫 Invite fetch error:', inviteError);
      error.value = 'Invite not found or has expired';
      return;
    }

    if (invite.used) {
      error.value = 'This invite has already been used';
      return;
    }

    if (invite.expires_at && new Date() > new Date(invite.expires_at)) {
      error.value = 'This invite has expired';
      return;
    }

    // Step 2: Fetch server details separately
    // Note: The column is 'icon' not 'icon_url' - it stores a relative path
    const { data: server, error: serverError } = await supabase
      .from('servers')
      .select('id, name, icon, description')
      .eq('id', invite.server_id)
      .single();

    debug.log('🎫 Server query result:', { server, serverError });

    if (serverError || !server) {
      debug.error('🎫 Server fetch error:', serverError);
      error.value = 'Server not found';
      return;
    }

    // Step 3: Get member count (use centralized service with caching)
    const { getServerMemberCount, isUserMemberOfServer } = await import('@/services/serverMembershipService')
    const memberCount = await getServerMemberCount(server.id);

    // Step 4: Check if current user is already a member (use centralized service)
    // BUGS.md Pattern A v2: `user_servers.user_id` references `profiles(id)`,
    // so `isUserMemberOfServer` must be called with the profile id, not the
    // auth UUID. Previously this always returned `false`, so the "Already
    // a member" pill never showed up for users who actually were members.
    if (authStore.session?.user?.id) {
      try {
        const { authContextService } = await import('@/services/AuthContextService');
        const profileId = await authContextService.getCurrentProfileId();
        const isMember = await isUserMemberOfServer(profileId, server.id);
        isJoined.value = isMember;
      } catch (err) {
        debug.warn('🎫 Could not check member status:', err);
      }
    }

    const iconUrl = getServerIconUrl(server.icon);
    
    serverData.value = {
      name: server.name,
      icon_url: iconUrl,
      description: server.description,
      member_count: memberCount || 0,
      server_id: server.id
    };
    
    debug.log('🎫 Server data loaded:', serverData.value);
  } catch (err) {
    debug.error('🎫 Error loading invite:', err);
    error.value = 'Failed to load invite details';
  } finally {
    loading.value = false;
  }
}

async function handleJoin() {
  if (!authStore.session?.user?.id) {
    toast.warning('Please log in to join servers');
    return;
  }

  isJoining.value = true;

  // BUGS.md Pattern A: acceptInvite inserts into `user_servers.user_id`
  // which references `profiles(id)`. Pass profile id, not auth UUID.
  let profileId: string;
  try {
    const { authContextService } = await import('@/services/AuthContextService');
    profileId = await authContextService.getCurrentProfileId();
  } catch (err) {
    debug.error('Failed to resolve profile id for invite join:', err);
    toast.error('Could not join - please try again.');
    isJoining.value = false;
    return;
  }

  try {
    const result = await acceptInvite(props.inviteCode, profileId);
    
    if (result.success && result.serverId) {
      isJoined.value = true;
      toast.success(`Joined ${serverData.value?.name}!`);
      emit('joined', result.serverId);
      
      // Refresh server list - `fetchServersForUser` filters by
      // `user_servers.user_id` (profile FK), so we pass profile id.
      // BUGS.md Pattern A v2.
      await serverStore.fetchServersForUser(profileId);
    } else {
      toast.error(result.error || 'Failed to join server');
    }
  } catch (err) {
    debug.error('Error joining server:', err);
    toast.error('Failed to join server');
  } finally {
    isJoining.value = false;
  }
}

async function handleGoToServer() {
  if (serverData.value?.server_id) {
    serverStore.setCurrentServer(serverData.value.server_id);
    
    await serverStore.fetchCategoriesAndChannels(serverData.value.server_id);
    
    const defaultChannel = serverStore.getDefaultChannel();
    
    if (defaultChannel) {
      // Navigate to the server with its default channel
      router.push(`/chat/${serverData.value.server_id}/${defaultChannel}`);
    } else {
      // Fallback: just go to chat and let the app figure it out
      router.push('/chat');
    }
  }
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

