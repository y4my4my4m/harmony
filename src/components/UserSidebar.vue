<template>
  <div class="user-sidebar" :class="{ 'sidebar-hidden': !props.visible }">
    <!-- Header Section -->
    <div class="sidebar-header">
      <div class="search-container">
        <div class="search-input-wrapper">
          <svg class="search-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M21.53 20.47l-3.66-3.66C19.195 15.24 20 13.214 20 11c0-4.97-4.03-9-9-9s-9 4.03-9 9 4.03 9 9 9c2.215 0 4.24-.804 5.808-2.13l3.66 3.66c.147.146.34.22.53.22s.385-.073.53-.22c.295-.293.295-.767.002-1.06zM3.5 11c0-4.135 3.365-7.5 7.5-7.5s7.5 3.365 7.5 7.5-3.365 7.5-7.5 7.5-7.5-3.365-7.5-7.5z"/>
          </svg>
          <input
            v-model="searchQuery"
            type="text"
            :placeholder="$t('server.searchMembersPlaceholder')"
            class="search-input"
          />
          <button 
            v-if="searchQuery"
            @click="searchQuery = ''"
            class="clear-search"
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Control Buttons -->
      <!-- <div class="control-buttons">
        <button 
          @click="toggleSidebar"
          class="control-btn"
          title="Toggle member list"
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 4v8l-2-2-2 2V4c0-1.1.9-2 2-2s2 .9 2 2zM4 18l4-4v3h8v2H8v3l-4-4z"/>
          </svg>
        </button>
        <button 
          @click="toggleServerSettings"
          class="control-btn"
          title="Server settings"
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/>
          </svg>
        </button>
        <button 
          @click="toggleRolesView"
          class="control-btn"
          title="Manage roles"
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12,2A3,3 0 0,1 15,5V7A3,3 0 0,1 12,10A3,3 0 0,1 9,7V5A3,3 0 0,1 12,2M12,4A1,1 0 0,0 11,5V7A1,1 0 0,0 12,8A1,1 0 0,0 13,7V5A1,1 0 0,0 12,4M21,14V20A2,2 0 0,1 19,22H5A2,2 0 0,1 3,20V14A2,2 0 0,1 5,12H19A2,2 0 0,1 21,14M19,16H5V20H19V16Z"/>
          </svg>
        </button>
      </div> -->

      <!-- Member Count -->
      <div class="member-count">
        {{ $t('server.membersCount', { count: totalMemberCount }) }}
      </div>
    </div>

    <!-- User Groups (virtualized) -->
    <div class="user-groups" ref="sidebarGroupsRef" v-if="props.visible">
      <div v-if="isLoadingUsers" class="loading-indicator">
        <div class="loading-spinner"></div>
        <span>{{ $t('server.loadingUsers') }}</span>
      </div>

      <div v-else-if="sidebarDisplayItems.length > 0" :style="{ height: `${sidebarTotalSize}px`, position: 'relative' }">
        <div
          v-for="virtualRow in sidebarVirtualRows"
          :key="sidebarDisplayItems[virtualRow.index].key"
          :data-index="virtualRow.index"
          :ref="sidebarMeasureElement"
          :style="{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${virtualRow.start}px)`
          }"
        >
          <template v-for="(item, _idx) in [sidebarDisplayItems[virtualRow.index]]" :key="_idx">
            <!-- Group header -->
            <button
              v-if="item.type === 'header'"
              @click="toggleGroup(item.groupKey!)"
              class="group-header"
              :class="{ 'group-collapsed': item.isCollapsed }"
            >
              <svg class="group-arrow" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/>
              </svg>
              <span class="group-title">
                <span v-if="item.roleColor" class="role-color-dot" :style="{ backgroundColor: item.roleColor }"></span>
                {{ item.title }} - {{ item.count }}
              </span>
            </button>

            <!-- User item -->
            <div
              v-else
              class="user-item"
              :class="{ 'offline-user': item.isOffline }"
              @click="handleUserItemClick(item.user!)"
              @contextmenu="handleUserContextMenu(item.user!, $event)"
              @touchstart.passive="handleUserTouchStart(item.user!, $event)"
              @touchend.passive="handleUserTouchEnd"
              @touchmove.passive="handleUserTouchMove"
              @touchcancel.passive="handleUserTouchEnd"
            >
              <Avatar
                :src="getUserAvatarUrl(item.user!.id).value"
                :alt="getUserDisplayName(item.user!.id).value || 'Unknown User'"
                size="sm"
                :status="getStatusForAvatarValue(item.user!.id)"
                class="user-avatar"
              />
              <div class="user-info">
                <div class="user-name-row">
                  <span
                    class="user-name"
                    :style="{ color: item.nameColor || getUserColor(item.user!.id).value || undefined }"
                  >
                    <DisplayName :user-id="item.user!.id" :truncate="true" />
                  </span>
                  <span
                    v-if="!isUserLocal(item.user!.id).value"
                    class="federation-badge"
                    :title="getUserDomain(item.user!.id).value ? `From ${getUserDomain(item.user!.id).value}` : 'Federated user'"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor" class="federation-icon">
                      <path d="M17.9,17.39C17.64,16.59 16.89,16 16,16H15V13A1,1 0 0,0 14,12H8V10H10A1,1 0 0,0 11,9V7H13A2,2 0 0,0 15,5V4.59C17.93,5.77 20,8.64 20,12C20,14.08 19.2,15.97 17.9,17.39M11,19.93C7.05,19.44 4,16.08 4,12C4,11.38 4.08,10.79 4.21,10.21L9,15V16A2,2 0 0,0 11,18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z"/>
                    </svg>
                  </span>
                  <span v-if="isUserInstanceAdmin(item.user!.id).value" class="instance-badge admin" title="Instance Admin">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
                  </span>
                  <span v-else-if="isUserInstanceMod(item.user!.id).value" class="instance-badge mod" title="Instance Moderator">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
                  </span>
                </div>
                <span
                  v-if="!isUserLocal(item.user!.id).value && getUserDomain(item.user!.id).value"
                  class="user-domain"
                >
                  {{ getUserDomain(item.user!.id).value }}
                </span>
                <!-- Custom status (full: with ActivityIcon, partial: no ActivityIcon, none: hidden) -->
                <div v-if="item.showStatus !== 'none' && hasCustomStatusToShow(item.user!.id)" class="user-custom-status">
                  <ActivityIcon
                    v-if="!getUserCustomStatus(item.user!.id).value?.emoji && item.showStatus === 'full' && getUserCustomStatus(item.user!.id).value?.type && getUserCustomStatus(item.user!.id).value?.type !== 'custom'"
                    :type="getUserCustomStatus(item.user!.id).value!.type"
                    :size="14"
                    class="status-activity-icon"
                  />
                  <img
                    v-if="getUserCustomStatus(item.user!.id).value?.emoji_url"
                    :src="getEmojiUrl(getUserCustomStatus(item.user!.id).value?.emoji_url, 20)"
                    :alt="getUserCustomStatus(item.user!.id).value?.emoji || 'Emoji'"
                    class="status-emoji-img"
                  />
                  <span v-else-if="getUserCustomStatus(item.user!.id).value?.emoji" class="status-emoji">
                    {{ getUserCustomStatus(item.user!.id).value?.emoji }}
                  </span>
                  <span v-if="getCustomStatusDisplay(item.user!.id)" class="status-text">{{ getCustomStatusDisplay(item.user!.id) }}</span>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Modern User Profile Modal -->
    <UserProfileModal 
      :show="showProfileModal" 
      :user="selectedUser" 
      @close="closeProfile"
      @invite="openInviteModal"
    />

    <!-- Invite Modal -->
    <InviteModal 
      :show="showInviteModal" 
      :server-id="serverChannelStore.currentServerId || undefined"
      :server-data="currentServerData || undefined"
      @close="closeInviteModal"
    />

    <!-- Discord-style context menu (right-click on desktop, long-press on mobile) -->
    <UserContextMenu
      :visible="contextMenuVisible"
      :user="contextMenuUser"
      :position="contextMenuPosition"
      @close="closeContextMenu"
      @action="handleContextAction"
    />

    <!--
      Kick/Ban modal opened directly from the context menu. UserProfileModal
      mounts its own copy of this modal too, so we keep them as separate
      instances driven by separate state - that way opening the profile
      modal while a kick/ban is in flight (or vice versa) doesn't clobber
      either flow.
    -->
    <KickBanModal
      v-if="kickBanMember && serverChannelStore.currentServerId"
      :show="showKickBanModal"
      :mode="kickBanMode"
      :user="kickBanMember"
      :server-id="serverChannelStore.currentServerId"
      @close="showKickBanModal = false"
      @done="handleKickBanDone"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { useRouter } from 'vue-router';
