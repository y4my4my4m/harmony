<template>
  <Teleport :to="portalTarget">
    <div
      v-if="visible"
      class="vcm-backdrop"
      @click="close"
      @contextmenu.prevent="close"
    />
    <div
      v-if="visible"
      ref="menuRef"
      class="vcm"
      role="menu"
      tabindex="-1"
      data-voice-popover
      :aria-label="displayName"
      :style="menuStyle"
      @click.stop
      @contextmenu.prevent
      @keydown.esc.stop.prevent="close"
    >
      <div class="vcm-header">
        <Avatar :src="userProfile.avatar_url" :alt="displayName" size="sm" />
        <div class="vcm-user">
          <span class="vcm-name"><DisplayName :user-id="userState.userId" :fallback="displayName" :truncate="true" /></span>
          <span class="vcm-status">
            <Icon v-if="quality === 'poor' || quality === 'lost'" name="wifi-off" class="vcm-status-icon warn" :size="12" />
            {{ statusText }}
          </span>
        </div>
      </div>

      <!-- Listener controls for someone else in this call -->
      <template v-if="!isSelf && inCall">
        <section v-for="kind in model.volumes" :key="kind" class="vcm-section">
          <VolumeSlider
            :model-value="kind === 'mic' ? micVolume : streamVolume"
            :label="kind === 'mic' ? t('voice.userVolume') : t('voice.streamVolume')"
            :muted="kind === 'mic' ? micMuted : streamMuted"
            @update:model-value="(v: number) => setVolume(kind, v)"
          />
          <p v-if="kind === 'screen' && watching && !hasStreamAudio" class="vcm-note">
            {{ t('voice.noStreamAudio') }}
          </p>
          <button
            type="button"
            role="menuitemcheckbox"
            class="vcm-check"
            :aria-checked="kind === 'mic' ? micMuted : streamMuted"
            @click="toggleLocalMute(kind)"
          >
            <span>{{ kind === 'mic' ? t('voice.muteUser') : t('voice.muteStream') }}</span>
            <span class="vcm-checkbox" :class="{ on: kind === 'mic' ? micMuted : streamMuted }">
              <Icon v-if="kind === 'mic' ? micMuted : streamMuted" name="check" :size="12" />
            </span>
          </button>
        </section>
        <p class="vcm-hint">{{ t('voice.localOnlyHint') }}</p>
      </template>

      <!-- Sharer controls for self -->
      <section v-if="model.showQuality" class="vcm-section">
        <StreamQualityOptions />
      </section>

      <div v-if="inCall && model.actions.length" class="vcm-divider" />
      <div v-if="inCall && model.actions.length" class="vcm-actions">
        <button
          v-for="action in model.actions"
          :key="action"
          type="button"
          role="menuitem"
          class="vcm-action"
          :class="{ danger: action === 'stop-streaming' || (action === 'self-mute' && localMuted) || (action === 'self-deafen' && localDeafened) }"
          @click="run(action)"
        >
          <Icon :name="actionIcon(action)" :size="16" />
          <span>{{ actionLabel(action) }}</span>
          <kbd v-if="actionShortcut(action)" class="vcm-kbd">{{ actionShortcut(action) }}</kbd>
        </button>
      </div>

      <!-- Moderation: server mute and deafen, move, disconnect, kick, ban -->
      <template v-if="moderationActions.length">
        <div class="vcm-divider" />
        <div class="vcm-actions" role="group" :aria-label="t('voice.moderation.section')" data-testid="voice-menu-moderation">
          <template v-for="action in moderationActions" :key="action">
            <button
              v-if="action === 'server-mute' || action === 'server-deafen'"
              type="button"
              role="menuitemcheckbox"
              class="vcm-check vcm-mod-check"
              :aria-checked="action === 'server-mute' ? targetFlags.muted : targetFlags.deafened"
              :disabled="pending"
              :data-testid="`voice-menu-${action}`"
              @click="runModeration(action)"
            >
              <span>{{ action === 'server-mute' ? t('voice.moderation.serverMute') : t('voice.moderation.serverDeafen') }}</span>
              <span class="vcm-checkbox" :class="{ on: action === 'server-mute' ? targetFlags.muted : targetFlags.deafened }">
                <Icon v-if="action === 'server-mute' ? targetFlags.muted : targetFlags.deafened" name="check" :size="12" />
              </span>
            </button>
            <template v-else-if="action === 'move'">
              <button
                type="button"
                role="menuitem"
                class="vcm-action"
                aria-haspopup="true"
                :aria-expanded="moveOpen"
                data-testid="voice-menu-move"
                @click="moveOpen = !moveOpen"
              >
                <Icon name="arrow-right" :size="16" />
                <span>{{ t('voice.moderation.moveTo') }}</span>
                <Icon :name="moveOpen ? 'chevron-up' : 'chevron-down'" :size="14" class="vcm-trailing" />
              </button>
              <div v-if="moveOpen" class="vcm-move-list" role="group" :aria-label="t('voice.moderation.moveTo')">
                <button
                  v-for="channel in moveTargets"
                  :key="channel.id"
                  type="button"
                  role="menuitem"
                  class="vcm-action vcm-move-target"
                  :disabled="pending"
                  :data-testid="`voice-menu-move-${channel.id}`"
                  @click="moveTo(channel.id)"
                >
                  <Icon name="volume-2" :size="14" />
                  <span>{{ channel.name }}</span>
                </button>
              </div>
            </template>
            <button
              v-else
              type="button"
              role="menuitem"
              class="vcm-action danger"
              :disabled="pending"
              :data-testid="`voice-menu-${action}`"
              @click="runModeration(action)"
            >
              <Icon :name="moderationIcon(action)" :size="16" />
              <span>{{ moderationLabel(action) }}</span>
            </button>
          </template>
        </div>
      </template>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { UserMediaState } from '@/services/unifiedWebRTC';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useUserData } from '@/composables/useUserData';
