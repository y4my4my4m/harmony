<template>
  <!--
    Discord-style user context menu — opened by right-click (desktop) or
    long-press (mobile) on a user in the member list. Only renders items
    the app actually supports; emits high-level events that the parent
    wires to existing flows (UserProfileModal, KickBanModal, InviteModal,
    activityPub store, etc.) so we don't reimplement those actions here.
  -->
  <Teleport to="body">
    <div
      v-if="visible"
      class="user-context-menu-backdrop"
      @click="close"
      @contextmenu.prevent="close"
      @touchstart.passive="close"
    />
    <div
      v-if="visible"
      ref="menuRef"
      class="user-context-menu"
      :style="menuStyle"
      role="menu"
      @click.stop
      @contextmenu.prevent
    >
      <!-- Profile -->
      <button class="menu-item" role="menuitem" @click="emitAction('profile')">
        <span class="menu-item-label">Profile</span>
      </button>

      <!-- Mention -->
      <button
        v-if="canMention"
        class="menu-item"
        role="menuitem"
        @click="emitAction('mention')"
      >
        <span class="menu-item-label">Mention</span>
      </button>

      <!-- Send Message (local users only, not self, not blocked) -->
      <button
        v-if="canMessage"
        class="menu-item"
        role="menuitem"
        @click="emitAction('message')"
      >
        <span class="menu-item-label">Message</span>
      </button>

      <!-- Start a Call (local users only, not self, not blocked) -->
      <button
        v-if="canCall"
        class="menu-item"
        role="menuitem"
        @click="emitAction('call')"
      >
        <span class="menu-item-label">Start a Call</span>
      </button>

      <!-- Add Note (just opens the profile modal where the note section lives) -->
      <!-- TEMPORARILY HIDDEN: notes feature is shelved (see UserProfileModal). Restore once notes ship.
      <button
        v-if="!isSelf"
        class="menu-item with-subtitle"
        role="menuitem"
        @click="emitAction('add-note')"
      >
        <div class="menu-item-label">Add Note</div>
        <div class="menu-item-subtitle">Only visible to you</div>
      </button>
      -->

      <!-- Change Server Nickname (own profile, in server) — uses Edit Profile flow -->
      <button
        v-if="canEditOwnProfile"
        class="menu-item"
        role="menuitem"
        @click="emitAction('change-nickname')"
      >
        <span class="menu-item-label">Change Nickname</span>
      </button>

      <div v-if="hasAnyMidSectionItem" class="menu-divider"></div>

      <!-- Invite to Server -->
      <button
        v-if="canInvite"
        class="menu-item"
        role="menuitem"
        @click="emitAction('invite')"
      >
        <span class="menu-item-label">Invite to Server</span>
      </button>

      <!-- Mute / Unmute (Ignore in Discord) -->
      <button
        v-if="!isSelf"
        class="menu-item"
        role="menuitem"
        @click="emitAction('toggle-mute')"
      >
        <span class="menu-item-label">{{ isMuted ? 'Unignore' : 'Ignore' }}</span>
      </button>

      <!-- Block / Unblock -->
      <button
        v-if="!isSelf"
        class="menu-item destructive"
        role="menuitem"
        @click="emitAction('toggle-block')"
      >
        <span class="menu-item-label">{{ isBlocked ? 'Unblock' : 'Block' }}</span>
      </button>

      <!-- Moderation section: only render when there's something to show -->
      <template v-if="canKick || canBan">
        <div class="menu-divider"></div>

        <button
          v-if="canKick"
          class="menu-item destructive"
          role="menuitem"
          @click="emitAction('kick')"
        >
          <span class="menu-item-label">Kick {{ displayName }}</span>
        </button>

        <button
          v-if="canBan"
          class="menu-item destructive"
          role="menuitem"
          @click="emitAction('ban')"
        >
          <span class="menu-item-label">Ban {{ displayName }}</span>
        </button>
      </template>

      <div class="menu-divider"></div>

      <!-- Copy User ID — always available -->
      <button
        class="menu-item with-trailing"
        role="menuitem"
        @click="emitAction('copy-id')"
      >
        <span class="menu-item-label">Copy User ID</span>
        <span class="menu-item-trailing">
          <Icon name="copy" :size="14" />
        </span>
      </button>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * Discord-style context menu for users in the member list.
 *
 * Visibility rules:
 *  - The component is fully self-contained for *display* and *permission
 *    gating* (it lazy-loads server-scoped role permissions for kick/ban/
 *    invite when opened), but it emits high-level events for *actions*
 *    so the parent owns the modals/routing.
 *  - We intentionally don't surface features that aren't implemented
 *    yet (Friend Nickname, Apps, granular Roles management UI, Mod View).
 */
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useUserData } from '@/composables/useUserData';
import { roleService, Permission } from '@/services/RoleService';
import { authContextService } from '@/services/AuthContextService';
import { debug } from '@/utils/debug';
import type { User } from '@/types';
import Icon from '@/components/common/Icon.vue';