import { debug } from '@/utils/debug'
import type { User } from '@/types';
import UserProfileModal from '@/components/UserProfileModal.vue';
import UserContextMenu from '@/components/UserContextMenu.vue';
import KickBanModal from '@/components/moderation/KickBanModal.vue';
import InviteModal from './InviteModal.vue';
import Avatar from '@/components/common/Avatar.vue';
import DisplayName from '@/components/DisplayName.vue';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { useDMStore } from '@/stores/useDM';
import { authContextService } from '@/services/AuthContextService';
import { getUserIdsForServer} from '@/services/usersService';
import { UserStatus } from '@/types';
import { useUserData } from '@/composables/useUserData';
import { useLayoutState } from '@/composables/useLayoutState';
import { useHapticSettings } from '@/composables/useHapticSettings';
import { roleService, type ServerRole } from '@/services/RoleService';
import { formatCustomStatusDisplay } from '@/utils/customStatusDisplay';
import { getEmojiUrl } from '@/utils/emojiUtils';
import ActivityIcon from '@/components/ActivityIcon.vue';

// Props
interface Props {
  visible?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  visible: true
})

const serverChannelStore = useServerChannelStore();
const activityPubStore = useActivityPubStore();
const router = useRouter();
const { isMobile } = useLayoutState();
const { triggerInteraction } = useHapticSettings();

// Debug: Track duplicate calls
let fetchCallCounter = 0;

// Use new clean user data system - ONE source of truth
const { 
  getUserAvatarUrl,
  getUserDisplayName,
  getUserColor,
  getAllUsers,
  getUsersInContext,
  subscribeToContext,
  unsubscribeFromContext,
  isUserOnline,
  getUserStatus,
  isUserLocal,
  getUserDomain,
  getUserCustomStatus,
  getUserProfile,
  fetchUserProfile,
} = useUserData();

function getCustomStatusDisplay(userId: string): string {
  return formatCustomStatusDisplay(getUserCustomStatus(userId).value);
}

