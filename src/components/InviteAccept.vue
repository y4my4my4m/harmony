<template>
  <div class="invite-accept" :style="backdropStyle">
    <div class="invite-accept__scrim"></div>

    <!-- Loading -->
    <div v-if="status === 'loading'" class="invite-card">
      <LoadingSpinner :size="36" />
      <p class="invite-card__muted">{{ t('invite.loading', 'Loading invite…') }}</p>
    </div>

    <!-- Error -->
    <div v-else-if="status === 'error'" class="invite-card">
      <div class="invite-card__error-icon">
        <Icon name="x" :size="28" />
      </div>
      <h2 class="invite-card__title">{{ t('invite.invalidTitle', 'Invite invalid') }}</h2>
      <p class="invite-card__muted">{{ errorMessage }}</p>
      <button class="invite-btn primary" @click="$router.push('/chat')">
        {{ t('common.back') }}
      </button>
    </div>

    <!-- Invite preview -->
    <div v-else-if="info" class="invite-card">
      <div class="invite-card__icon">
        <img
          v-if="iconUrl && !iconLoadError"
          :src="iconUrl"
          :alt="info.serverName"
          @error="iconLoadError = true"
        />
        <span v-else class="invite-card__icon-fallback">{{ serverInitial }}</span>
      </div>

      <p class="invite-card__muted">
        {{ info.isMember
          ? t('invite.alreadyMember', "You're already a member of")
          : t('invite.invitedToJoin', "You've been invited to join") }}
      </p>
      <h2 class="invite-card__title">{{ info.serverName }}</h2>

      <div class="invite-card__meta">
        <span class="meta-dot"></span>
        <span>{{ info.memberCount }} {{ info.memberCount === 1 ? t('invite.member', 'Member') : t('invite.members', 'Members') }}</span>
      </div>

      <p v-if="info.description" class="invite-card__description">{{ info.description }}</p>

      <button
        v-if="info.isMember"
        class="invite-btn primary"
        @click="openServer(info.serverId)"
      >
        {{ t('invite.openServer', 'Open Server') }}
      </button>
      <button
        v-else
        class="invite-btn primary"
        :disabled="isJoining"
        @click="requestJoin"
      >
        {{ isJoining ? t('invite.joining', 'Joining…') : t('invite.accept', 'Accept Invite') }}
      </button>

      <button v-if="!info.isMember" class="invite-btn ghost" @click="$router.push('/chat')">
        {{ t('invite.noThanks', 'No Thanks') }}
      </button>
    </div>

    <ServerRulesModal
      :show="showRules"
      :server-name="info?.serverName || ''"
      :server-rules="serverRules"
      :instance-rules="pendingInstanceRules"
      :instance-name="instanceName"
      :joining="isJoining"
      @close="showRules = false"
      @agree="confirmJoin"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { getInviteInfo, type InviteInfo } from '@/services/inviteService';
import { useAuthStore } from '@/stores/auth';
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings';
import { useInviteJoin } from '@/composables/useInviteJoin';
import { getServerIconUrl, getServerBannerUrl } from '@/utils/serverUtils';
import { debug } from '@/utils/debug';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import Icon from '@/components/common/Icon.vue';
import ServerRulesModal from '@/components/invite/ServerRulesModal.vue';

const route = useRoute();
const authStore = useAuthStore();
const instanceSettings = useInstanceSettingsStore();
const { t } = useI18n();

const status = ref<'loading' | 'error' | 'ready'>('loading');
const errorMessage = ref('');
const info = ref<InviteInfo | null>(null);
const iconLoadError = ref(false);

const {
  isJoining,
  showRules,
  serverRules,
  pendingInstanceRules,
  requestJoin,
  confirmJoin,
  openServer,
} = useInviteJoin(info, {
  onJoined: (serverId) => void openServer(serverId),
});

const instanceName = computed(() => instanceSettings.settings.instanceName);
const serverInitial = computed(() => info.value?.serverName?.charAt(0).toUpperCase() || 'S');
const iconUrl = computed(() => (info.value?.icon ? getServerIconUrl(info.value.icon, 160) : null));

const backdropStyle = computed(() => {
  const banner = info.value?.banner ? getServerBannerUrl(info.value.banner, { width: 1280, height: 720 }) : null;
  return banner ? { backgroundImage: `url(${banner})` } : undefined;
});

onMounted(async () => {
  const code = route.params.code as string;
  if (!code) {
    status.value = 'error';
    errorMessage.value = t('invite.noCode');
    return;
  }

  if (!authStore.session?.user?.id) {
    status.value = 'error';
    errorMessage.value = t('invite.notLoggedIn');
    return;
  }

  const { info: resolved, error } = await getInviteInfo(code);
  if (error || !resolved) {
    debug.warn('Invite resolution failed:', error);
    status.value = 'error';
    errorMessage.value = error || t('invite.failed');
    return;
  }

  info.value = resolved;
  status.value = 'ready';
});
</script>

<style scoped>
.invite-accept {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px;
  background: var(--background-primary, #1a1a2e);
  background-size: cover;
  background-position: center;
}

.invite-accept__scrim {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--background-primary, #1a1a2e) 78%, transparent);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
}

.invite-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  width: 100%;
  max-width: 420px;
  padding: 40px 32px 28px;
  border-radius: 16px;
  background: var(--background-quinary, #16213e);
  border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.08));
  box-shadow: 0 25px 50px rgba(0, 0, 0, 0.5);
  text-align: center;
}

.invite-card__icon {
  width: 80px;
  height: 80px;
  border-radius: 22px;
  overflow: hidden;
  margin-bottom: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.invite-card__icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.invite-card__icon-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, var(--harmony-primary, #0ea5e9), var(--harmony-primary-hover, #38bdf8));
  font-size: 32px;
  font-weight: 700;
  color: var(--text-primary);
}

.invite-card__muted {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
}

.invite-card__title {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.invite-card__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
}

.meta-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted, #80848e);
}

.invite-card__description {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.invite-card__error-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: rgba(237, 66, 69, 0.15);
  color: #ed4245;
}

.invite-btn {
  width: 100%;
  padding: 12px 20px;
  border: none;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.invite-btn.primary {
  margin-top: 8px;
  background: linear-gradient(135deg, var(--harmony-primary, #0ea5e9), var(--harmony-primary-hover, #0284c7));
  color: var(--text-primary);
}

.invite-btn.primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 6px 16px rgba(14, 165, 233, 0.35);
}

.invite-btn.primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.invite-btn.ghost {
  background: transparent;
  color: var(--text-secondary);
  font-weight: 500;
  padding: 8px;
}

.invite-btn.ghost:hover {
  color: var(--text-primary);
  text-decoration: underline;
}
</style>
