<template>
  <div v-if="userIds.length > 0" class="voice-channel-users">
    <div class="users-header">
      <span :id="headerId" class="user-count">{{ t('voice.inCallCount', { count: userIds.length }, userIds.length) }}</span>
      <span v-if="callDuration" class="call-duration">
        <span class="sr-only">{{ t('voice.callDuration') }} </span>{{ callDuration }}
      </span>
    </div>
    <ul class="users-list" :aria-labelledby="headerId">
      <li v-for="userId in userIds" :key="userId" class="user-item" :data-testid="`voice-roster-${userId}`">
        <!-- A moderator's row opens the voice menu and drags to another channel -->
        <component
          :is="moderates ? 'button' : 'div'"
          class="user-row"
          :class="{ interactive: moderates, dragging: drag.dragging.value === userId }"
          v-bind="moderates ? {
            type: 'button',
            'aria-haspopup': 'menu',
            'aria-expanded': menuUserId === userId,
            'aria-label': rowLabel(userId),
            'aria-describedby': powers.move ? dragHintId : undefined,
          } : {}"
          @pointerdown="drag.onPointerDown($event, userId)"
          @mousedown="drag.shield($event, userId)"
          @touchstart="drag.shield($event, userId)"
          @click="onRowClick(userId, $event)"
          @contextmenu="onRowContextMenu(userId, $event)"
        >
          <Avatar
            :src="getUserAvatarUrl(userId).value"
            alt=""
            size="xs"
          />
          <span class="user-name" :aria-hidden="moderates ? 'true' : undefined"><DisplayName :userId="userId" /></span>
          <span v-if="flags(userId).muted || flags(userId).deafened" class="user-server-flags" aria-hidden="true">
            <Icon v-if="flags(userId).muted" name="mic-off" :size="12" :title="t('voice.moderation.serverMuted')" data-testid="voice-roster-server-muted" />
            <Icon v-if="flags(userId).deafened" name="headphones-off" :size="12" :title="t('voice.moderation.serverDeafened')" data-testid="voice-roster-server-deafened" />
          </span>
          <span v-if="!moderates && (flags(userId).muted || flags(userId).deafened)" class="sr-only">
            {{ flags(userId).deafened ? t('voice.moderation.serverDeafened') : t('voice.moderation.serverMuted') }}
          </span>
        </component>
      </li>
    </ul>
    <span v-if="powers.move" :id="dragHintId" hidden>{{ t('voice.moderation.dragHint') }}</span>

    <VoiceUserContextMenu
      v-if="menuUserId"
      :user-state="menuState"
      :x="menuPosition.x"
      :y="menuPosition.y"
      :visible="!!menuUserId"
      :server-id="serverId"
      :channel-id="channelId"
      :in-call="false"
      @close="closeMenu"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, onMounted, onUnmounted, watch } from 'vue';
import Avatar from '@/components/common/Avatar.vue';
import Icon from '@/components/common/Icon.vue';
import DisplayName from '@/components/DisplayName.vue';
import VoiceUserContextMenu from './VoiceUserContextMenu.vue';
import { useUserData } from '@/composables/useUserData';
import { useT } from '@/composables/useT';
import { uid } from '@/utils/a11y/focus';
import { stylePoint, styleRect } from '@/utils/appZoom';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { NO_VOICE_CAPABILITIES, useVoiceModerationStore, type VoiceModerationCapabilities } from '@/stores/voiceModeration';
import type { UserMediaState } from '@/services/unifiedWebRTC';
import { participantLabel } from './participantLabel';
import { restoreFocusIfLost } from './voiceFocus';
import { useVoiceMemberDrag } from './useVoiceMemberDrag';

interface Props {
  userIds: string[];
  callStartTime?: Date | null;
  /** The voice channel listed; enables moderation of its members. */
  channelId?: string | null;
}

const props = withDefaults(defineProps<Props>(), { callStartTime: null, channelId: null });

const { getUserAvatarUrl, getUserDisplayName } = useUserData();
const { t } = useT();
const headerId = uid('voice-roster-header');
const dragHintId = uid('voice-roster-drag');

const serverChannelStore = useServerChannelStore();
const moderation = useVoiceModerationStore();
const serverId = computed(() => serverChannelStore.currentServerId);
const flags = (userId: string) => moderation.flagsOf(serverId.value, userId);

