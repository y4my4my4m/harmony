<template>
  <div class="server-sidebar" data-testid="server-sidebar">
    <!-- Fixed header; does not scroll -->
    <div class="fixed-header">

      <div
        class="portal"
        role="button"
        tabindex="0"
        aria-label="Harmony Portal"
        @click="openPublicServers"
        @keydown.enter.prevent="openPublicServers"
        @keydown.space.prevent="openPublicServers"
        @mouseenter="showSidebarTooltip($event, 'Harmony Portal'); schedulePortalPrefetch()"
        @mouseleave="hideSidebarTooltip(); cancelServerPrefetch()"
        @focus="schedulePortalPrefetch"
        @blur="cancelServerPrefetch"
      >
      <span class="portal-icon" aria-hidden="true"></span>
      </div>

      <!-- Today button; gated by the Advanced settings flag -->
      <div
        v-if="todayDashboardEnabled"
        class="header-item-wrapper"
        @mouseenter="showSidebarTooltip($event, 'Today')"
        @mouseleave="hideSidebarTooltip"
      >
        <div class="server-pill" :class="{ 'visible': isTodaySelected }"></div>
        <div
          class="dm-button today-button"
          :class="{ 'selected': isTodaySelected }"
          role="button"
          tabindex="0"
          aria-label="Today"
          :aria-current="isTodaySelected ? 'page' : undefined"
          @click="goToToday"
          @keydown.enter.prevent="goToToday"
          @keydown.space.prevent="goToToday"
        >
          <svg viewBox="0 0 24 24" class="dm-icon">
            <path d="M12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,2L14.39,5.42C13.65,5.15 12.84,5 12,5C11.16,5 10.35,5.15 9.61,5.42L12,2M3.34,7L7.5,6.65C6.9,7.16 6.36,7.78 5.94,8.5C5.5,9.24 5.25,10 5.11,10.79L3.34,7M3.36,17L5.12,13.23C5.26,14 5.53,14.78 5.95,15.5C6.37,16.24 6.91,16.86 7.5,17.37L3.36,17M20.65,7L18.88,10.79C18.74,10 18.47,9.23 18.05,8.5C17.63,7.78 17.1,7.15 16.5,6.64L20.65,7M20.64,17L16.5,17.36C17.09,16.85 17.62,16.22 18.04,15.5C18.46,14.77 18.73,14 18.87,13.21L20.64,17M12,22L9.59,18.56C10.33,18.83 11.14,19 12,19C12.82,19 13.63,18.83 14.37,18.56L12,22Z" fill="currentColor"/>
          </svg>
        </div>
      </div>
      <!-- <div
        class="portal"
        @click="openPublicServers"
        @mouseenter="showSidebarTooltip($event, 'Harmony Portal')"
        @mouseleave="hideSidebarTooltip"
      >
        <svg fill="#FFF" width="24px" height="24px" viewBox="0 0 24 24" role="img" xmlns="http://www.w3.org/2000/svg"><path d="M6.353 0v2.824H4.94v2.823H3.53v2.824H2.118v2.823H.706v2.824h8.47v2.823H7.765v2.824H6.353v2.823h1.412v-1.412h1.411v-1.411h1.412v-1.412H12V16.94h1.412v-1.41h1.412v-1.411h1.411v-1.412h1.412v-1.412h1.412V9.882h1.412V8.471h1.411V7.059h-4.235V5.647h1.412V4.235h1.412V2.824h1.411V1.412h1.412V0zm0 22.588H4.94V24h1.412zM7.765 2.824h9.882v1.411h-1.412v1.412h-1.411V7.06h-1.412v1.41H12v1.411h1.412v1.412H12V9.882h-1.412v1.412H9.176V9.882H7.765v1.412H6.353V9.882H4.94V8.471h1.412V5.647h1.412zM6.353 8.47v1.411h1.412v-1.41zm2.823 1.411h1.412v-1.41H9.176zm5.648 0h1.411v1.412h-1.411z"/></svg>
      </div> -->
      <div
        class="header-item-wrapper"
        @mouseenter="showSidebarTooltip($event, 'Direct messages')"
        @mouseleave="hideSidebarTooltip"
      >
        <div class="server-pill" :class="{ 'visible': isDMSelected, 'has-unread': dmUnreadMentions > 0 && !isDMSelected }"></div>
        <div
          class="dm-button"
          :class="{ 'selected': isDMSelected }"
          role="button"
          tabindex="0"
          aria-label="Direct messages"
          :aria-current="isDMSelected ? 'page' : undefined"
          @click="goToDMs"
          @keydown.enter.prevent="goToDMs"
          @keydown.space.prevent="goToDMs"
        >
          <svg viewBox="0 0 24 24" class="dm-icon">
            <path d="M20,2H4A2,2 0 0,0 2,4V22L6,18H20A2,2 0 0,0 22,16V4A2,2 0 0,0 20,2M4,4H20V16H5.17L4,17.17V4Z" fill="currentColor"/>
          </svg>
          <div v-if="dmUnreadMentions > 0" class="unread-badge">
            {{ dmUnreadMentions > 99 ? '99+' : dmUnreadMentions }}
          </div>
        </div>
      </div>

      <div
        class="header-item-wrapper"
        @mouseenter="showSidebarTooltip($event, 'Fediverse')"
        @mouseleave="hideSidebarTooltip"
      >
        <div class="server-pill" :class="{ 'visible': isFediverseSelected, 'has-unread': unreadCount > 0 && !isFediverseSelected }"></div>
        <div
          class="fediverse-button"
          :class="{ 'selected': isFediverseSelected }"
          role="button"
          tabindex="0"
          aria-label="Fediverse"
          :aria-current="isFediverseSelected ? 'page' : undefined"
          @click="goToFediverse"
          @keydown.enter.prevent="goToFediverse"
          @keydown.space.prevent="goToFediverse"
        >
          <div class="fediverse-icon">#</div>
          <div v-if="unreadCount > 0" class="unread-badge">
            {{ unreadCount > 99 ? '99+' : unreadCount }}
          </div>
        </div>
      </div>

      <div class="separator"></div>
    </div>

    <ServerRail
      :servers="servers"
      @select-server="selectServer"
      @hover-server="scheduleServerPrefetch"
      @leave-server="cancelServerPrefetch"
      @tooltip="showRailTooltip"
      @tooltip-hide="hideSidebarTooltip"
      @invite="openInvite"
      @edit-folder="openEditFolderModal"
    >
      <!-- Phone widths only. Last child of the list; a drag over it lands at the end. -->
      <template #end>
        <div v-if="showFundingButton" class="funding-item-wrapper">
          <button
            type="button"
            class="funding-button"
            aria-label="Instance funding"
            @click="showFundingModal = true"
            @mouseenter="showSidebarTooltip($event, 'Instance funding')"
            @mouseleave="hideSidebarTooltip"
          >
            <svg viewBox="0 0 24 24" class="funding-icon" width="22" height="22" aria-hidden="true">
              <path fill="currentColor" d="M12,21.35L10.55,20.03C5.4,15.36 2,12.27 2,8.5C2,5.41 4.42,3 7.5,3C9.24,3 10.91,3.81 12,5.08C13.09,3.81 14.76,3 16.5,3C19.58,3 22,5.41 22,8.5C22,12.27 18.6,15.36 13.45,20.03L12,21.35Z"/>
            </svg>
          </button>
        </div>
      </template>
    </ServerRail>

    <ServerFolderSettingsModal
      :is-open="showFolderModal"
      :folder="editingFolder"
      @close="closeFolderModal"
    />

    <!-- Opened from the server context menu -->
    <InviteModal
      :show="showInviteModal"
      :server-id="inviteServer?.id"
      :server-data="inviteServer || undefined"
      @close="showInviteModal = false"
    />

    <div v-if="updateReady" class="fixed-footer">
      <div class="separator"></div>
      <button
        type="button"
        class="update-ready-button"
        :aria-label="updateReadyLabel"
        @click="openUpdatePrompt"
        @mouseenter="showSidebarTooltip($event, updateReadyLabel)"
        @mouseleave="hideSidebarTooltip"
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path fill="currentColor" d="M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z"/>
        </svg>
      </button>
    </div>

    <FundingModal v-if="showFundingModal" @close="showFundingModal = false" />
  </div>
  
  <!-- Teleported to body; the sidebar clips overflow -->
  <Teleport to="body">
    <Transition name="tooltip-fade">
      <div 
        v-if="sidebarTooltipVisible && sidebarTooltip"
        class="sidebar-tooltip"
        :style="{ top: sidebarTooltipY + 'px' }"
      >
        <div class="sidebar-tooltip-content">
          <span class="sidebar-tooltip-name">{{ sidebarTooltip.name }}</span>
          <span v-if="sidebarTooltip.serverCount" class="sidebar-tooltip-count">
            {{ t('serverRail.folder.serverCount', { count: sidebarTooltip.serverCount }, sidebarTooltip.serverCount) }}
          </span>
        </div>
        <div class="sidebar-tooltip-arrow"></div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { usePublicServersStore } from '@/stores/usePublicServers';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { useNotificationStore } from '@/stores/useNotification';