function hasCustomStatusToShow(userId: string): boolean {
  const s = getUserCustomStatus(userId).value;
  if (!s) return false;
  return !!(s.text || s.emoji || s.emoji_url || (s.type && s.type !== 'custom'));
}

const isUserInstanceAdmin = (userId: string) => computed(() => {
  const profile = getUserProfile(userId).value;
  return profile?.is_admin === true;
});

const isUserInstanceMod = (userId: string) => computed(() => {
  const profile = getUserProfile(userId).value;
  return profile?.is_moderator === true && !profile?.is_admin;
});

// Component state
const selectedUser = ref<User | null>(null);
const showProfileModal = ref(false);
const showInviteModal = ref(false);
const searchQuery = ref('');
const isLoadingUsers = ref(false);
const lastFetchedServerId = ref<string | null>(null);

// --- USER CONTEXT MENU (right-click on desktop, long-press on mobile) ---
const contextMenuVisible = ref(false);
const contextMenuUser = ref<User | null>(null);
const contextMenuPosition = ref({ x: 0, y: 0 });

// Kick/Ban modal (opened directly from the context menu so moderators
// don't have to detour through the full profile modal first).
const showKickBanModal = ref(false);
const kickBanMode = ref<'kick' | 'ban'>('kick');
/** Resolved member row for KickBanModal (snake_case fields the modal expects). */
const kickBanMember = ref<{
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
} | null>(null);

// Long-press tracking - mobile-only. We start a 500ms timer on
// touchstart and open the context menu when it fires. `longPressFired`
// suppresses the trailing synthetic `click` so we don't *also* open
// the profile modal underneath the menu.
const LONG_PRESS_DURATION = 500;
const LONG_PRESS_MOVE_TOLERANCE = 10; // pixels - finger jitter before we cancel
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressFired = false;
let longPressStartPos: { x: number; y: number } | null = null;

function clearLongPressTimer() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  longPressStartPos = null;
}

function openContextMenu(user: User, x: number, y: number) {
  contextMenuUser.value = user;
  contextMenuPosition.value = { x, y };
  contextMenuVisible.value = true;
}

function closeContextMenu() {
  contextMenuVisible.value = false;
  contextMenuUser.value = null;
}

function handleUserItemClick(user: User) {
  // Suppress click immediately after a long-press fired on mobile -
  // otherwise we'd open the profile modal under the context menu.
  if (longPressFired) {
    longPressFired = false;
    return;
  }
  showUserProfile(user);
}

function handleUserContextMenu(user: User, event: MouseEvent) {
  // On mobile, the browser may synthesize a contextmenu after a
  // long-press. We already handle long-press explicitly via the
  // touchstart timer, so swallow this synthetic event to avoid
  // opening two menus / fighting with text-selection callouts.
  event.preventDefault();
  if (isMobile.value) return;
  openContextMenu(user, event.clientX, event.clientY);
}

function handleUserTouchStart(user: User, event: TouchEvent) {
  if (!isMobile.value) return;
  const touch = event.touches[0];
  if (!touch) return;
  longPressStartPos = { x: touch.clientX, y: touch.clientY };
  longPressFired = false;
  clearLongPressTimer();
  longPressTimer = setTimeout(() => {
    longPressFired = true;
    triggerInteraction();
    openContextMenu(user, longPressStartPos!.x, longPressStartPos!.y);
    longPressTimer = null;
  }, LONG_PRESS_DURATION);
}

function handleUserTouchMove(event: TouchEvent) {
  if (!longPressTimer || !longPressStartPos) return;
  const touch = event.touches[0];
  if (!touch) return;
  const dx = Math.abs(touch.clientX - longPressStartPos.x);
  const dy = Math.abs(touch.clientY - longPressStartPos.y);
  // Cancel only on real drags; small finger jitter shouldn't kill the
  // long-press (otherwise resting fingers on phones never fires).
  if (dx > LONG_PRESS_MOVE_TOLERANCE || dy > LONG_PRESS_MOVE_TOLERANCE) {
    clearLongPressTimer();
  }
}

function handleUserTouchEnd() {
  clearLongPressTimer();
}

// --- CONTEXT MENU ACTIONS ---
// Each branch maps a context-menu emit to the same backing flow that
// UserProfileModal uses, so behaviour stays consistent whether the
// action is triggered from the profile or the context menu.
async function handleContextAction(action: string, user: User) {
  if (!user) return;

  switch (action) {
    case 'profile':
      await showUserProfile(user);
      break;
    case 'mention':
      dispatchMentionInsert(user);
      break;
    case 'message':
      await sendDirectMessage(user);
      break;
    case 'call':
      await startCallWithUser(user);
      break;
    case 'add-note':
      // The note input lives inside the profile modal - open it so the
      // user can type their note there.
      await showUserProfile(user);
      break;
    case 'change-nickname':
      // Server-nickname editing isn't a standalone modal yet; route to
      // the existing user settings page where profile fields live.
      router.push('/settings/profile');
      break;
    case 'invite':
      await openInviteForUser(user);
      break;
    case 'toggle-mute':
      await toggleMuteUser(user);
      break;
    case 'toggle-block':
      await toggleBlockUser(user);
      break;
    case 'kick':
      openKickBanModal(user, 'kick');
      break;
    case 'ban':
      openKickBanModal(user, 'ban');
      break;
    case 'copy-id':
      await copyUserId(user);
      break;
  }
}