import { useKeybinds } from '@/composables/useKeybinds';
import Icon from '@/components/common/Icon.vue';
import Avatar from '@/components/common/Avatar.vue';
import DisplayName from '@/components/DisplayName.vue';
import VolumeSlider from './VolumeSlider.vue';
import StreamQualityOptions from './StreamQualityOptions.vue';
import {
  VOICE_POPOVER_DISMISS,
  buildModerationActions,
  buildVoiceMenu,
  placePopover,
  type VoiceMenuAction,
  type VoiceModerationAction,
  type VoiceVolumeSection,
} from './voiceMenuModel';
import { NO_VOICE_CAPABILITIES, useVoiceModerationStore, type VoiceModerationCapabilities } from '@/stores/voiceModeration';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { styleRect, styleViewport } from '@/utils/appZoom';
import { usePortalTarget } from '@/composables/usePortalTarget';

const portalTarget = usePortalTarget();

const props = withDefaults(defineProps<{
  userState: UserMediaState;
  x: number;
  y: number;
  visible: boolean;
  source?: 'camera' | 'screen';
  /** The host handles request-fullscreen (the call overlay does). */
  canFullscreen?: boolean;
  /** Server and voice channel the member is in; the call's when absent. */
  serverId?: string | null;
  channelId?: string | null;
  /** The member is in this client's call: listener and view controls apply. */
  inCall?: boolean;
}>(), {
  source: 'camera',
  canFullscreen: false,
  serverId: null,
  channelId: null,
  inCall: true,
});

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'request-fullscreen', source: 'camera' | 'screen'): void;
}>();

const { t } = useI18n();
const voiceStore = useUnifiedVoiceChannelStore();
const { getUserProfile } = useUserData();
const keybinds = useKeybinds();

const menuRef = ref<HTMLElement | null>(null);
const position = ref({ x: props.x, y: props.y });

const userId = computed(() => props.userState.userId);
const isSelf = computed(() => userId.value === voiceStore.localState.userId);

// Live state: the prop can be a stale snapshot from the tile list.
const live = computed<UserMediaState>(() => {
  if (isSelf.value) return voiceStore.localState;
  return voiceStore.allUsers.find(u => u.userId === userId.value) || props.userState;
});

const userProfile = computed(() => {
  const profile = getUserProfile(userId.value).value as { display_name?: string; username?: string; avatar_url?: string } | null;
  return {
    display_name: profile?.display_name || null,
    username: profile?.username || 'Unknown user',
    avatar_url: profile?.avatar_url || '/default_avatar.webp',
  };
});

