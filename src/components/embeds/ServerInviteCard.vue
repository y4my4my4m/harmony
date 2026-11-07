<template>
  <InviteCardLayout
    :state="loading ? 'loading' : error || !serverData ? 'error' : 'ready'"
    :label="serverData ? t('embeds.invite.label', { name: serverData.name }) : undefined"
    :name="serverData?.name"
    :icon-url="hasCustomIcon ? serverData?.icon_url : null"
    :description="serverData?.description"
    :member-count="serverData?.member_count ?? null"
    :online-count="serverData?.online_count ?? null"
    :error-message="error"
    :action="isJoined ? 'open' : isJoining ? 'joining' : 'join'"
    @join="handleJoin"
    @open="handleGoToServer"
  >
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
  </InviteCardLayout>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { debug } from '@/utils/debug'
import { useToast } from 'vue-toastification';
import { useAuthStore } from '@/stores/auth';
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings';
import { getInviteInfo, type InviteInfo } from '@/services/inviteService';
import { useInviteJoin } from '@/composables/useInviteJoin';
import { serverMonogramUrl } from '@/utils/serverMonogram';
import { getServerIconUrl, getServerBannerUrl } from '@/utils/serverUtils';
import { devicePixels } from '@/utils/imageTransformUtils';
import ServerRulesModal from '@/components/invite/ServerRulesModal.vue';
import InviteAcceptModal from '@/components/invite/InviteAcceptModal.vue';
import InviteCardLayout from './InviteCardLayout.vue';

const props = defineProps<{
  inviteCode: string;
  inviteUrl: string;
}>();

const emit = defineEmits<{
  (e: 'joined', serverId: string): void;
}>();

const { t } = useI18n();
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
    // 56px on the card, 72px in InviteAcceptModal.
    icon_url: info.value.icon ? getServerIconUrl(info.value.icon, devicePixels(72)) : serverMonogramUrl(info.value.serverName) ?? undefined,
    description: info.value.description ?? undefined,
    member_count: info.value.memberCount,
    online_count: info.value.onlineCount ?? undefined,
    server_id: info.value.serverId,
  };
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
  debug.log('Invite info loaded:', resolved);
}

// BaseModal draws the banner under a 24px blur.
const bannerUrl = computed(() =>
  info.value?.banner ? getServerBannerUrl(info.value.banner, { width: 480, height: 270 }) : null
);

// Join is a two-step consent: card button opens the invite panel, Accept there
// runs the shared pipeline (which may add the rules step)
function handleJoin() {
  if (!authStore.session?.user?.id) {
    toast.warning('Log in to join servers');
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