const powers = ref<VoiceModerationCapabilities>(NO_VOICE_CAPABILITIES);
watch(() => [serverId.value, props.channelId] as const, async ([server, channel]) => {
  powers.value = NO_VOICE_CAPABILITIES;
  const result = await moderation.channelPowers(server, channel);
  if (serverId.value === server && props.channelId === channel) powers.value = result;
}, { immediate: true });

const moderates = computed(() => Object.values(powers.value).some(Boolean));

const rowLabel = (userId: string) => participantLabel(t, getUserDisplayName(userId).value, {
  serverMuted: flags(userId).muted,
  serverDeafened: flags(userId).deafened,
});

const drag = useVoiceMemberDrag({
  channelId: () => props.channelId,
  // Move Members alone decides, as in Discord: the owner and oneself are dragged like anyone.
  canDrag: () => powers.value.move,
  label: (userId) => getUserDisplayName(userId).value,
  drop: (userId, channelId) => {
    if (!serverId.value) return;
    void moderation.move(serverId.value, { id: userId, display_name: getUserDisplayName(userId).value }, props.channelId, channelId);
  },
});

// Members of another channel are not in this client's call: the menu carries moderation only.
const menuUserId = ref<string | null>(null);
const menuPosition = ref({ x: 0, y: 0 });
let menuOpener: HTMLElement | null = null;
const menuState = computed<UserMediaState>(() => ({
  userId: menuUserId.value ?? '',
  isAudioEnabled: true,
  isVideoEnabled: false,
  isScreenSharing: false,
  isMuted: false,
  isDeafened: false,
  isSpeaking: false,
  audioLevel: 0,
}));

function openMenu(userId: string, x: number, y: number, opener: HTMLElement | null): void {
  if (menuUserId.value === userId) {
    closeMenu();
    return;
  }
  menuOpener = opener;
  menuPosition.value = { x, y };
  menuUserId.value = userId;
}

function onRowClick(userId: string, event: Event): void {
  if (!moderates.value || drag.swallowsClick()) return;
  const el = event.currentTarget as HTMLElement;
  const rect = styleRect(el);
  openMenu(userId, rect.left + 24, rect.bottom, el);
}

function onRowContextMenu(userId: string, event: MouseEvent): void {
  if (!moderates.value) return;
  event.preventDefault();
  const p = stylePoint(event);
  openMenu(userId, p.x, p.y, event.currentTarget as HTMLElement);
}

function closeMenu(): void {
  menuUserId.value = null;
  const opener = menuOpener;
  menuOpener = null;
  void nextTick(() => restoreFocusIfLost(opener));
}

const callDuration = ref<string>('');
let intervalId: number | null = null;

const updateCallDuration = () => {
  if (!props.callStartTime) {
    callDuration.value = '';
    return;
  }

  const now = new Date();
  const diff = now.getTime() - props.callStartTime.getTime();
  
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);

  if (hours > 0) {
    callDuration.value = `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  } else {
    callDuration.value = `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
};

onMounted(() => {
  updateCallDuration();
  intervalId = window.setInterval(updateCallDuration, 1000);
});

onUnmounted(() => {
  if (intervalId !== null) {
    clearInterval(intervalId);
  }
});
</script>

<style scoped>
.voice-channel-users {
  margin: 4px 8px;
  padding: 8px;
  background: rgba(0, 0, 0, 0.1);
  border-radius: 4px;
  font-size: 12px;
}

.users-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.user-count {
  color: var(--text-secondary);
  font-weight: 500;
}

.call-duration {
  color: var(--text-secondary);
  font-family: monospace;
  font-size: 11px;
}

.users-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.user-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px;
  border-radius: 4px;
  transition: background 0.15s ease;
}

.user-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 0;
  background: transparent;
  border: none;
  color: inherit;
  font: inherit;
  text-align: left;
}

.user-row.interactive {
  cursor: pointer;
  border-radius: 4px;
}

.user-row.interactive:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.user-row.dragging {
  opacity: 0.5;
}

.user-server-flags {
  display: inline-flex;
  gap: 2px;
  color: var(--text-danger);
}

.user-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.user-name {
  flex: 1;
  color: var(--text-primary);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>