interface Props {
  visible: boolean;
  user: User | null;
  position: { x: number; y: number };
}

const props = defineProps<Props>();

type UserContextAction =
  | 'profile'
  | 'mention'
  | 'message'
  | 'call'
  | 'add-note'
  | 'change-nickname'
  | 'invite'
  | 'toggle-mute'
  | 'toggle-block'
  | 'kick'
  | 'ban'
  | 'copy-id';

const emit = defineEmits<{
  close: [];
  action: [action: UserContextAction, user: User];
}>();

const route = useRoute();
const activityPubStore = useActivityPubStore();
const serverChannelStore = useServerChannelStore();
const { getCurrentUser, getUserDisplayName } = useUserData();

const menuRef = ref<HTMLElement | null>(null);
const adjustedPosition = ref({ x: 0, y: 0 });

// Permission state — lazy-loaded each time the menu opens for the
// current (user, server) tuple so we don't show actions the user can't
// actually perform. Defaults are pessimistic (false) so the menu won't
// flash kick/ban entries while loading.
const canKick = ref(false);
const canBan = ref(false);
const canInvite = ref(false);

const isSelf = computed(() => {
  if (!props.user?.id) return false;
  return props.user.id === getCurrentUser.value?.id;
});

// We're in a server context when the route is a server chat path with a
// concrete current server. DM routes (`/dm/...`) deliberately don't
// surface server-scoped actions even if the user happens to be a member
// of one of our servers.
const isInServerContext = computed(() => {
  return route.path.startsWith('/chat/') && !route.path.startsWith('/dm')
    && !!serverChannelStore.currentServerId;
});

// Chat context covers both server channels and DMs — that's where it
// makes sense to insert a mention into the active message input.
const isInChatContext = computed(() => {
  return route.path.startsWith('/chat/') || route.path.startsWith('/dm');
});

const displayName = computed(() => {
  if (!props.user?.id) return 'User';
  return getUserDisplayName(props.user.id).value || props.user.display_name || props.user.username || 'User';
});

// Treat anything without an explicit `is_local: false` as local — same
// rule as UserProfileModal — so DM/Call only show when we can actually
// route to a local conversation.
const isLocalUser = computed(() => {
  const u: any = props.user;
  return u?.is_local ?? true;
});

const isBlocked = computed(() => {
  if (!props.user?.id) return false;
  return activityPubStore.isBlocked(props.user.id);
});

const isMuted = computed(() => {
  if (!props.user?.id) return false;
  return activityPubStore.isMuted(props.user.id);
});

const canMention = computed(() => {
  // Mention only makes sense if there's a chat input to insert into.
  return !isSelf.value && isInChatContext.value;
});

const canMessage = computed(() => {
  // DMs only work locally and not against blocked users (matches the
  // gating in UserProfileModal.sendDirectMessage).
  return !isSelf.value && isLocalUser.value && !isBlocked.value;
});

const canCall = computed(() => {
  // Same rules as Message — calling routes through the DM flow.
  return canMessage.value;
});

// Show "Change Nickname" only for the current user, only in a server
// context (server nicknames are scoped to a server in `user_servers`).
const canEditOwnProfile = computed(() => {
  return isSelf.value && isInServerContext.value;
});

const hasAnyMidSectionItem = computed(() => {
  return canMention.value || canMessage.value || canCall.value || canEditOwnProfile.value;
  // Note: profile is always shown above the divider so we don't gate the divider on it.
});

/** Load kick/ban/invite permissions for the open menu. */
async function loadModerationPermissions() {
  canKick.value = false;
  canBan.value = false;
  canInvite.value = false;

  if (!isInServerContext.value || !props.user) return;
  const serverId = serverChannelStore.currentServerId;
  if (!serverId) return;

  try {
    const profileId = await authContextService.getCurrentProfileId();
    if (!profileId) return;

    const [kick, ban, invite] = await Promise.all([
      isSelf.value ? Promise.resolve(false) : roleService.hasPermission(profileId, serverId, Permission.KICK_MEMBERS),
      isSelf.value ? Promise.resolve(false) : roleService.hasPermission(profileId, serverId, Permission.BAN_MEMBERS),
      roleService.hasPermission(profileId, serverId, Permission.CREATE_INVITE),
    ]);
    canKick.value = kick;
    canBan.value = ban;
    canInvite.value = invite;
  } catch (err) {
    debug.error('UserContextMenu: failed to load moderation permissions', err);
  }
}