/**
 * Dispatch a window-level event that ChatComponent listens for to
 * insert a mention into the current message input. UserSidebar is
 * rendered as a sibling of ChatComponent inside ChatLayout, so a
 * direct emit/prop chain would have to traverse two layout layers -
 * a CustomEvent keeps the wiring shallow and matches the existing
 * cross-component pattern used elsewhere in the app.
 */
function dispatchMentionInsert(user: User) {
  const username = user.username;
  if (!username) return;

  // Build a remote-aware handle so federated users get the proper
  // `@user@domain` form when inserted.
  const u: any = user;
  const isRemote = u.is_local === false || (u.domain && u.domain !== (import.meta.env.VITE_DOMAIN as string));
  const handle = isRemote && u.domain
    ? `${username}@${u.domain}`
    : username;

  window.dispatchEvent(new CustomEvent('harmony-insert-mention', {
    detail: { username, handle, userId: user.id },
  }));
}

async function sendDirectMessage(user: User) {
  // Mirrors UserProfileModal.sendDirectMessage so behaviour and edge
  // cases (find-existing-conversation, async profile lookup, etc.)
  // stay in lockstep.
  try {
    if (activityPubStore.isBlocked(user.id)) {
      debug.warn('Cannot send DM to blocked user');
      return;
    }

    const currentProfileId = await authContextService.getCurrentProfileId();
    if (!currentProfileId) {
      debug.error('Cannot send DM: no profile ID');
      return;
    }

    const dmStore = useDMStore();
    const existing = dmStore.conversations.find(c => c.other_user?.id === user.id);
    if (existing) {
      router.push(`/dm/${existing.id}`);
      return;
    }

    const conversationId = await dmStore.createOrGetConversation(currentProfileId, user.id);
    if (conversationId) {
      router.push(`/dm/${conversationId}`);
    } else {
      debug.error('Failed to create DM conversation');
    }
  } catch (err) {
    debug.error('Failed to open DM:', err);
  }
}

/**
 * Route to a DM and ask DMHeader to start a call. The actual call
 * setup (permissions check, signaling, voice join) lives in DMHeader
 * to avoid duplicating WebRTC / federation logic here - we just open
 * the DM and broadcast a `harmony-dm-start-call` event that DMHeader
 * listens for once the conversation is active.
 */
async function startCallWithUser(user: User) {
  try {
    if (activityPubStore.isBlocked(user.id)) return;

    const currentProfileId = await authContextService.getCurrentProfileId();
    if (!currentProfileId) return;

    const dmStore = useDMStore();
    let conversationId: string | null = null;
    const existing = dmStore.conversations.find(c => c.other_user?.id === user.id);
    if (existing) {
      conversationId = existing.id;
    } else {
      conversationId = await dmStore.createOrGetConversation(currentProfileId, user.id);
    }

    if (!conversationId) {
      debug.error('Failed to resolve DM conversation for call');
      return;
    }

    router.push(`/dm/${conversationId}`);
    // Defer the call-start dispatch until DMHeader has had a chance
    // to mount and subscribe to the event.
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('harmony-dm-start-call', {
        detail: { conversationId, callType: 'voice' as const },
      }));
    }, 350);
  } catch (err) {
    debug.error('Failed to start call:', err);
  }
}

async function openInviteForUser(user: User) {
  // InviteModal generates server invites - it doesn't take a target
  // user (the invite link can be sent to anyone), so we just open it
  // for the current server. When opened from the user sidebar we're
  // always inside a server context, but fall back to the profile
  // modal's server-picker UI just in case the menu is somehow
  // surfaced outside one.
  if (serverChannelStore.currentServerId) {
    showInviteModal.value = true;
  } else {
    await showUserProfile(user);
  }
}

async function toggleMuteUser(user: User) {
  try {
    if (activityPubStore.isMuted(user.id)) {
      await activityPubStore.unmuteUser(user.id);
    } else {
      await activityPubStore.muteUser(user.id);
    }
  } catch (err) {
    debug.error('Failed to toggle mute:', err);
  }
}

async function toggleBlockUser(user: User) {
  try {
    if (activityPubStore.isBlocked(user.id)) {
      await activityPubStore.unblockUser(user.id);
    } else {
      await activityPubStore.blockUser(user.id);
    }
  } catch (err) {
    debug.error('Failed to toggle block:', err);
  }
}

function openKickBanModal(user: User, mode: 'kick' | 'ban') {
  const u = user as User & { displayName?: string; avatarUrl?: string };
  kickBanMember.value = {
    id: user.id,
    username: user.username || getUserProfile(user.id).value?.username || '',
    display_name:
      getUserDisplayName(user.id).value
      || u.display_name
      || u.displayName
      || user.username
      || '',
    avatar_url: getUserAvatarUrl(user.id).value || u.avatar_url || u.avatarUrl || null,
  };
  kickBanMode.value = mode;
  showKickBanModal.value = true;
}

function handleKickBanDone() {
  showKickBanModal.value = false;
  kickBanMember.value = null;
}

async function copyUserId(user: User) {
  try {
    await navigator.clipboard.writeText(user.id);
    debug.log('User ID copied to clipboard:', user.id);
  } catch (err) {
    debug.error('Failed to copy user ID:', err);
  }
}

// Clean up any in-flight long-press timer when the component goes
// away (e.g. on server switch / route change) so we don't fire after
// the user list has unmounted.
onUnmounted(() => {
  clearLongPressTimer();
});