const displayName = computed(() => userProfile.value.display_name || userProfile.value.username);
const quality = computed(() => voiceStore.getConnectionQuality(userId.value));

const moderation = useVoiceModerationStore();
const serverChannelStore = useServerChannelStore();
const menuServerId = computed(() => props.serverId ?? voiceStore.currentServerId);
const menuChannelId = computed(() => props.channelId ?? (props.inCall ? voiceStore.currentChannelId : null));
const targetFlags = computed(() => moderation.flagsOf(menuServerId.value, userId.value));
const can = ref<VoiceModerationCapabilities>(NO_VOICE_CAPABILITIES);
const pending = ref(false);
const moveOpen = ref(false);

const moveTargets = computed(() => serverChannelStore.channels
  .filter((c: any) => Number(c.type) === 1 && c.id !== menuChannelId.value
    && (!c.server_id || c.server_id === menuServerId.value))
  .map((c: any) => ({ id: c.id as string, name: c.name as string })));

const moderationActions = computed(() => buildModerationActions({
  isSelf: isSelf.value,
  can: can.value,
  inVoice: !!menuChannelId.value,
  moveTargets: moveTargets.value.length,
}));

async function loadCapabilities(): Promise<void> {
  const target = userId.value;
  can.value = NO_VOICE_CAPABILITIES;
  const result = await moderation.capabilities(menuServerId.value, menuChannelId.value, target);
  if (props.visible && userId.value === target) can.value = result;
}

function moderationTarget() {
  const profile = getUserProfile(userId.value).value as { username?: string; display_name?: string; avatar_url?: string } | null;
  return {
    id: userId.value,
    username: profile?.username ?? null,
    display_name: profile?.display_name ?? null,
    avatar_url: profile?.avatar_url ?? null,
  };
}

function moderationIcon(action: VoiceModerationAction): string {
  switch (action) {
    case 'disconnect': return 'phone-off';
    case 'kick': return 'user-x';
    case 'ban': return 'ban';
  }
  return 'circle';
}

function moderationLabel(action: VoiceModerationAction): string {
  switch (action) {
    case 'disconnect': return t('voice.moderation.disconnect');
    case 'kick': return t('voice.moderation.kick');
    case 'ban': return t('voice.moderation.ban');
  }
  return '';
}

async function runModeration(action: VoiceModerationAction): Promise<void> {
  const serverId = menuServerId.value;
  if (!serverId || pending.value) return;
  const target = moderationTarget();
  if (action === 'kick' || action === 'ban') {
    moderation.openKickBan(action, serverId, target);
    close();
    return;
  }
  pending.value = true;
  try {
    if (action === 'server-mute') await moderation.setFlags(serverId, target, { mute: !targetFlags.value.muted });
    else if (action === 'server-deafen') await moderation.setFlags(serverId, target, { deafen: !targetFlags.value.deafened });
    else if (action === 'disconnect') {
      await moderation.move(serverId, target, menuChannelId.value, null);
      close();
    }
  } finally {
    pending.value = false;
  }
}

async function moveTo(channelId: string): Promise<void> {
  const serverId = menuServerId.value;
  if (!serverId || pending.value) return;
  pending.value = true;
  try {
    await moderation.move(serverId, moderationTarget(), menuChannelId.value, channelId);
  } finally {
    pending.value = false;
  }
  close();
}

const statusText = computed(() => {
  const s = live.value;
  if (targetFlags.value.deafened) return t('voice.moderation.serverDeafened');
  if (targetFlags.value.muted) return t('voice.moderation.serverMuted');
  if (s.isScreenSharing) return t('voice.statusStreaming');
  if (s.isVideoEnabled) return t('voice.statusCameraOn');
  if (s.isDeafened) return t('voice.statusDeafened');
  if (s.isMuted) return t('voice.statusMuted');
  if (s.isSpeaking) return t('voice.statusSpeaking');
  return t('voice.statusInVoice');
});

const micVolume = computed(() => voiceStore.getUserVolume(userId.value));
const streamVolume = computed(() => voiceStore.getUserScreenShareVolume(userId.value));
const micMuted = computed(() => voiceStore.isUserLocallyMuted(userId.value, 'mic'));
const streamMuted = computed(() => voiceStore.isUserLocallyMuted(userId.value, 'screen'));
const watching = computed(() => voiceStore.isWatchingStream(userId.value));
const hasStreamAudio = computed(() => voiceStore.hasScreenShareAudio(userId.value));
const localMuted = computed(() => voiceStore.localState.isMuted);
const localDeafened = computed(() => voiceStore.localState.isDeafened);