import { isActivityPubRoute } from '@/types/viewTypes';
import ServerRail from '@/components/serverRail/ServerRail.vue';
import { provideRailContext } from '@/components/serverRail/railState';
import ServerFolderSettingsModal from '@/components/ServerFolderSettingsModal.vue';
import InviteModal from '@/components/InviteModal.vue';
import FundingModal from '@/components/FundingModal.vue';
import { useFundingStore } from '@/stores/useFunding';
import { useTodayDashboard } from '@/composables/useTodayDashboard';
import { useViewport } from '@/composables/useViewport';
import { useAnchoredTooltip } from '@/composables/useAnchoredTooltip';
import { useDesktopUpdater } from '@/composables/useDesktopUpdater';
import { useI18n } from 'vue-i18n';
import type { Server, ServerFolder as ServerFolderType } from '@/types';

defineProps<{
  servers: Server[];
}>();

const emit = defineEmits<{
  (e: 'show-public-servers'): void;
  (e: 'switch-to-activitypub'): void;
  (e: 'switch-to-chat'): void;
}>();

const showFundingModal = ref(false);

const fundingStore = useFundingStore();
const { isMobileViewport, isTouchOnly } = useViewport();
const showFundingButton = computed(() => !!fundingStore.config?.enabled && isMobileViewport.value);