// Role-based member grouping (hoist feature)
const serverRoles = ref<ServerRole[]>([]);
const userRolesMap = ref<Map<string, ServerRole[]>>(new Map());
const rolesLoadedForServer = ref<string | null>(null);

// Group collapse state - dynamic based on roles
const collapsedGroups = ref<Record<string, boolean>>({
  online: false,
  away: false,
  busy: false,
  federated: false,
  offline: false // Start with offline collapsed
});

// Smart cached user data - shows cached data immediately, updates in background
const users = computed(() => {
  const serverId = serverChannelStore.currentServerId;
  if (!serverId) {
    return [];
  }
  
  // Get users from context first (this is our cached data)
  const contextUsers = getUsersInContext(serverId).value;
  
  // SMART CACHING: Only log when context changes significantly (not on every presence update)
  if (contextUsers.length > 0) {
    // userDataService stores camelCase (displayName, avatarUrl); normalize to the
    // legacy User shape so kick/ban modals and other snake_case consumers work.
    return contextUsers.map(userData => ({
      id: userData.id,
      username: userData.username,
      display_name: userData.displayName,
      avatar_url: userData.avatarUrl,
      status: userData.status,
    }));
  }
  
  // Only show loading state if we're actively loading and have no cached data
  if (isLoadingUsers.value) {
    return []; // Show loading spinner
  }
  
  // Fallback only if we have no context data and aren't loading
  const allUsers = getAllUsers.value;
  if (allUsers.length > 0) {
    debug.log(`🔄 UserSidebar: Using fallback data for server ${serverId}: ${allUsers.length} users`);
    
    // Convert to legacy format for compatibility
    return allUsers.map(userData => ({
      id: userData.id,
      username: userData.username,
      display_name: userData.displayName,
      avatar_url: userData.avatarUrl,
      status: userData.status
    }));
  }
  
  return [];
});

// Filter users based on search query
const filteredUsers = computed(() => {
  if (!searchQuery.value.trim()) {
    return users.value;
  }
  
  const query = searchQuery.value.toLowerCase();
  return users.value.filter((user: User) => {
    const displayName = getUserDisplayName(user.id).value.toLowerCase();
    const username = user.username?.toLowerCase() || '';
    return displayName.includes(query) || username.includes(query);
  });
});

// Get hoisted roles sorted by position (highest first)
const hoistedRolesSorted = computed(() => {
  return serverRoles.value
    .filter(r => r.hoist && !r.is_default)
    .sort((a, b) => b.position - a.position);
});

// Group users by hoisted roles first, then by presence status
// Users with hoisted roles appear in their highest hoisted role group (online users only)
// Users without hoisted roles appear in status groups (online, away, busy)
// Offline users and federated users appear in their respective groups
const groupedUsers = computed(() => {
  const groups: Record<string, User[]> = {
    online: [],
    away: [],
    busy: [],
    federated: [],
    offline: []
  };

  // Create groups for each hoisted role
  for (const role of hoistedRolesSorted.value) {
    groups[`role:${role.id}`] = [];
  }

  // Track which users have been placed in a role group
  const usersInRoleGroups = new Set<string>();

  filteredUsers.value.forEach((user: User) => {
    const isPresent = isUserOnline(user.id).value;
    const isLocal = isUserLocal(user.id).value;
    
    if (isPresent) {
      // Check if user has a hoisted role
      const highestHoistedRole = getHighestHoistedRole(user.id);
      
      if (highestHoistedRole) {
        // User has hoisted role - put them in the role group
        const roleGroupKey = `role:${highestHoistedRole.id}`;
        if (groups[roleGroupKey]) {
          groups[roleGroupKey].push(user);
          usersInRoleGroups.add(user.id);
        }
      } else {
        // No hoisted role - group by status
        const status = getUserStatus(user.id).value;
        switch (status) {
          case UserStatus.Online:
            groups.online.push(user);
            break;
          case UserStatus.Away:
            groups.away.push(user);
            break;
          case UserStatus.Busy:
            groups.busy.push(user);
            break;
          default:
            groups.online.push(user);
            break;
        }
      }
    } else {
      // User is not present
      if (!isLocal) {
        groups.federated.push(user);
      } else {
        groups.offline.push(user);
      }
    }
  });

  // Sort users within each group
  Object.values(groups).forEach(group => {
    group.sort((a, b) => {
      const nameA = getUserDisplayName(a.id).value.toLowerCase();
      const nameB = getUserDisplayName(b.id).value.toLowerCase();
      return nameA.localeCompare(nameB);
    });
  });

  return groups;
});

// Get the role info for a group key
// eslint-disable-next-line unused-imports/no-unused-vars
const getRoleForGroup = (groupKey: string): ServerRole | null => {
  if (!groupKey.startsWith('role:')) return null;
  const roleId = groupKey.replace('role:', '');
  return serverRoles.value.find(r => r.id === roleId) || null;
};

// Total member count
const totalMemberCount = computed(() => {
  return users.value.length;
});

// Current server data
const currentServerData = computed(() => {
  return serverChannelStore.currentServer;
});

// Methods
const toggleGroup = (groupName: string) => {
  collapsedGroups.value[groupName] = !collapsedGroups.value[groupName];
};