const isFocused = computed(() =>
  voiceStore.viewMode === 'fullscreen' &&
  voiceStore.fullscreenUserId === userId.value &&
  voiceStore.fullscreenSource === focusSource.value
);
const isPoppedOut = computed(() => voiceStore.pipActive && voiceStore.pipUserId === userId.value);

// Focus and full screen target the stream when there is one to show.
const focusSource = computed<'camera' | 'screen'>(() => {
  if (props.source === 'screen' && live.value.isScreenSharing) return 'screen';
  if (!live.value.isVideoEnabled && live.value.isScreenSharing) return 'screen';
  return 'camera';
});

const model = computed(() => buildVoiceMenu({
  isSelf: isSelf.value,
  source: props.source,
  isStreaming: live.value.isScreenSharing,
  hasCamera: live.value.isVideoEnabled,
  canWatch: voiceStore.connectionMode === 'livekit',
  watching: watching.value,
  isFocused: isFocused.value,
  isPoppedOut: isPoppedOut.value,
  canFullscreen: props.canFullscreen,
}));

const menuStyle = computed(() => ({ left: `${position.value.x}px`, top: `${position.value.y}px` }));

function close(): void {
  emit('close');
}

function setVolume(kind: VoiceVolumeSection, volume: number): void {
  if (kind === 'mic') voiceStore.setUserVolume(userId.value, volume);
  else voiceStore.setUserScreenShareVolume(userId.value, volume);
}

function toggleLocalMute(kind: VoiceVolumeSection): void {
  voiceStore.toggleUserLocalMute(userId.value, kind);
}

function actionIcon(action: VoiceMenuAction): string {
  switch (action) {
    case 'watch': return 'eye';
    case 'stop-watching': return 'eye-off';
    case 'focus': return 'maximize-2';
    case 'exit-focus': return 'minimize-2';
    case 'fullscreen': return 'maximize';
    case 'pop-out': return 'picture-in-picture';
    case 'close-pop-out': return 'x';
    case 'stop-streaming': return 'screen-share';
    case 'self-mute': return localMuted.value ? 'mic-off' : 'mic';
    case 'self-deafen': return localDeafened.value ? 'headphones-off' : 'headphones';
  }
  return 'circle';
}

function actionLabel(action: VoiceMenuAction): string {
  switch (action) {
    case 'watch': return t('voice.watchStream');
    case 'stop-watching': return t('voice.stopWatching');
    case 'focus': return t('voice.focus');
    case 'exit-focus': return t('voice.exitFocus');
    case 'fullscreen': return t('voice.fullScreen');
    case 'pop-out': return t('voice.popOut');
    case 'close-pop-out': return t('voice.closePopOut');
    case 'stop-streaming': return t('voice.stopStreaming');
    case 'self-mute': return localMuted.value ? t('voice.unmute') : t('voice.mute');
    case 'self-deafen': return localDeafened.value ? t('voice.undeafen') : t('voice.deafen');
  }
  return '';
}

function actionShortcut(action: VoiceMenuAction): string {
  if (action === 'self-mute') return keybinds.getKeybindDisplay('toggle-mute');
  if (action === 'self-deafen') return keybinds.getKeybindDisplay('toggle-deafen');
  return '';
}

function run(action: VoiceMenuAction): void {
  const id = userId.value;
  switch (action) {
    case 'watch':
      voiceStore.watchStream(id);
      voiceStore.isOverlayVisible = true;
      voiceStore.enterFullscreen(id, 'screen');
      break;
    case 'stop-watching':
      voiceStore.stopWatchingStream(id);
      break;
    case 'focus':
      voiceStore.isOverlayVisible = true;
      voiceStore.enterFullscreen(id, focusSource.value);
      break;
    case 'exit-focus':
      voiceStore.exitFullscreen();
      break;
    case 'fullscreen':
      emit('request-fullscreen', focusSource.value);
      break;
    case 'pop-out':
      voiceStore.togglePIP(id, 'draggable');
      break;
    case 'close-pop-out':
      voiceStore.togglePIP(null);
      break;
    case 'stop-streaming':
      if (voiceStore.localState.isScreenSharing) void voiceStore.toggleScreenShare();
      break;
    case 'self-mute':
      void voiceStore.toggleMute();
      break;
    case 'self-deafen':
      void voiceStore.toggleDeafen();
      break;
  }
  close();
}

