<template>
  <div class="invite-accept" :style="backdropStyle" data-testid="invite-accept" :data-state="pageState">
    <div class="invite-accept__scrim"></div>

    <!-- Loading -->
    <div v-if="status === 'loading'" class="invite-card" aria-busy="true">
      <h1 class="sr-only">{{ t('a11y.title.invite') }}</h1>
      <LoadingSpinner :size="36" aria-hidden="true" />
      <p class="invite-card__muted">{{ t('invite.loading') }}</p>
    </div>

    <!-- Error -->
    <div v-else-if="status === 'error'" class="invite-card">
      <div class="invite-card__error-icon" aria-hidden="true">
        <Icon name="x" :size="28" />
      </div>
      <h1 class="invite-card__title">{{ t('invite.invalidTitle') }}</h1>
      <p class="invite-card__muted">{{ errorMessage }}</p>
      <button type="button" class="invite-btn primary" @click="$router.push('/chat')">
        {{ t('common.back') }}
      </button>
    </div>

    <!-- Invite preview -->
    <div v-else-if="info" class="invite-card" :aria-busy="isJoining || undefined">
      <div class="invite-card__icon" aria-hidden="true">
        <img
          v-if="iconUrl && !iconLoadError"
          :src="iconUrl"
          alt=""
          @error="iconLoadError = true"
        />
        <span v-else class="invite-card__icon-fallback">{{ serverInitial }}</span>
      </div>

      <p class="invite-card__muted">
        {{ info.isMember ? t('invite.alreadyMember') : t('invite.invitedToJoin') }}
      </p>
      <h1 class="invite-card__title">{{ info.serverName }}</h1>

      <div class="invite-card__meta">
        <span class="meta-dot" aria-hidden="true"></span>
        <span>{{ info.memberCount }} {{ info.memberCount === 1 ? t('invite.member') : t('invite.members') }}</span>
      </div>

      <p v-if="info.description" class="invite-card__description">{{ info.description }}</p>

      <button
        v-if="info.isMember"
        type="button"
        class="invite-btn primary"
        data-testid="invite-open-server"
        @click="openServer(info.serverId)"
      >
        {{ t('invite.openServer') }}
      </button>
      <!-- aria-disabled, not disabled: focus stays on the button while joining and returns to it when the rules dialog closes. -->
      <button
        v-else
        type="button"
        class="invite-btn primary"
        :aria-disabled="isJoining || undefined"
        :aria-busy="isJoining || undefined"
        data-testid="invite-accept-button"
        @click="requestJoin"
      >
        {{ isJoining ? t('invite.joining') : t('invite.accept') }}
      </button>

      <button
        v-if="!info.isMember"
        type="button"
        class="invite-btn ghost"
        :aria-disabled="isJoining || undefined"
        data-testid="invite-decline-button"
        @click="decline"
      >
        {{ t('invite.noThanks') }}
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
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { getInviteInfo, type InviteInfo } from '@/services/inviteService';
import { useAuthStore } from '@/stores/auth';
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings';
import { useInviteJoin } from '@/composables/useInviteJoin';
import { getServerIconUrl, getServerBannerUrl } from '@/utils/serverUtils';
import { withRenderFallback } from '@/utils/renderFallback';
import { devicePixels } from '@/utils/imageTransformUtils';
import { debug } from '@/utils/debug';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import Icon from '@/components/common/Icon.vue';
import ServerRulesModal from '@/components/invite/ServerRulesModal.vue';
import { useAnnouncer } from '@/composables/useAnnouncer';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const instanceSettings = useInstanceSettingsStore();
const { t } = useI18n();
const { polite, assertive } = useAnnouncer();

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

/** loading | error | preview | member | rules | joining; mirrored on data-state. */
const pageState = computed(() => {
  if (status.value !== 'ready' || !info.value) return status.value;
  if (isJoining.value) return 'joining';
  if (showRules.value) return 'rules';
  return info.value.isMember ? 'member' : 'preview';
});

// Loading, preview and joining are spoken through the announcer: the card is
// replaced wholesale, so a live region inside it would mount with its text.
watch(
  pageState,
  (state, previous) => {
    const server = info.value?.serverName ?? '';
    if (state === 'loading') polite(t('invite.loading'));
    else if (state === 'error') assertive(`${t('invite.invalidTitle')}. ${errorMessage.value}`);
    else if (state === 'preview' && previous !== 'rules' && previous !== 'joining') {
      polite(t('invite.a11y.preview', { server }));
    } else if (state === 'member') polite(t('invite.a11y.member', { server }));
    else if (state === 'joining') polite(t('invite.a11y.joining', { server }));
  },
  { immediate: true },
);

function decline() {
  if (isJoining.value) return;
  void router.push('/chat');
}
const serverInitial = computed(() => info.value?.serverName?.charAt(0).toUpperCase() || 'S');
const iconUrl = computed(() => (info.value?.icon ? getServerIconUrl(info.value.icon, devicePixels(80)) : null));

// Backdrop under an 8px blur.
const backdropStyle = computed(() => {
  const banner = info.value?.banner ? withRenderFallback(getServerBannerUrl(info.value.banner, { width: 640, height: 360 })) : null;
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
  background: var(--background-primary);
  background-size: cover;
  background-position: center;
}

.invite-accept__scrim {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--background-primary) 78%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
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
  border-radius: var(--radius-xl);
  background: var(--background-quinary);
  border: 1px solid var(--border-primary);
  box-shadow: var(--shadow-large);
  text-align: center;
}

.invite-card__icon {
  width: 80px;
  height: 80px;
  border-radius: var(--radius-2xl);
  overflow: hidden;
  margin-bottom: 4px;
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
  background: var(--harmony-primary-fill);
  font-size: 32px;
  font-weight: 700;
  color: var(--text-on-primary);
}

.invite-card__muted {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.invite-card__title {
  margin: 0;
  font-size: var(--font-size-2xl);
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
  background: var(--text-muted);
}

.invite-card__description {
  margin: 0;
  font-size: var(--font-size-sm);
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
  background: color-mix(in srgb, var(--error) 15%, transparent);
  color: var(--text-danger);
}

.invite-btn {
  width: 100%;
  padding: 12px 20px;
  border: none;
  border-radius: var(--radius-md);
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.2s ease, color 0.2s ease;
}

.invite-btn.primary {
  margin-top: 8px;
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
}

.invite-btn.primary:hover:not(:disabled, [aria-disabled='true']) {
  background: var(--harmony-primary-hover);
}

.invite-btn.primary:disabled,
.invite-btn.primary[aria-disabled='true'] {
  opacity: 0.6;
  cursor: not-allowed;
}

.invite-btn.ghost[aria-disabled='true'] {
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