const { t } = useI18n();
const { state: updaterState, isReady: updateReady, openUpdatePrompt } = useDesktopUpdater();
const updateReadyLabel = computed(() =>
  t('updater.indicatorLabel', { version: updaterState.availableVersion ?? '' }),
);

const {
  visible: sidebarTooltipVisible,
  y: sidebarTooltipY,
  payload: sidebarTooltip,
  show: showAnchoredTooltip,
  showFor: showAnchoredTooltipFor,
  hide: hideSidebarTooltip,
} = useAnchoredTooltip<{ name: string; serverCount?: number }>();

const showInviteModal = ref(false);
const inviteServer = ref<Server | null>(null);

const openInvite = (server: Server) => {
  inviteServer.value = server;
  showInviteModal.value = true;
};

const showFolderModal = ref(false);
const editingFolder = ref<ServerFolderType | null>(null);

const serverChannelStore = useServerChannelStore();
const publicServersStore = usePublicServersStore();
const activityPubStore = useActivityPubStore();
const { todayDashboardEnabled } = useTodayDashboard();
const notificationStore = useNotificationStore();
const router = useRouter();
const route = useRoute();

const isDMSelected = computed(() => {
  return route.name === 'DM' || route.name === 'DMHome' || route.name === 'DMConversation';
});

const isTodaySelected = computed(() => route.name === 'Today');

const isFediverseSelected = computed(() => {
  return isActivityPubRoute(route.name as string);
});

// Globe badge counts `activitypub_mention` only. /social/mentions is driven by
// that type (useActivityPub.loadMentionedPosts), so visiting the page drives
// the badge to zero. Counting other AP types - follows, reblogs, favorites,
// replies - strands the badge, since nothing reachable from it clears them.
// Other AP notifications surface in the bell-icon panel.
const unreadCount = computed(() => notificationStore.notificationCounts?.unreadMentions ?? 0);

const dmUnreadMentions = computed(() => notificationStore.unreadDMs ?? 0);