// Load server roles and user role assignments for hoist feature
const loadServerRolesAndAssignments = async (serverId: string) => {
  if (!serverId || rolesLoadedForServer.value === serverId) return;
  
  try {
    // Fetch all roles for the server
    const roles = await roleService.getServerRoles(serverId);
    serverRoles.value = roles;
    
    const hoistedRoles = roles.filter(r => r.hoist && !r.is_default);

    if (hoistedRoles.length > 0) {
      debug.log(`🎭 UserSidebar: Found ${hoistedRoles.length} hoisted roles for server ${serverId}`);

      const hoistedRoleIds = hoistedRoles.map(r => r.id);
      const roleMap = new Map(hoistedRoles.map(r => [r.id, r]));

      const assignments = await roleService.getRoleMembersForServer(serverId, hoistedRoleIds);
      const newUserRolesMap = new Map<string, ServerRole[]>();

      for (const assignment of assignments) {
        const role = roleMap.get(assignment.role_id);
        if (!role) continue;
        if (!newUserRolesMap.has(assignment.user_id)) {
          newUserRolesMap.set(assignment.user_id, []);
        }
        newUserRolesMap.get(assignment.user_id)!.push(role);
      }

      userRolesMap.value = newUserRolesMap;
      debug.log(`🎭 UserSidebar: Loaded role assignments for ${newUserRolesMap.size} users`);
    }
    
    rolesLoadedForServer.value = serverId;
  } catch (error) {
    debug.error('Failed to load server roles:', error);
  }
};

// Get highest hoisted role for a user
const getHighestHoistedRole = (userId: string): ServerRole | null => {
  const userRoles = userRolesMap.value.get(userId);
  if (!userRoles || userRoles.length === 0) return null;
  
  // Sort by position (highest first) and return first hoisted role
  const sorted = [...userRoles].sort((a, b) => b.position - a.position);
  return sorted.find(r => r.hoist) || null;
};

// --- VIRTUAL SCROLLING ---
interface SidebarItem {
  type: 'header' | 'user';
  key: string;
  groupKey?: string;
  title?: string;
  count?: number;
  roleColor?: string;
  isCollapsed?: boolean;
  user?: User;
  nameColor?: string | null;
  isOffline?: boolean;
  showStatus?: 'full' | 'partial' | 'none';
}

const sidebarGroupsRef = ref<HTMLDivElement | null>(null);

const sidebarDisplayItems = computed((): SidebarItem[] => {
  if (isLoadingUsers.value) return [];
  const items: SidebarItem[] = [];

  const addGroup = (
    groupKey: string,
    title: string,
    users: User[],
    opts: { roleColor?: string; nameColor?: string | null; isOffline?: boolean; showStatus?: 'full' | 'partial' | 'none' } = {}
  ) => {
    if (users.length === 0) return;
    const collapsed = !!collapsedGroups.value[groupKey];
    items.push({
      type: 'header', key: `h-${groupKey}`, groupKey, title,
      count: users.length, roleColor: opts.roleColor, isCollapsed: collapsed
    });
    if (!collapsed) {
      for (const user of users) {
        items.push({
          type: 'user', key: `u-${user.id}-${groupKey}`, groupKey, user,
          nameColor: opts.nameColor ?? null,
          isOffline: opts.isOffline ?? false,
          showStatus: opts.showStatus ?? 'full'
        });
      }
    }
  };

  for (const role of hoistedRolesSorted.value) {
    const roleUsers = groupedUsers.value[`role:${role.id}`] || [];
    addGroup(`role:${role.id}`, role.name, roleUsers, { roleColor: role.color || '#99AAB5', nameColor: role.color });
  }
  addGroup('online', 'Online', groupedUsers.value.online, { showStatus: 'full' });
  addGroup('away', 'Away', groupedUsers.value.away, { showStatus: 'partial' });
  addGroup('busy', 'Busy', groupedUsers.value.busy, { showStatus: 'none' });
  addGroup('federated', 'Federated', groupedUsers.value.federated, { showStatus: 'full' });
  addGroup('offline', 'Offline', groupedUsers.value.offline, { isOffline: true, showStatus: 'none' });

  return items;
});

const sidebarVirtualizer = useVirtualizer<HTMLElement, Element>(
  computed(() => ({
    count: sidebarDisplayItems.value.length,
    getScrollElement: () => sidebarGroupsRef.value,
    estimateSize: (index: number) => sidebarDisplayItems.value[index]?.type === 'header' ? 30 : 44,
    overscan: 10,
  })) as any
);

const sidebarVirtualRows = computed(() => sidebarVirtualizer.value.getVirtualItems());
const sidebarTotalSize = computed(() => sidebarVirtualizer.value.getTotalSize());

const sidebarMeasureElement = (el: any) => {
  if (!el || !(el instanceof HTMLElement)) return;
  sidebarVirtualizer.value.measureElement(el);
};