const menuStyle = computed(() => ({
  top: `${adjustedPosition.value.y}px`,
  left: `${adjustedPosition.value.x}px`,
}));

/**
 * Reposition the menu so it stays within the viewport. Runs after the
 * menu is in the DOM so we can use `getBoundingClientRect()` to know
 * its actual size — items are conditional so we can't hard-code it.
 */
async function repositionMenu() {
  adjustedPosition.value = { ...props.position };
  await nextTick();

  if (!menuRef.value) return;

  const rect = menuRef.value.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const padding = 8;

  let x = props.position.x;
  let y = props.position.y;

  if (x + rect.width > vw - padding) x = vw - rect.width - padding;
  if (y + rect.height > vh - padding) y = vh - rect.height - padding;
  x = Math.max(padding, x);
  y = Math.max(padding, y);

  adjustedPosition.value = { x, y };
}

function close() {
  emit('close');
}

function emitAction(action: UserContextAction) {
  if (!props.user) {
    close();
    return;
  }
  emit('action', action, props.user);
  close();
}

// Escape closes the menu — matches behaviour of MessageContextMenu /
// VoiceUserContextMenu.
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.visible) close();
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
});

// Reload permissions + reposition every time the menu opens.
watch(
  () => props.visible,
  async (visible) => {
    if (visible) {
      // Ensure block/mute state is up-to-date before deciding whether to
      // hide Message/Call — the store loads this lazily on first
      // open of any feature that needs it, and we may be the first.
      if (activityPubStore.blockedUsers.size === 0 && activityPubStore.mutedUsers.size === 0) {
        activityPubStore.loadBlockingData();
      }
      await loadModerationPermissions();
      await repositionMenu();
    }
  }
);

// Track changes in target user / position while open (e.g. opening on
// another user without closing first).
watch(
  () => [props.user?.id, props.position.x, props.position.y],
  async () => {
    if (props.visible) {
      await loadModerationPermissions();
      await repositionMenu();
    }
  }
);
</script>

<style scoped>
.user-context-menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1099;
  /* Backdrop is invisible — it just gives us a click target that closes
     the menu when the user taps outside it. Critically, it does NOT
     have `pointer-events: none` so a stray tap doesn't fall through
     onto the user-item beneath. */
  background: transparent;
}

.user-context-menu {
  position: fixed;
  z-index: 1100;
  min-width: 200px;
  max-width: 260px;
  padding: 6px 0;
  background: var(--background-quinary, #1e1f22);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 6px;
  backdrop-filter: blur(8px);
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  animation: menu-appear 0.12s ease-out;
}

@keyframes menu-appear {
  from { opacity: 0; transform: scale(0.98) translateY(-2px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 14px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.1s ease, color 0.1s ease;
}

.menu-item:hover,
.menu-item:focus-visible {
  background-color: var(--harmony-primary);
  color: var(--text-primary);
  outline: none;
}

.menu-item.with-subtitle {
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.menu-item-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu-item-subtitle {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 400;
}

.menu-item:hover .menu-item-subtitle,
.menu-item:focus-visible .menu-item-subtitle {
  color: rgba(255, 255, 255, 0.7);
}

.menu-item.with-trailing {
  justify-content: space-between;
}

.menu-item-trailing {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  flex-shrink: 0;
}

.menu-item:hover .menu-item-trailing,
.menu-item:focus-visible .menu-item-trailing {
  color: inherit;
}

.menu-item.destructive {
  color: var(--error, #ed4245);
}

.menu-item.destructive:hover,
.menu-item.destructive:focus-visible {
  background-color: #ed4245;
  color: #fff;
}

.menu-divider {
  height: 1px;
  background: var(--border-primary, rgba(255, 255, 255, 0.06));
  margin: 4px 8px;
}

/* Mobile sizing — touch targets are larger and font scaled up a bit
   so the menu reads comfortably under a finger after long-press. */
@media (max-width: 768px) {
  .user-context-menu {
    min-width: 220px;
    max-width: 280px;
    padding: 8px 0;
  }
  .menu-item {
    padding: 12px 16px;
    font-size: 15px;
  }
}
</style>