const activeServerId = computed(() => {
  if (isDMSelected.value || isFediverseSelected.value || isTodaySelected.value) return null;
  return serverChannelStore.currentServerId;
});

provideRailContext({ activeServerId });

onMounted(() => {
  void fundingStore.load()
})

const openPublicServers = () => {
  cancelServerPrefetch();
  emit('show-public-servers');
};

// A pointer resting this long on a server is treated as intent; shorter rests
// are travel across the rail.
const SERVER_PREFETCH_DELAY_MS = 100;
let serverPrefetchTimer: ReturnType<typeof setTimeout> | null = null;

/** Warms the structure and the default channel's newest page for a hovered or focused server. */
const prefetchServer = async (serverId: string) => {
  if (serverId === serverChannelStore.currentServerId) return;
  await serverChannelStore.prefetchServerStructure(serverId);
  const channelId = serverChannelStore.defaultChannelFor(serverId);
  if (!channelId) return;
  const { useChatStore } = await import('@/stores/useChat');
  void useChatStore().prefetchChannelMessages(channelId);
};

const scheduleServerPrefetch = (serverId: string) => {
  cancelServerPrefetch();
  serverPrefetchTimer = setTimeout(() => {
    serverPrefetchTimer = null;
    void prefetchServer(serverId);
  }, SERVER_PREFETCH_DELAY_MS);
};

/** Warms the Discover list so the portal opens on cached data. */
const schedulePortalPrefetch = () => {
  cancelServerPrefetch();
  serverPrefetchTimer = setTimeout(() => {
    serverPrefetchTimer = null;
    void publicServersStore.fetchPublicServers();
  }, SERVER_PREFETCH_DELAY_MS);
};

const cancelServerPrefetch = () => {
  if (serverPrefetchTimer) {
    clearTimeout(serverPrefetchTimer);
    serverPrefetchTimer = null;
  }
};

onBeforeUnmount(cancelServerPrefetch);

const selectServer = async (serverId?: string) => {
  cancelServerPrefetch();
  if (!serverId) return;

  emit('switch-to-chat');

  // setCurrentServer synchronously swaps in this server's cached channel
  // structure (or clears it), so the previous server's channels never linger.
  serverChannelStore.setCurrentServer(serverId);

  const hasCachedStructure =
    serverChannelStore._loadedCategoriesServerId === serverId &&
    serverChannelStore.channels.length > 0;

  if (hasCachedStructure) {
    // Instant path: navigate immediately off the snapshot, refresh behind it.
    const defaultChannelId = serverChannelStore.getDefaultChannel();
    if (defaultChannelId) {
      router.push({ name: 'ChatChannel', params: { serverId, channelId: defaultChannelId } });
    } else {
      router.push({ name: 'Chat' });
    }
    void serverChannelStore.revalidateServerStructure(serverId);
    return;
  }

  // First visit: the structure is already cleared - also clear the message
  // pane and land on the bare chat route, so no stale content shows.
  const { useChatStore } = await import('@/stores/useChat');
  useChatStore().clearMessages();
  router.push({ name: 'Chat' });

  await serverChannelStore.fetchCategoriesAndChannels(serverId);

  // The user may have clicked another server while this one loaded.
  if (serverChannelStore.currentServerId !== serverId) return;

  const defaultChannelId = serverChannelStore.getDefaultChannel();
  if (defaultChannelId) {
    router.push({
      name: 'ChatChannel',
      params: {
        serverId: serverId,
        channelId: defaultChannelId
      }
    });
  }
};

const goToDMs = () => {
  emit('switch-to-chat');
  router.push({ name: 'DMHome' });
};

const goToToday = () => {
  router.push({ name: 'Today' });
};

const goToFediverse = () => {
  activityPubStore.clearUnreadCount();
  emit('switch-to-activitypub');
  router.push({ name: 'SocialHome' });
};

// Route change hides the tooltip; mouseleave does not fire reliably on mobile
watch(() => route.fullPath, () => {
  hideSidebarTooltip();
});

const showSidebarTooltip = (event: MouseEvent, name: string, serverCount?: number) => {
  if (isTouchOnly) return;
  showAnchoredTooltip(event, { name: name || t('serverRail.unnamedServer'), serverCount });
};