const fetchAndSetUsers = async (serverId: string | null) => {
  fetchCallCounter++;
  debug.log(`🔍 UserSidebar fetchAndSetUsers called (${fetchCallCounter} times) for server:`, serverId);
  
  if (serverId) {
    // DEBOUNCE: Prevent duplicate calls for the same server
    if (lastFetchedServerId.value === serverId && isLoadingUsers.value) {
      debug.log(`⏭️ UserSidebar: Already loading server ${serverId}, skipping duplicate call`);
      return;
    }
    
    lastFetchedServerId.value = serverId;
    
    // SMART CACHING: Check if we already have users for this server
    let users = getUsersInContext(serverId).value;
    
    if (users.length > 0) {
      debug.log(`💾 UserSidebar: Using cached users for server ${serverId} (${users.length} members)`);
      isLoadingUsers.value = false; // Ensure loading state is cleared
      return; // Use cached data, no loading needed
    }
    
    // Only show loading if we truly have no data for this server
    debug.log(`🔄 UserSidebar: No cached users found, loading for server ${serverId}...`);
    isLoadingUsers.value = true;
    
    try {
      // Wait briefly for BaseLayout to establish context (for initial app load)
      if (users.length === 0) {
        debug.log(`⏳ UserSidebar: Waiting for server context to be established...`);
        
        // Shorter wait time since we're being smarter about caching
        const maxWaitTime = 500; // 500ms max for server switches
        const checkInterval = 50; // Check every 50ms
        let waitTime = 0;
        
        while (users.length === 0 && waitTime < maxWaitTime) {
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          waitTime += checkInterval;
          users = getUsersInContext(serverId).value;
        }
        
        if (users.length > 0) {
          debug.log(`✅ UserSidebar: Server context ready after ${waitTime}ms wait`);
          return; // Found cached data during wait
        }
      }
      
      // No cached data available, create new subscription
      debug.log(`🆕 UserSidebar: Creating new subscription for server ${serverId}...`);
      const userIds = await getUserIdsForServer(serverId);
      await subscribeToContext(serverId, 'server', userIds);
      debug.log(`📋 Server user subscription ready: ${serverId} (${userIds.length} members)`);
    } finally {
      isLoadingUsers.value = false;
    }
  }
};

// Smart watcher for server changes - only triggers on actual server changes
watch(() => serverChannelStore.currentServerId, async (newServerId, oldServerId) => {
  // SMART CACHING: Only act on actual server changes
  if (newServerId === oldServerId) {
    return; // No change, skip
  }
  
  debug.log(`🔄 UserSidebar: Server changed from ${oldServerId} to ${newServerId}`);
  
  // INSTANT FEEDBACK: Clear loading state immediately if new server has cached data
  if (newServerId) {
    const cachedUsers = getUsersInContext(newServerId).value;
    if (cachedUsers.length > 0) {
      isLoadingUsers.value = false;
    }
  }
  
  if (oldServerId) {
    await unsubscribeFromContext(oldServerId);
    // Reset role data when leaving server
    rolesLoadedForServer.value = null;
    serverRoles.value = [];
    userRolesMap.value = new Map();
  }
  if (newServerId) {
    await fetchAndSetUsers(newServerId);
    // Load roles for hoist feature (non-blocking)
    loadServerRolesAndAssignments(newServerId);
  }
}, { immediate: true });

const showUserProfile = async (user: User) => {
  if (!user?.id) return;
  const fetched = getUserProfile(user.id).value || await fetchUserProfile(user.id, true).catch(() => null);
  selectedUser.value = (fetched || user) as User;
  showProfileModal.value = true;
};

// Helper to get status for avatar based on real-time presence
const getStatusForAvatarValue = (userId: string): 'online' | 'away' | 'busy' | 'offline' => {
  // First check if user is actually present
  const isPresent = isUserOnline(userId).value;
  
  if (!isPresent) {
    // User is not present - always show as offline
    return 'offline';
  }
  
  // User is present - return their preferred status
  const status = getUserStatus(userId).value;
  switch (status) {
    case UserStatus.Online:
      return 'online';
    case UserStatus.Away:
      return 'away';
    case UserStatus.Busy:
      return 'busy';
    default:
      // Present but status unknown - show as online
      return 'online';
  }
};

const closeProfile = () => {
  showProfileModal.value = false;
  selectedUser.value = null;
};

const openInviteModal = () => {
  showProfileModal.value = false;
  showInviteModal.value = true;
};

const closeInviteModal = () => {
  showInviteModal.value = false;
};

</script>

<style scoped>
/* Header Section */
.sidebar-header {
  padding: 16px 8px 8px 16px;
  border-bottom: 1px solid var(--border-color);
  background-color: var(--background-primary-alpha);
}

.search-container {
  margin-bottom: 8px;
}

.search-input-wrapper {
  position: relative;
  background-color: rgba(0, 0, 0, 0.1);
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  transition: border-color 0.15s ease;
}

.search-input-wrapper:focus-within {
  border-color: rgba(14, 165, 233, 0.6);
}

.search-input {
  width: 100%;
  background: transparent;
  border: none;
  padding: 8px 12px 8px 32px;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 400;
  outline: none;
}

.search-input::placeholder {
  color: var(--text-muted);
}

.search-icon {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  color: var(--text-muted);
  pointer-events: none;
}

.clear-search {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 2px;
  transition: color 0.15s ease;
}

.clear-search:hover {
  color: var(--text-secondary);
}

.clear-search svg {
  width: 12px;
  height: 12px;
}

/* Control Buttons */
.control-buttons {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}

.control-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 6px;
  border-radius: 4px;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
}

.control-btn:hover {
  background-color: rgba(255, 255, 255, 0.1);
  color: var(--text-secondary);
}

.control-btn:active {
  background-color: rgba(255, 255, 255, 0.06);
}

.control-btn svg {
  width: 16px;
  height: 16px;
}