async function place(): Promise<void> {
  position.value = { x: props.x, y: props.y };
  await nextTick();
  const el = menuRef.value;
  if (!el) return;
  const rect = styleRect(el);
  position.value = placePopover(
    { x: props.x, y: props.y },
    { width: rect.width, height: rect.height },
    styleViewport(el),
  );
  el.focus({ preventScroll: true });
}

watch(() => [props.visible, props.x, props.y] as const, ([visible]) => {
  if (visible) void place();
}, { immediate: true });

watch(() => [props.visible, userId.value, menuServerId.value, menuChannelId.value] as const, ([visible]) => {
  moveOpen.value = false;
  if (visible) void loadCapabilities();
}, { immediate: true });

// Content height changes (moderation items arrive).
watch(moderationActions, () => {
  if (props.visible) void place();
});

// Content height changes (stream starts, quality section appears).
watch(() => model.value, () => {
  if (props.visible) void place();
});

function onDocumentKeydown(event: KeyboardEvent): void {
  if (props.visible && event.key === 'Escape') close();
}

function onDismiss(): void {
  if (props.visible) close();
}

onMounted(() => {
  document.addEventListener('keydown', onDocumentKeydown);
  window.addEventListener(VOICE_POPOVER_DISMISS, onDismiss);
  window.addEventListener('resize', onDismiss);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onDocumentKeydown);
  window.removeEventListener(VOICE_POPOVER_DISMISS, onDismiss);
  window.removeEventListener('resize', onDismiss);
});
</script>

<style scoped>
.vcm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10005;
}

.vcm {
  position: fixed;
  z-index: 10006;
  width: 300px;
  max-width: calc(100 * var(--app-vw) - 16px);
  max-height: calc(100 * var(--app-vh) - 16px);
  overflow-y: auto;
  background: var(--background-floating);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-large);
  outline: none;
  animation: vcm-in 0.12s ease-out;
}

@keyframes vcm-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.98); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .vcm { animation: none; }
}

:root[data-reduce-motion="true"] .vcm {
  animation: none;
}

.vcm-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: var(--background-tertiary);
  border-bottom: 1px solid var(--border-primary);
}

.vcm-user {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.vcm-name {
  font-weight: 600;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vcm-status {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.vcm-status-icon.warn {
  color: var(--warning);
}

.vcm-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px 4px;
}

.vcm-note,
.vcm-hint {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.vcm-hint {
  padding: 4px 14px 10px;
}

.vcm-check {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  margin: 0 -8px;
  width: calc(100% + 16px);
  background: transparent;
  border: none;
  border-radius: var(--radius-base);
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
}

.vcm-check:hover,
.vcm-check:focus-visible {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
  outline: none;
}

.vcm-checkbox {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 2px solid var(--text-muted);
  border-radius: var(--radius-sm);
  color: var(--text-on-primary);
  flex-shrink: 0;
}

.vcm-checkbox.on {
  background: var(--error);
  border-color: var(--error);
}

.vcm-divider {
  height: 1px;
  background: var(--border-primary);
}

.vcm-actions {
  display: flex;
  flex-direction: column;
  padding: 6px;
}

.vcm-action {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: none;
  border-radius: var(--radius-base);
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
}

.vcm-action:hover,
.vcm-action:focus-visible {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
  outline: none;
}

.vcm-action.danger {
  color: var(--text-danger);
}

.vcm-action.danger:hover,
.vcm-action.danger:focus-visible {
  background: color-mix(in srgb, var(--error) 15%, transparent);
}

.vcm-trailing {
  margin-left: auto;
}

.vcm-mod-check {
  margin: 0;
  width: 100%;
  padding: 8px 10px;
}

.vcm-move-list {
  display: flex;
  flex-direction: column;
  padding-left: 18px;
}

.vcm-action:disabled,
.vcm-check:disabled {
  opacity: 0.6;
  cursor: progress;
}

.vcm-kbd {
  margin-left: auto;
  padding: 1px 6px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
</style>