const showRailTooltip = (anchor: HTMLElement, name: string, serverCount?: number) => {
  if (isTouchOnly) return;
  showAnchoredTooltipFor(anchor, { name: name || t('serverRail.unnamedServer'), serverCount });
};

const openEditFolderModal = (folder: ServerFolderType) => {
  editingFolder.value = folder;
  showFolderModal.value = true;
};

const closeFolderModal = () => {
  showFolderModal.value = false;
  editingFolder.value = null;
};
</script>

<style scoped>
.server-sidebar {
  width: 72px;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.fixed-header {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
}

.fixed-footer {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  padding-bottom: 8px;
}

/* Box mirrors .server-item-wrapper: 10px margin, 2px vertical padding. */
.funding-item-wrapper {
  flex-shrink: 0;
  margin: 10px;
  padding: 2px 0;
}

.funding-button {
  width: 48px;
  height: 48px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--background-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.2s ease, border-radius 0.2s ease;
}

.funding-button:hover,
.funding-button:focus-visible {
  background: var(--harmony-primary);
  border-radius: 16px;
}

.funding-icon {
  color: var(--text-secondary);
  transition: color 0.2s;
}

.funding-button:hover .funding-icon,
.funding-button:focus-visible .funding-icon {
  color: var(--text-on-primary);
}

.update-ready-button {
  width: 48px;
  height: 48px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--background-secondary);
  color: var(--success);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.2s ease, border-radius 0.2s ease, color 0.2s ease;
  margin-top: 4px;
}

.update-ready-button:hover,
.update-ready-button:focus-visible {
  background: var(--success);
  color: var(--text-on-primary);
  border-radius: 16px;
}

/* Mirrors .server-item-wrapper */
.header-item-wrapper {
  position: relative;
  margin: 10px;
}

/* PNG is white-on-black; the mask drops the black box and leaves the bear
   shape tintable with theme icon colors. */
.portal-icon {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  background-color: var(--nav-rail-button-icon, var(--icon-primary));
  mask-image: url('/img/app_icon_badge.png');
  mask-size: contain;
  mask-repeat: no-repeat;
  mask-position: center;
  -webkit-mask-image: url('/img/app_icon_badge.png');
  -webkit-mask-size: contain;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-position: center;
  transition: background-color 0.2s ease;
}

.portal:hover .portal-icon {
  background-color: var(--text-on-primary);
}

.dm-button {
  width: 48px;
  height: 48px;
  background-color: var(--nav-rail-button-bg, var(--background-secondary));
  color: var(--nav-rail-button-icon, var(--icon-primary));
  padding: 4px;
  border-radius: 12px;
  cursor: pointer;
  position: relative;
  transition: background 0.2s ease-in-out, border-radius 0.2s ease-in-out, transform 0.2s ease-in-out;
  border: 3px solid transparent;
  background-origin: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
}

.dm-icon {
  width: 24px;
  height: 24px;
  transition: color 0.2s ease;
}

.dm-button:hover {
  background: var(--harmony-primary, var(--harmony-primary-hover));
}

.dm-button:hover .dm-icon {
  color: var(--text-on-primary);
}

.dm-button.selected {
  background: var(--harmony-primary, var(--harmony-primary-hover));
  border-radius: 50%;
}

.dm-button.selected .dm-icon {
  color: var(--text-on-primary);
}

.fediverse-button {
  width: 48px;
  height: 48px;
  background-color: var(--nav-rail-button-bg, var(--background-secondary));
  padding: 4px;
  border-radius: 12px;
  cursor: pointer;
  position: relative;
  transition: background 0.2s ease-in-out, border-radius 0.2s ease-in-out, transform 0.2s ease-in-out;
  border: 3px solid transparent;
  background-origin: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
}

.fediverse-icon {
  font-size: 24px;
  font-weight: bold;
  color: var(--nav-rail-button-icon, var(--icon-primary));
  font-family: var(--font-family);
  transition: color 0.2s ease;
}

.fediverse-button:hover {
  background: var(--harmony-primary, var(--harmony-primary-hover));
}

.fediverse-button.selected {
  background: var(--harmony-primary, var(--harmony-primary-hover));
  border-radius: 50%;
}
.fediverse-button:hover .fediverse-icon,
.fediverse-button.selected .fediverse-icon {
  color: var(--text-on-primary);
}