.user-sidebar {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* Member Count */
.member-count {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  margin-top: 4px;
  text-align: center;
}

/* User Groups */
.user-groups {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px 8px 16px 8px;
  background-color: var(--background-primary-alpha);
}

.user-groups::-webkit-scrollbar {
  width: 8px;
}

.user-groups::-webkit-scrollbar-track {
  background: transparent;
}

.user-groups::-webkit-scrollbar-thumb {
  background-color: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}

.user-groups::-webkit-scrollbar-thumb:hover {
  background-color: rgba(255, 255, 255, 0.15);
}

.user-custom-status {
  opacity: 0.9;
  display: flex;
  align-items: center;
  gap: 4px;
}

.status-activity-icon {
  flex-shrink: 0;
}

.status-emoji {
  font-size: 14px;
  line-height: 1;
}

.status-emoji-img {
  width: 14px;
  height: 14px;
  object-fit: contain;
  flex-shrink: 0;
}

.status-text {
  font-size: 12px;
  color: var(--text-muted);
}

.offline-user {
  opacity: 0.3;
  transition: opacity 0.2s ease;
}

.offline-user:hover {
  opacity: 1.0;
}

/* Loading Indicator */
.loading-indicator {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  color: var(--text-secondary);
  font-size: 14px;
}

.loading-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid rgba(255, 255, 255, 0.1);
  border-left: 2px solid var(--accent-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 12px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.user-group {
  margin-bottom: 16px;
}

.user-group:last-child {
  margin-bottom: 0;
}

/* Group Headers */
.group-header {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 6px 8px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 4px;
  transition: color 0.15s ease;
  margin-bottom: 2px;
}

.group-header:hover {
  color: var(--text-secondary);
}

.group-title {
  flex: 1;
  display: flex;
  align-items: center;
  font-weight: bold;
  gap: 6px;
}

.role-color-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.role-group .group-header {
  color: var(--text-secondary);
}

.group-arrow {
  width: 12px;
  height: 12px;
  transition: transform 0.15s ease;
}

.group-collapsed .group-arrow {
  transform: rotate(-90deg);
}

.status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-left: 2px;
}

.status-indicator.online {
  background-color: #3ba55c;
}

.status-indicator.away {
  background-color: #faa61a;
}

.status-indicator.busy {
  background-color: #ed4245;
}

.status-indicator.offline {
  background-color: #747f8d;
}

.group-title {
  flex: 1;
}

/* User List */
.user-list {
  padding-left: 8px;
}

.user-item {
  display: flex;
  align-items: center;
  padding: 4px 8px;
  margin: 4px 0;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s ease;
  min-height: 42px;
  /* Long-press on mobile triggers our own context menu - suppress the
     native iOS callout/selection bubble that would otherwise compete
     with it. Touch action stays `manipulation` so quick taps still
     register and short scrolls in the list still work. */
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
  touch-action: manipulation;
}

.user-item:hover {
  background-color: rgba(255, 255, 255, 0.04);
}

.user-item:active {
  background-color: rgba(255, 255, 255, 0.02);
}

.user-avatar {
  margin-right: 12px;
  flex-shrink: 0;
}

.user-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.user-name-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.user-name {
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.25;
}

.federation-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  cursor: help;
}

.federation-icon {
  width: 12px;
  height: 12px;
  color: var(--accent-primary, #0EA5E9);
  opacity: 0.8;
  transition: opacity 0.15s ease;
}

.user-item:hover .federation-icon {
  opacity: 1;
}

.instance-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  margin-left: 0.25rem;
  flex-shrink: 0;
  color: color-mix(in srgb, var(--text-secondary) 30%, transparent);
  transition: color 0.15s ease, background 0.15s ease;
  padding: 0.125rem;
  border-radius: 0.1875rem;
}

.user-item:hover .instance-badge.admin,
.user-item:hover .instance-badge.mod {
  color: var(--text-primary);
  background: var(--harmony-secondary);
}

.user-domain {
  color: var(--text-muted, var(--text-muted));
  font-size: 11px;
  font-weight: 400;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.2;
  opacity: 0.7;
}

.user-activity {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 400;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.2;
}

/* Animation for collapsing groups */
.user-list {
  overflow: hidden;
  transition: max-height 0.2s ease;
}

/* Focus styles for accessibility */
.control-btn:focus-visible,
.group-header:focus-visible,
.user-item:focus-visible {
  outline: 2px solid #0EA5E9;
  outline-offset: 2px;
}

.search-input:focus {
  outline: none;
}

/* Responsive adjustments */
@media (max-width: 768px) {

  /* Enhanced mobile touch targets */
  .control-btn {
    min-height: 48px;
    padding: 12px 16px;
    border-radius: 12px;
    font-size: 16px;
  }

  .group-header {
    min-height: 48px;
    padding: 12px 16px;
    border-radius: 12px;
  }

  .user-item {
    min-height: 52px;
    padding: 8px 16px;
    border-radius: 12px;
    margin: 4px 8px;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .user-item:active {
    transform: scale(0.98);
    background: rgba(255, 255, 255, 0.08);
  }

  .search-input {
    font-size: 16px; /* Prevents zoom on iOS */
    padding: 12px 16px 12px 28px;
    border-radius: 12px;
  }

  .member-count {
    font-size: 14px;
    padding: 8px 16px;
  }
}

/* Dark theme specific adjustments */
:root[data-theme-type="dark"] .search-input-wrapper {
  background-color: rgba(0, 0, 0, 0.2);
}
</style>