.unread-badge {
  position: absolute;
  top: -8px;
  right: -8px;
  background: var(--error);
  color: var(--text-on-primary);
  font-size: 10px;
  font-weight: bold;
  padding: 2px 6px;
  border-radius: 10px;
  min-width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

.portal {
  width: 48px;
  height: 48px;
  background-color: var(--background-secondary);
  margin: 0;
  border-radius: 50%;
  cursor: pointer;
  position: relative;
  left: 0;
  transition: border 0.6s ease-in-out, all 0.2s ease-in-out;
  background-origin: content-box;
  background-position: center;
  background-size: cover;
}

.portal {
  width: 48px;
  height: 48px;
  background-color: var(--nav-rail-button-bg, var(--background-secondary));
  margin: 10px 10px 5px 10px;
  transition: background 0.2s ease-in-out;
  padding: 4px;
  border-radius: 50%;
  text-align: center;
  vertical-align: middle;
  cursor: pointer;
  position: relative;
  left: 0;
  transition: border 0.6s ease-in-out, all 0.2s ease-in-out;
  border: 3px solid transparent;
  background-origin: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
}
.portal:hover {
  background: var(--harmony-primary);
}

.separator {
  position: relative;
  width: 80%;
  border-top: 1px solid var(--border-secondary);
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 5px;
}

.server-pill {
  position: absolute;
  left: -12px;
  top: 50%;
  transform: translateY(-50%);
  width: 4px;
  height: 0;
  background: var(--text-primary);
  border-radius: 0 4px 4px 0;
  opacity: 0;
  transition: all 0.15s ease;
}

.server-pill.visible {
  opacity: 1;
  height: 36px;
}

.server-pill.has-unread {
  opacity: 1;
  height: 8px;
}

.header-item-wrapper:hover .server-pill {
  opacity: 1;
  height: 20px;
}

.header-item-wrapper:hover .server-pill.visible {
  height: 36px;
}

.sidebar-tooltip {
  position: fixed;
  left: 80px;
  transform: translateY(-50%);
  background: var(--tooltip-bg);
  border-radius: var(--radius-md);
  padding: 6px 14px;
  box-shadow: var(--shadow-small);
  z-index: 1001;
  pointer-events: none;
  white-space: nowrap;
}

.sidebar-tooltip-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sidebar-tooltip-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--tooltip-text, var(--text-primary));
}

.sidebar-tooltip-count {
  font-size: 12px;
  color: var(--tooltip-text);
  opacity: 0.9;
}

.sidebar-tooltip-arrow {
  position: absolute;
  left: -6px;
  top: 50%;
  transform: translateY(-50%);
  width: 0;
  height: 0;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  border-right: 6px solid var(--tooltip-arrow);
}

.tooltip-fade-enter-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.tooltip-fade-leave-active {
  transition: opacity 0.1s ease, transform 0.1s ease;
}

.tooltip-fade-enter-from {
  opacity: 0;
  transform: translateY(-50%) translateX(-5px);
}

.tooltip-fade-leave-to {
  opacity: 0;
  transform: translateY(-50%) translateX(-5px);
}

.tooltip-fade-enter-to,
.tooltip-fade-leave-from {
  opacity: 1;
  transform: translateY(-50%) translateX(0);
}
</style>

<!-- Non-scoped styles for teleported tooltip -->
<style>
.sidebar-tooltip {
  position: fixed;
  left: 80px;
  transform: translateY(-50%);
  background: var(--tooltip-bg);
  border-radius: var(--radius-md);
  padding: 6px 14px;
  box-shadow: var(--shadow-small);
  z-index: 10001;
  pointer-events: none;
  white-space: nowrap;
}

.sidebar-tooltip-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sidebar-tooltip-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--tooltip-text, var(--text-primary));
}

.sidebar-tooltip-count {
  font-size: 12px;
  color: var(--tooltip-text);
  opacity: 0.9;
}

.sidebar-tooltip-arrow {
  position: absolute;
  left: -6px;
  top: 50%;
  transform: translateY(-50%);
  width: 0;
  height: 0;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  border-right: 6px solid var(--tooltip-arrow);
}
</style>
