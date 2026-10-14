<template>
  <div ref="sidebarEl" class="channel-sidebar" @keydown="onNavKeydown">
    <CategoryCreator
      v-if="isCategoryCreatorOpen"
      @showCategoryCreator="showCategoryCreator"
      @createCategory="createCategory"
    />
    <div class="server-header" :class="{ 'has-banner': showBanner, 'over-banner': showBanner && !bannerCovered }">
      <button
        type="button"
        class="server-name"
        :class="{ open: isDropdownOpen }"
        aria-haspopup="menu"
        :aria-expanded="isDropdownOpen"
        :aria-controls="isDropdownOpen ? serverMenuButton.menuId : undefined"
        @click.stop="toggleDropdown"
        @keydown="serverMenuButton.onTriggerKeydown"
      >
        <Icon
          v-if="remoteHost !== null"
          name="globe"
          :size="16"
          class="server-remote-icon"
          :aria-label="$t('federation.remoteServer')"
        />
        <span class="server-name-text">{{ currentServer.name }}</span>
        <Icon name="chevron-down" :size="16" class="server-name-chevron" aria-hidden="true" />
      </button>
      <div
        v-if="remoteHost !== null"
        class="server-remote-strip"
        :title="$t('federation.federatedNotice')"
      >
        {{ $t('federation.hosted') }} <strong>{{ remoteHost || $t('federation.remoteServer') }}</strong>
      </div>
      <ServerDropdown
        :serverId="currentServer.id"
        :isVisible="isDropdownOpen"
        :menu-id="serverMenuButton.menuId"
        :label="currentServer.name"
        :initial-focus="serverMenuButton.initialFocus.value"
        @close="closeDropdown"
        @showCategoryCreator="showCategoryCreator"
        @createChannel="emitCreateChannel"
        @openInviteModal="openInviteModal"
      />
    </div>
    <!-- Server banner, the owner's choice: scrolls under the sticky name bar. -->
    <div v-if="showBanner" class="server-banner" data-testid="server-sidebar-banner">
      <BannerImage :src="bannerSrc" :fallback-src="bannerFullSize" eager @failed="bannerFailed = true" />
      <div ref="bannerEndEl" class="server-banner-end" aria-hidden="true"></div>
    </div>

    <!-- Descriptions for voice channel rows: what activating one does. -->
    <span :id="ids.voiceJoin" hidden>{{ t('chatNav.channel.joinHint') }}</span>
    <span :id="ids.voiceOpen" hidden>{{ t('chatNav.channel.openChatHint') }}</span>
    <span :id="ids.voicePreview" hidden>{{ t('chatNav.channel.previewHint') }}</span>

    <!-- Channels belonging to no category -->
    <div class="orphan-channels">
      <!-- force-fallback: pointer-driven drag. Tauri's WebView2 drag-drop handler (on for OS file drops) swallows HTML5 drag and drop on Windows. -->
      <draggable
        v-model="orphanChannels"
        :group="dragGroup"
        :disabled="!canDragAndDrop || isMobile"
        :force-fallback="true"
        :fallback-tolerance="3"
        @start="onDragStart"
        @end="onDragEnd"
        @add="onChannelAddedToOrphans"
        item-key="id"
        tag="ul"
        role="list"
        class="channel-list-items"
        :class="{ 'drag-disabled': !canDragAndDrop || isMobile }"
      >
        <template #item="{ element }">
          <li
            :key="element.id"
            class="channel-wrapper"
            :data-channel-id="element.id"
            :data-category-id="null"
          >
            <div class="channel-row" :class="{ 'voice-row': isVoiceType(element.type), 'voice-connected': isVoiceType(element.type) && isUserInVoiceChannel(element.id) }">
              <component
                :is="isVoiceType(element.type) ? 'button' : 'a'"
                v-bind="channelRowAttrs(element)"
                :class="['channel-item', channelItemClasses(element, null)]"
                data-roving-item
                data-nav-kind="channel"
                :data-nav-id="element.id"
                tabindex="-1"
                draggable="false"
                :aria-current="element.id === currentChannelId && !selectedThreadId ? 'page' : undefined"
                :style="{ cursor: getDragCursor('channel', dragState.isDragging && dragState.draggedItem?.id === element.id) }"
                @click="onChannelClick($event, element)"
                @mouseenter="scheduleChannelPrefetch(element)"
                @mouseleave="cancelChannelPrefetch"
                @focus="scheduleChannelPrefetch(element)"
                @blur="cancelChannelPrefetch"
                @contextmenu="openChannelContextMenu($event, element)"
              >
                <span v-if="isChannelUnread(element.id)" class="unread-dot" aria-hidden="true"></span>
                <span class="channel-content">
                  <HashTagIcon v-if="!isVoiceType(element.type)" aria-hidden="true" />
                  <SpeakerIcon v-else aria-hidden="true" />
                  <span class="channel-name">{{ element.name }}</span>
                  <span class="sr-only">{{ channelStateText(element) }}</span>
                  <span
                    v-if="channelLockKey(element)"
                    class="channel-lock"
                    aria-hidden="true"
                    :title="$t(channelLockKey(element)!)"
                  ><Icon name="lock" :size="12" /></span>
                  <span
                    v-if="serverChannelStore.isPrivateChannel(element.id)"
                    class="channel-lock"
                    aria-hidden="true"
                    :title="$t('channel.private.label')"
                  ><Icon name="eye-off" :size="12" /></span>
                </span>
                <Icon v-if="mutedChannelIds.has(element.id)" name="bell-off" :size="12" class="muted-icon" aria-hidden="true" />
                <span v-if="getChannelUnreadMentions(element.id) > 0" class="notification-badge" aria-hidden="true">
                  {{ getChannelUnreadMentions(element.id) > 99 ? '99+' : getChannelUnreadMentions(element.id) }}
                </span>
                <span v-if="isVoiceType(element.type) && getUsersInVoiceChannel(element.id).length > 0" class="voice-controls" aria-hidden="true">
                  <span class="user-count">{{ getUsersInVoiceChannel(element.id).length }}</span>
                </span>
              </component>
              <button
                v-if="isVoiceType(element.type)"
                type="button"
                class="voice-btn chat-btn"
                data-roving-item
                data-nav-kind="voice-chat"
                :data-nav-id="element.id"
                tabindex="-1"
                :aria-label="t('chatNav.channel.openChat', { name: element.name })"
                :title="t('chatNav.channel.openChatShort')"
                @click="openVoiceChannelChat(element.id)"
              >
                <ChatBubbleIcon aria-hidden="true" />
              </button>
            </div>
            <VoiceChannelParticipants
              v-if="isVoiceType(element.type) && isUserInVoiceChannel(element.id)"
              :participants="getVoiceChannelParticipants(element.id)"
              :session-start-time="getVoiceSessionStartTime(element.id)"
            />
            <!-- Roster for voice channels the user has not joined -->
            <VoiceChannelUserList
              v-else-if="isVoiceType(element.type) && getUsersInVoiceChannel(element.id).length > 0"
              :user-ids="getUsersInVoiceChannel(element.id)"
              :call-start-time="getChannelCallStartTime(element.id)"
            />
            <!-- Active threads nested under the channel -->
            <ul
              v-if="getChannelActiveThreads(element.id).length > 0"
              class="channel-threads"
              :aria-label="t('chatNav.channel.threadsOf', { name: element.name })"
            >
              <li v-for="thread in getChannelActiveThreads(element.id)" :key="thread.id" class="channel-thread-entry">
                <a
                  :href="threadHref(thread)"
                  class="channel-thread-item"
                  :class="{ 'selected': selectedThreadId === thread.id }"
                  :aria-current="selectedThreadId === thread.id ? 'page' : undefined"
                  data-roving-item
                  data-nav-kind="thread"
                  :data-nav-id="thread.id"
                  tabindex="-1"
                  draggable="false"
                  @click.prevent="openThread(thread)"
                  @contextmenu.stop="openThreadContextMenu($event, thread)"
                >
                  <span class="thread-branch" aria-hidden="true"></span>
                  <span class="thread-name">{{ thread.name }}<span class="sr-only">, {{ t('chatNav.channel.thread') }}</span></span>
                </a>
              </li>
            </ul>
          </li>
        </template>
      </draggable>
    </div>

    <draggable
      v-model="reorderableCategories"
      :group="{ name: 'categories', put: false, pull: false }"
      :disabled="!canDragAndDrop || isMobile"
      :force-fallback="true"
      :fallback-tolerance="3"
      :key="categoriesKey"
      item-key="id"
      tag="div"
      class="categories-container"
    >
      <template #item="{ element: category }">
        <div :key="category.id" class="category-section">
          <h2 class="category-heading">
            <button
              :id="categoryHeaderId(category.id)"
              type="button"
              class="category-header"
              :class="{
                'collapsed': collapsedCategories.has(category.id),
                'has-visible-channels': shouldShowCategoryContent(category)
              }"
              :aria-expanded="!collapsedCategories.has(category.id)"
              :aria-controls="categoryListId(category.id)"
              data-roving-item
              data-nav-kind="category"
              :data-nav-id="category.id"
              tabindex="-1"
              @click="toggleCategory(category.id)"
              @contextmenu="openCategoryContextMenu($event, category)"
            >
              <Icon
                name="chevron-down"
                class="category-arrow"
                :class="{ 'rotated': collapsedCategories.has(category.id) }"
                :size="12"
                aria-hidden="true"
              />
              <span class="category-name">{{ category.name }}</span>
            </button>
          </h2>

          <!-- Rendered when empty as well; an empty list is a valid drop target -->
          <div
            :id="categoryListId(category.id)"
            class="channel-list"
            :class="{
              'collapsed-list': collapsedCategories.has(category.id),
              'empty-category': getCachedCategoryChannels(category.id).value.length === 0
            }"
          >
            <draggable
              v-model="getCachedCategoryChannels(category.id).value"
              :group="dragGroup"
              :disabled="!canDragAndDrop || isMobile"
              :force-fallback="true"
              :fallback-tolerance="3"
              @start="onDragStart"
              @end="onDragEnd"
              @add="(evt: any) => onChannelAddedToCategory(evt, category.id)"
              @remove="onChannelRemovedFromCategory"
              item-key="id"
              tag="ul"
              role="list"
              :aria-labelledby="categoryHeaderId(category.id)"
              class="category-channels channel-list-items"
              :class="{ 'empty-drop-zone': getCachedCategoryChannels(category.id).value.length === 0 }"
            >
              <template #item="{ element: channel }">
                <li
                  :key="channel.id"
                  class="channel-wrapper"
                  :data-channel-id="channel.id"
                  :data-category-id="category.id"
                >
                  <div class="channel-row" :class="{ 'voice-row': isVoiceType(channel.type), 'voice-connected': isVoiceType(channel.type) && isUserInVoiceChannel(channel.id) }">
                    <component
                      :is="isVoiceType(channel.type) ? 'button' : 'a'"
                      v-bind="channelRowAttrs(channel)"
                      :class="['channel-item', channelItemClasses(channel, category.id)]"
                      data-roving-item
                      data-nav-kind="channel"
                      :data-nav-id="channel.id"
                      tabindex="-1"
                      draggable="false"
                      :aria-current="currentChannelId === channel.id && !selectedThreadId ? 'page' : undefined"
                      :style="{ cursor: getDragCursor('channel', dragState.isDragging && dragState.draggedItem?.id === channel.id) }"
                      @click="onChannelClick($event, channel)"
                      @mouseenter="scheduleChannelPrefetch(channel)"
                      @mouseleave="cancelChannelPrefetch"
                      @focus="scheduleChannelPrefetch(channel)"
                      @blur="cancelChannelPrefetch"
                      @contextmenu="openChannelContextMenu($event, channel)"
                    >
                      <span v-if="isChannelUnread(channel.id)" class="unread-dot" aria-hidden="true"></span>
                      <span class="channel-content">
                        <HashTagIcon v-if="!isVoiceType(channel.type)" aria-hidden="true" />
                        <SpeakerIcon v-else aria-hidden="true" />
                        <span class="channel-name">{{ channel.name }}</span>
                        <span class="sr-only">{{ channelStateText(channel) }}</span>
                        <span
                          v-if="channelLockKey(channel)"
                          class="channel-lock"
                          aria-hidden="true"
                          :title="$t(channelLockKey(channel)!)"
                        ><Icon name="lock" :size="12" /></span>
                        <span
                          v-if="serverChannelStore.isPrivateChannel(channel.id)"
                          class="channel-lock"
                          aria-hidden="true"
                          :title="$t('channel.private.label')"
                        ><Icon name="eye-off" :size="12" /></span>
                      </span>
                      <Icon v-if="mutedChannelIds.has(channel.id)" name="bell-off" :size="12" class="muted-icon" aria-hidden="true" />
                      <span v-if="getChannelUnreadMentions(channel.id) > 0" class="notification-badge" aria-hidden="true">
                        {{ getChannelUnreadMentions(channel.id) > 99 ? '99+' : getChannelUnreadMentions(channel.id) }}
                      </span>
                      <span v-if="isVoiceType(channel.type) && getUsersInVoiceChannel(channel.id).length > 0" class="voice-controls" aria-hidden="true">
                        <span class="user-count">{{ getUsersInVoiceChannel(channel.id).length }}</span>
                      </span>
                    </component>
                    <button
                      v-if="isVoiceType(channel.type)"
                      type="button"
                      class="voice-btn chat-btn"
                      data-roving-item
                      data-nav-kind="voice-chat"
                      :data-nav-id="channel.id"
                      tabindex="-1"
                      :aria-label="t('chatNav.channel.openChat', { name: channel.name })"
                      :title="t('chatNav.channel.openChatShort')"
                      @click="openVoiceChannelChat(channel.id)"
                    >
                      <ChatBubbleIcon aria-hidden="true" />
                    </button>
                  </div>
                  <VoiceChannelParticipants
                    v-if="isVoiceType(channel.type) && isUserInVoiceChannel(channel.id)"
                    :participants="getVoiceChannelParticipants(channel.id)"
                    :session-start-time="getVoiceSessionStartTime(channel.id)"
                  />
                  <!-- Roster for voice channels the user has not joined -->
                  <VoiceChannelUserList
                    v-else-if="isVoiceType(channel.type) && getUsersInVoiceChannel(channel.id).length > 0"
                    :user-ids="getUsersInVoiceChannel(channel.id)"
                    :call-start-time="getChannelCallStartTime(channel.id)"
                  />
                  <!-- Active threads nested under the channel -->
                  <ul
                    v-if="getChannelActiveThreads(channel.id).length > 0"
                    class="channel-threads"
                    :aria-label="t('chatNav.channel.threadsOf', { name: channel.name })"
                  >
                    <li v-for="thread in getChannelActiveThreads(channel.id)" :key="thread.id" class="channel-thread-entry">
                      <a
                        :href="threadHref(thread)"
                        class="channel-thread-item"
                        :class="{ 'selected': selectedThreadId === thread.id }"
                        :aria-current="selectedThreadId === thread.id ? 'page' : undefined"
                        data-roving-item
                        data-nav-kind="thread"
                        :data-nav-id="thread.id"
                        tabindex="-1"
                        draggable="false"
                        @click.prevent="openThread(thread)"
                        @contextmenu.stop="openThreadContextMenu($event, thread)"
                      >
                        <span class="thread-branch" aria-hidden="true"></span>
                        <span class="thread-name">{{ thread.name }}<span class="sr-only">, {{ t('chatNav.channel.thread') }}</span></span>
                      </a>
                    </li>
                  </ul>
                </li>
              </template>
              <template #footer v-if="getCachedCategoryChannels(category.id).value.length === 0 && dragState.isDragging">
                <li class="empty-category-placeholder">
                  {{ t('chatNav.channel.dropHere') }}
                </li>
              </template>
            </draggable>
          </div>
        </div>
      </template>
    </draggable>

    <InviteModal 
      :show="showInviteModal" 
      :server-id="currentServer.id"
      :server-data="currentServerData"
      @close="closeInviteModal"
    />

    <ChannelContextMenu
      :is-visible="showChannelContextMenu"
      :position="contextMenuPosition"
      :channel="selectedChannel"
      :trigger="contextMenuTrigger"
      :can-reorder="canDragAndDrop"
      :can-move-up="!!selectedChannel && canMoveChannel(selectedChannel, -1)"
      :can-move-down="!!selectedChannel && canMoveChannel(selectedChannel, 1)"
      @close="closeContextMenus"
      @invite-users="handleInviteUsers"
      @edit-channel="handleEditChannel"
      @delete-channel="handleDeleteChannel"
      @move="moveChannel"
    />

    <CategoryContextMenu
      :is-visible="showCategoryContextMenu"
      :position="contextMenuPosition"
      :category="selectedCategory"
      :trigger="contextMenuTrigger"
      :can-move-up="!!selectedCategory && canMoveCategory(selectedCategory, -1)"
      :can-move-down="!!selectedCategory && canMoveCategory(selectedCategory, 1)"
      @close="closeContextMenus"
      @create-channel="handleCreateChannelInCategory"
      @edit-category="handleEditCategory"
      @delete-category="handleDeleteCategory"
      @move="moveCategory"
    />

    <ThreadContextMenu
      :is-visible="showThreadContextMenu"
      :position="contextMenuPosition"
      :thread="selectedThread"
      :server-id="currentServer?.id"
      :trigger="contextMenuTrigger"
      @close="closeContextMenus"
      @leave="handleLeaveThread"
      @edit="handleEditThread"
      @open-split-view="handleOpenSplitView"
      @close-thread="handleCloseThread"
      @reopen="handleReopenThread"
      @lock="handleLockThread"
      @unlock="handleUnlockThread"
      @delete="handleDeleteThread"
    />

    <ChannelEditModal
      :show="showChannelEditModal"
      :channel="selectedChannel"
      @close="closeChannelEditModal"
      @updated="handleChannelUpdated"
    />

    <CategoryEditModal
      :show="showCategoryEditModal"
      :category="selectedCategory"
      @close="closeCategoryEditModal"
      @updated="handleCategoryUpdated"
    />

    <ThreadEditModal
      :show="showThreadEditModal"
      :thread="selectedThread"
      @close="closeThreadEditModal"
      @updated="handleThreadUpdated"
    />

    <ConfirmationModal
      :show="showConfirmationModal"
      :title="confirmationConfig.title"
      :message="confirmationConfig.message"
      :secondary-message="confirmationConfig.secondaryMessage"
      :confirm-button-text="confirmationConfig.confirmButtonText"
      :require-confirmation="confirmationConfig.requireConfirmation"
      :confirmation-text="confirmationConfig.confirmationText"
      @close="closeConfirmationModal"
      @confirm="confirmationConfig.onConfirm"
    />

    <MobileVoiceChannelPreview
      :is-visible="showMobileVoicePreview"
      :channel-id="mobileVoicePreviewChannel?.id || ''"
      :channel-name="mobileVoicePreviewChannel?.name || ''"
      :participants="getMobileVoicePreviewParticipants"
      @close="closeMobileVoicePreview"
      @join="handleMobileVoiceJoin"
      @open-chat="handleMobileVoiceOpenChat"
    />
  </div>
</template>

<script setup lang="ts">
// Channel and category lists are not virtualized.
import { ref, computed, watch, nextTick, onMounted, onUnmounted, type WritableComputedRef } from 'vue';
import { debug } from '@/utils/debug'
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useRouter, useRoute } from 'vue-router';
import { useServerPermissions } from '@/composables/useServerPermissions';
import { useHapticSettings } from '@/composables/useHapticSettings';
import { useViewport } from '@/composables/useViewport';
import { useNotificationStore } from '@/stores/useNotification';
import { useServerNotificationSettingsStore } from '@/stores/useServerNotificationSettings';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useThemeStore } from '@/stores/useTheme';
import { useChannelEncryptionStore } from '@/stores/useChannelEncryption';
import { useChatStore } from '@/stores/useChat';
import { statePersistence } from '@/services/StatePersistence';
import { useRovingTabindex } from '@/composables/useRovingTabindex';
import { isContextMenuKey, useMenuButton } from '@/composables/useMenu';
import { useAnnouncer } from '@/composables/useAnnouncer';
import { focusElement, uid } from '@/utils/a11y/focus';

import type { PropType } from 'vue';
import type { Channel, Category } from '@/types';

import HashTagIcon from '@/components/icons/HashTag.vue';
import SpeakerIcon from '@/components/icons/Speaker.vue';
import ChatBubbleIcon from '@/components/icons/ChatBubble.vue';
import Icon from '@/components/common/Icon.vue';
import { getRawServerBannerUrl, getServerBannerUrl, remoteServerHost } from '@/utils/serverUtils';
import { useToast } from 'vue-toastification';
import { useI18n } from 'vue-i18n';
import ServerDropdown from './ServerDropdown.vue';
import BannerImage from '@/components/common/BannerImage.vue';
import CategoryCreator from './CategoryCreator.vue';
import InviteModal from './InviteModal.vue';
import VoiceChannelParticipants from '@/components/voice/VoiceChannelParticipants.vue';
import VoiceChannelUserList from '@/components/voice/VoiceChannelUserList.vue';
import MobileVoiceChannelPreview from '@/components/voice/MobileVoiceChannelPreview.vue';
import ChannelContextMenu from './ChannelContextMenu.vue';
import CategoryContextMenu from './CategoryContextMenu.vue';
import ChannelEditModal from './ChannelEditModal.vue';
import CategoryEditModal from './CategoryEditModal.vue';
import ConfirmationModal from './ConfirmationModal.vue';
import ThreadContextMenu from './threads/ThreadContextMenu.vue';
import ThreadEditModal from './ThreadEditModal.vue';
import { threadService, type ThreadWithDetails } from '@/services/ThreadService';
import { useThreadsStore, isOptimisticThreadId } from '@/stores/useThreads';
import { useUnreadCounts } from '@/composables/useUnreadCounts';
import { supabase } from '@/supabase';
import { stylePoint, styleRect } from '@/utils/appZoom';

import draggable from "vuedraggable";

interface DragState {
  isDragging: boolean;
  draggedItem: Channel | null;
  sourceCategoryId: string | null;
  targetCategoryId: string | null;
  isOver: boolean;
}

// Props and Emits
const props = defineProps({
  currentServer: {
    type: Object,
    required: true
  },
  channels: {
    type: Array as PropType<Channel[]>,
    required: true
  },
  categories: {
    type: Array as PropType<Category[]>,
  },
  categoryChannels: {
    type: Object as PropType<{ [key: string]: Channel[] }>,
    required: true
  },
  currentChannelId: {
    type: String,
    required: true
  },
});

const emit = defineEmits<{
  (e: 'createChannel', categoryId?: string): void
  (e: 'openThread', thread: ThreadWithDetails): void
}>();

const channelEncryptionStore = useChannelEncryptionStore();
const chatStore = useChatStore();

// A string source; a fresh tuple compares unequal on every trigger, so the
// background structure refresh after a switch would reload an unchanged set.
watch(
  () => `${props.currentServer?.id ?? ''}|${props.channels.map(c => c.id).join(',')}`,
  () => {
    const serverId = props.currentServer?.id;
    if (serverId) void channelEncryptionStore.loadServer(serverId, props.channels.map(c => c.id));
  },
  { immediate: true }
);

/** i18n key for the lock icon's label, or null for a channel without encryption. */
const channelLockKey = (channel: Channel): string | null => {
  const state = channelEncryptionStore.stateFor(channel.id);
  if (!state) return null;
  if (isVoiceType(channel.type) && state.voiceEncrypted) return 'channelEncryption.lock.voice';
  return state.messagesEncrypted ? 'channelEncryption.lock.messages' : null;
};

// State
const isDropdownOpen = ref(false);
const serverMenuButton = useMenuButton(isDropdownOpen);
const showInviteModal = ref(false);
const isCategoryCreatorOpen = ref(false);

const threadsStore = useThreadsStore();
const selectedThreadId = ref<string | null>(null);
const loadingThreads = ref(false);
// Last thread fetch per server. Thread broadcasts keep the visible server's
// entries current between fetches.
const threadsFetchedAt = new Map<string, number>();
const THREAD_CACHE_VALIDITY_MS = 60 * 1000; // 1 minute cache validity

// Context menu state
const showChannelContextMenu = ref(false);
const showCategoryContextMenu = ref(false);
const showThreadContextMenu = ref(false);
const contextMenuPosition = ref({ x: 0, y: 0 });
const selectedChannel = ref<Channel | null>(null);
const selectedCategory = ref<Category | null>(null);
const selectedThread = ref<ThreadWithDetails | null>(null);
// Row that opened the context menu; focus returns to it on close.
const contextMenuTrigger = ref<HTMLElement | null>(null);

// Modal state
const showChannelEditModal = ref(false);
const showCategoryEditModal = ref(false);
const showThreadEditModal = ref(false);
const showConfirmationModal = ref(false);

// Mobile voice channel preview state
const showMobileVoicePreview = ref(false);
const mobileVoicePreviewChannel = ref<Channel | null>(null);
const confirmationConfig = ref({
  title: '',
  message: '',
  secondaryMessage: '',
  confirmButtonText: 'Delete',
  requireConfirmation: false,
  confirmationText: 'DELETE',
  onConfirm: () => {}
});

// Drag state
const dragState = ref<DragState>({
  isDragging: false,
  draggedItem: null,
  sourceCategoryId: null,
  targetCategoryId: null,
  isOver: false,
});

const frozenOrphans = ref<Channel[] | null>(null);
const frozenCategoryChannels = ref<Map<string, Channel[]>>(new Map());

// Stores and Composables
const serverChannelStore = useServerChannelStore();
const router = useRouter();
const route = useRoute();
const serverUsersStore = useServerUsersStore();
const voiceChannelStore = useUnifiedVoiceChannelStore();
const themeStore = useThemeStore();
const { 
  canManageChannels, 
  isCurrentUserServerOwner,
  channelPermissions 
} = useServerPermissions();

// Channel management permissions
const canDragAndDrop = computed(() => isCurrentUserServerOwner.value || canManageChannels.value);
const canMoveChannelsBetweenCategories = computed(() => channelPermissions.value.canReorderChannels);

const getDragCursor = (itemType: 'channel' | 'category', isDragging = false) => {
  return canDragAndDrop.value ? (isDragging ? 'grabbing' : 'grab') : 'pointer';
};
const { triggerVoice } = useHapticSettings();
const toast = useToast();
const { t } = useI18n();

// Touch-capable desktops keep drag; only a small viewport counts as mobile.
const isVoiceType = (type: any): boolean => Number(type) === 1;

const { isMobileViewport, isTouchOnly } = useViewport();
const isMobile = computed(() => isMobileViewport.value || isTouchOnly);

const dragGroup = computed(() => ({
  name: 'channels',
  put: true,
  pull: true,
}));

// Raw server row: InviteModal normalizes `icon`/`banner` via serverUtils and
// fetches the live member count itself.
//
// Absent server yields `undefined`, not `null`: the `server-data` prop is
// typed `T | undefined`, and `null` raises TS2322.
const remoteHost = computed(() => remoteServerHost(props.currentServer));

const currentServerData = computed(() => {
  if (!props.currentServer) return undefined;
  return {
    id: props.currentServer.id,
    name: props.currentServer.name,
    icon: props.currentServer.icon,
    banner: props.currentServer.banner,
    description: props.currentServer.description,
    member_count: Object.keys(serverUsersStore.userProfiles).length || props.currentServer.member_count || 0,
  };
});

// Category & Channel Data Management
const collapsedCategories = ref(new Set<string>());

const orphanChannels = computed({
  get: () => {
    if (dragState.value.isDragging && frozenOrphans.value) return frozenOrphans.value;
    if (!props.channels || !Array.isArray(props.channels)) return [];
    const categoryChannelIds = new Set(Object.values(props.categoryChannels || {}).flat().map(c => c.id));
    return props.channels
      .filter(channel => !categoryChannelIds.has(channel.id))
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  },
  set: async (newChannels) => {
    try {
      await serverChannelStore.reorderChannelsInCategory(null, newChannels);
    } catch (error) {
      debug.error('Failed to reorder orphan channels:', error);
    }
  }
});

// Plain Map: render fills it on a miss, and a write to a reactive Map during
// render re-queues that render. Each entry is a computed over reactive props,
// so no invalidation is needed for correctness.
const categoryChannelsCache = new Map<string, WritableComputedRef<Channel[]>>();

const getCategoryChannelsComputed = (categoryId: string) => {
  return computed({
    get: () => {
      if (dragState.value.isDragging && frozenCategoryChannels.value.has(categoryId)) {
        return frozenCategoryChannels.value.get(categoryId)!;
      }
      const categoryChannels = props.categoryChannels?.[categoryId] || [];
      const channelsInCategory = props.channels
        .filter(channel => categoryChannels.some(catChannel => catChannel.id === channel.id))
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      
      if (collapsedCategories.value.has(categoryId)) {
        return channelsInCategory.filter(channel => 
          channel.id === props.currentChannelId || hasNotifications(channel)
        );
      }
      return channelsInCategory;
    },
    set: async (newChannels: Channel[]) => {
      try {
        await serverChannelStore.reorderChannelsInCategory(categoryId, newChannels);
      } catch (error) {
        debug.error(`Failed to reorder channels in category ${categoryId}:`, error);
      }
    }
  });
};

const getCachedCategoryChannels = (categoryId: string): WritableComputedRef<Channel[]> => {
  let cached = categoryChannelsCache.get(categoryId);
  if (!cached) {
    cached = getCategoryChannelsComputed(categoryId);
    categoryChannelsCache.set(categoryId, cached);
  }
  return cached;
};

const storeCategories = computed(() => serverChannelStore.categories);

const reorderableCategories = computed({
  get: () => {
    if (!Array.isArray(storeCategories.value)) return [];
    const categories = storeCategories.value.map(category => ({
      ...category,
      channels: props.categoryChannels[category.id] || [],
    }));
    // A category whose channels are all hidden from the viewer would still show its name.
    // Managers keep every category: they reorder the full list and add channels to empty ones.
    return canDragAndDrop.value ? categories : categories.filter(c => c.channels.length > 0);
  },
  set: (newCategories) => {
    serverChannelStore.updateCategoryOrder(newCategories);
  }
});

const categoriesKey = computed(() => serverChannelStore.categories.map((c: any) => `${c.id}-${c.order}`).join(','));

// Methods
const initializeCategoryStates = async () => {
  if (!props.currentServer?.id) return;
  try {
    await statePersistence.initialize();
    const savedStates = statePersistence.getServerCategoryStates(props.currentServer.id);
    const newCollapsedSet = new Set<string>();
    Object.entries(savedStates).forEach(([categoryId, isCollapsed]) => {
      if (isCollapsed) newCollapsedSet.add(categoryId);
    });
    collapsedCategories.value = newCollapsedSet;
  } catch (error) {
    debug.warn('Failed to initialize category states:', error);
  }
};

const onDragStart = (evt: any) => {
  if (!canDragAndDrop.value || isMobile.value) {
    evt.preventDefault();
    return false;
  }
  
  const channelId = evt.item.dataset.channelId;
  const categoryId = evt.item.dataset.categoryId;
  const allChannels = [...orphanChannels.value, ...Object.values(props.categoryChannels).flat()];
  const draggedChannel = allChannels.find(ch => ch.id === channelId) || null;

  if (!draggedChannel) {
    evt.preventDefault();
    return false;
  }

  // Snapshot the live lists while isDragging is still false, then freeze.
  frozenOrphans.value = [...orphanChannels.value];
  const snapshot = new Map<string, Channel[]>();
  for (const cat of storeCategories.value) {
    snapshot.set(cat.id, [...getCachedCategoryChannels(cat.id).value]);
  }
  frozenCategoryChannels.value = snapshot;

  dragState.value = {
    isDragging: true,
    draggedItem: draggedChannel,
    sourceCategoryId: categoryId === 'null' ? null : categoryId,
    targetCategoryId: null,
    isOver: false,
  };
  document.body.classList.add('dragging-channel');
};

const onDragEnd = () => {
  document.body.classList.remove('dragging-channel');
  dragState.value = { isDragging: false, draggedItem: null, sourceCategoryId: null, targetCategoryId: null, isOver: false };
  frozenOrphans.value = null;
  frozenCategoryChannels.value = new Map();
};

const onChannelAddedToCategory = async (evt: { item: HTMLElement }, categoryId: string) => {
  if (!canMoveChannelsBetweenCategories.value) return;
  const channelId = evt.item.dataset.channelId;
  if (!dragState.value.draggedItem || dragState.value.draggedItem.id !== channelId) return;
  try {
    await serverChannelStore.moveChannelToCategory(channelId, categoryId);
  } catch (error) {
    debug.error('Failed to move channel to category:', error);
  }
};

const onChannelAddedToOrphans = async (evt: any) => {
  if (!canMoveChannelsBetweenCategories.value) return;
  const channelId = evt.item.dataset.channelId;
  if (!dragState.value.draggedItem || dragState.value.draggedItem.id !== channelId) return;
  try {
    await serverChannelStore.moveChannelToCategory(channelId, null);
  } catch (error) {
    debug.error('Failed to move channel to orphan channels:', error);
  }
};

const onChannelRemovedFromCategory = (_evt: any) => {
  // The matching @add handler performs the move; this side only logs.
  debug.log('Channel removed from category during drag operation');
};



const notificationStore = useNotificationStore();
const { getUnreadMessages } = useUnreadCounts();

const notificationSettings = useServerNotificationSettingsStore();

// Channels muted directly or through their category.
const mutedChannelIds = computed<Set<string>>(() => {
  const serverId = props.currentServer?.id;
  return new Set(
    props.channels
      .filter(c => notificationSettings.isChannelMuted(serverId, c.id, c.category))
      .map(c => c.id)
  );
});

const loadMutedChannels = () => {
  if (props.currentServer?.id) void notificationSettings.load(props.currentServer.id);
};

const getChannelUnreadMentions = (channelId: string): number => {
  return notificationStore.unreadChannelMentions(channelId);
};

const hasNotifications = (channel: Channel): boolean => {
  return getChannelUnreadMentions(channel.id) > 0;
};

const hasUnreadMessages = (channelId: string): boolean => {
  if (mutedChannelIds.value.has(channelId)) return false
  return getUnreadMessages({ channelId }) > 0;
};

const shouldShowCategoryContent = (category: Category): boolean => {
  const categoryChannelsList = props.categoryChannels?.[category.id] || [];
  if (!collapsedCategories.value.has(category.id)) return categoryChannelsList.length > 0;
  return categoryChannelsList.some(channel => channel.id === props.currentChannelId || hasNotifications(channel));
};

const toggleCategory = async (categoryId: string) => {
  const wasCollapsed = collapsedCategories.value.has(categoryId);
  wasCollapsed ? collapsedCategories.value.delete(categoryId) : collapsedCategories.value.add(categoryId);
  if (props.currentServer?.id) {
    try {
      await statePersistence.setCategoryCollapseState(props.currentServer.id, categoryId, !wasCollapsed);
    } catch (error) {
      debug.warn('Failed to persist category collapse state:', error);
    }
  }
};

const toggleDropdown = () => isDropdownOpen.value = !isDropdownOpen.value;
const closeDropdown = () => { isDropdownOpen.value = false; };

// Same intent threshold as the server rail.
const CHANNEL_PREFETCH_DELAY_MS = 100;
let channelPrefetchTimer: ReturnType<typeof setTimeout> | null = null;

const cancelChannelPrefetch = () => {
  if (channelPrefetchTimer) {
    clearTimeout(channelPrefetchTimer);
    channelPrefetchTimer = null;
  }
};

/** Loads a hovered or focused text channel's newest page into the message cache. */
const scheduleChannelPrefetch = (channel: Channel) => {
  cancelChannelPrefetch();
  if (isVoiceType(channel.type) || channel.id === props.currentChannelId) return;
  channelPrefetchTimer = setTimeout(() => {
    channelPrefetchTimer = null;
    void chatStore.prefetchChannelMessages(channel.id);
  }, CHANNEL_PREFETCH_DELAY_MS);
};

const selectChannel = (channelId: string) => {
  cancelChannelPrefetch();
  const serverId = props.currentServer.id;
  if (!serverId) {
    debug.warn('Cannot navigate to channel: No server ID available');
    return;
  }
  
  router.push({ 
    name: 'ChatChannel', 
    params: { 
      serverId, 
      channelId 
    } 
  });
};

// Mobile opens the preview modal; desktop joins on click.
const handleVoiceChannelClick = async (channelId: string) => {
  // Already connected: navigate to the channel's text chat.
  if (isUserInVoiceChannel(channelId)) {
    selectChannel(channelId);
    return;
  }
  
  if (isMobile.value) {
    const channel = props.channels.find(c => c.id === channelId);
    if (channel) {
      mobileVoicePreviewChannel.value = channel;
      showMobileVoicePreview.value = true;
    }
    return;
  }
  
  selectChannel(channelId);
  await joinVoiceChannel(channelId);
};

const closeMobileVoicePreview = () => {
  showMobileVoicePreview.value = false;
  mobileVoicePreviewChannel.value = null;
};

const handleMobileVoiceJoin = async (startMuted: boolean) => {
  if (!mobileVoicePreviewChannel.value) return;
  
  const channelId = mobileVoicePreviewChannel.value.id;
  closeMobileVoicePreview();
  
  const success = await joinVoiceChannel(channelId);
  
  // Mute state applies only after the join succeeds.
  if (success && startMuted) {
    voiceChannelStore.setMuted(true);
  }
};

const handleMobileVoiceOpenChat = () => {
  if (!mobileVoicePreviewChannel.value) return;
  
  const channelId = mobileVoicePreviewChannel.value.id;
  closeMobileVoicePreview();
  openVoiceChannelChat(channelId);
};

const getMobileVoicePreviewParticipants = computed(() => {
  if (!mobileVoicePreviewChannel.value) return [];
  
  const userIds = getUsersInVoiceChannel(mobileVoicePreviewChannel.value.id);
  return userIds.map(id => ({ id }));
});

const openVoiceChannelChat = (channelId: string) => {
  selectChannel(channelId);
};
const emitCreateChannel = (categoryId?: string) => emit('createChannel', categoryId);
const showCategoryCreator = () => isCategoryCreatorOpen.value = !isCategoryCreatorOpen.value;
const openInviteModal = () => showInviteModal.value = true;
const closeInviteModal = () => showInviteModal.value = false;

watch(
  () => [serverChannelStore.pendingStructureCreate, props.currentServer?.id] as const,
  ([pending, serverId]) => {
    if (!pending || pending.serverId !== serverId) return
    serverChannelStore.pendingStructureCreate = null
    if (pending.kind === 'category') isCategoryCreatorOpen.value = true
    else emitCreateChannel(undefined)
  },
  { immediate: true },
);

watch(() => serverChannelStore.pendingInviteOpen, (pending) => {
  if (pending) {
    serverChannelStore.pendingInviteOpen = false
    openInviteModal()
  }
});

const loadActiveThreads = async (forceRefresh = false) => {
  if (!props.currentServer?.id) return;
  
  const serverId = props.currentServer.id;
  
  // Zero threads is a valid cached result.
  const fetchedAt = threadsFetchedAt.get(serverId);
  if (!forceRefresh && fetchedAt !== undefined) {
    const cacheAge = Date.now() - fetchedAt;
    if (cacheAge < THREAD_CACHE_VALIDITY_MS) {
      debug.log(`Threads cache still valid (${Math.round(cacheAge / 1000)}s old), skipping fetch`);
      return;
    }
  }
  
  loadingThreads.value = true;
  try {
    // Auto-archive runs first so the query returns only active threads.
    supabase.rpc('auto_archive_threads').then(({ error }) => {
      if (error) debug.warn('auto_archive_threads RPC failed:', error);
    });

    const threads = await threadService.getServerThreads(serverId, { archived: false });

    // The read is capped per server, so it adds and updates entries only.
    // Expired threads are filtered by activeChannelThreads.
    for (const thread of threads) threadsStore.upsert(thread);
    threadsFetchedAt.set(serverId, Date.now());
    debug.log(`Loaded ${threads.length} threads for server ${serverId}`);
  } catch (error) {
    debug.error('Failed to load threads:', error);
  } finally {
    loadingThreads.value = false;
  }
};

const getChannelActiveThreads = (channelId: string): ThreadWithDetails[] => {
  return threadsStore.activeChannelThreads(channelId);
};

// An optimistic thread has no server id to route to yet.
const openThread = (thread: ThreadWithDetails) => {
  if (isOptimisticThreadId(thread.id)) return;
  selectedThreadId.value = thread.id;
  router.push({
    name: 'ThreadView',
    params: {
      serverId: props.currentServer.id,
      threadId: thread.id
    }
  });
};

const createCategory = async (categoryName: string) => {
  try {
    await serverChannelStore.createCategory(categoryName, props.currentServer.id);
  } catch (error) {
    debug.error('Failed to create category:', error);
  } finally {
    isCategoryCreatorOpen.value = false;
  }
};

// NOTE: channel creation lives in CreateChannel.vue, which emits to
// ChatLayout.vue; the realtime subscription adds new channels to the store
// via _handleChannelInsert.

const isUserInVoiceChannel = (channelId: string): boolean => {
  if (voiceChannelStore.isConnected && voiceChannelStore.currentChannelId === channelId) {
    return true;
  }
  // Optimistic: join still in flight.
  if (voiceChannelStore.optimisticChannelId === channelId) {
    return true;
  }
  return false;
};
const getUsersInVoiceChannel = (channelId: string): string[] => serverUsersStore.getUsersInVoiceChannel(channelId);
const getChannelCallStartTime = (channelId: string): Date | null => serverUsersStore.getCallStartTime(channelId);

const getVoiceChannelParticipants = (channelId: string) => {
  // effectiveChannelId covers the optimistic id, so the roster shows while connecting.
  if (voiceChannelStore.effectiveChannelId === channelId) {
    return voiceChannelStore.allParticipants;
  }
  return [];
};

const getVoiceSessionStartTime = (channelId: string) => {
  // Session start time belongs to the channel the local user occupies.
  if (voiceChannelStore.currentChannelId === channelId) {
    return voiceChannelStore.sessionStartTime;
  }
  return null;
};

const joinVoiceChannel = async (channelId: string): Promise<boolean> => {
  // Haptics fire before the connection resolves; the join sound and
  // announcement follow it (unifiedVoiceChannel announceConnected).
  triggerVoice('success');
  
  const success = await voiceChannelStore.joinVoiceChannel(channelId, props.currentServer.id);
  
  if (!success) {
    // Disconnect sound signals the failed join.
    themeStore.playAudio('voice_disconnect');
    triggerVoice('warning');
    if (voiceChannelStore.joinError) {
      notificationStore.showToast('server_update', 'Could not join voice', voiceChannelStore.joinError, 6000);
    }
  }
  
  return success;
};

// eslint-disable-next-line unused-imports/no-unused-vars
const leaveVoiceChannel = async (_channelId: string) => {
  if (await voiceChannelStore.leaveVoiceChannel()) {
    themeStore.playAudio('voice_disconnect');
    triggerVoice('warning');
  }
};

const openContextMenu = (event: MouseEvent, item: Channel | Category, type: 'channel' | 'category') => {
  event.preventDefault();
  event.stopPropagation();
  closeContextMenus();
  contextMenuTrigger.value = event.currentTarget as HTMLElement | null;
  if (type === 'channel') {
    selectedChannel.value = item as Channel;
    showChannelContextMenu.value = true;
  } else {
    selectedCategory.value = item as Category;
    showCategoryContextMenu.value = true;
  }
  contextMenuPosition.value = stylePoint(event);
};

const openChannelContextMenu = (event: MouseEvent, channel: Channel) => openContextMenu(event, channel, 'channel');
const openCategoryContextMenu = (event: MouseEvent, category: Category) => openContextMenu(event, category, 'category');

const closeContextMenus = () => {
  showChannelContextMenu.value = false;
  showCategoryContextMenu.value = false;
  showThreadContextMenu.value = false;
};

const openThreadContextMenu = (event: MouseEvent, thread: ThreadWithDetails) => {
  event.preventDefault();
  event.stopPropagation();
  closeContextMenus();
  if (isOptimisticThreadId(thread.id)) return;
  contextMenuTrigger.value = event.currentTarget as HTMLElement | null;
  selectedThread.value = thread;
  showThreadContextMenu.value = true;
  contextMenuPosition.value = stylePoint(event);
};

const handleInviteUsers = () => openInviteModal();

const handleEditChannel = (channel: Channel) => {
  selectedChannel.value = channel;
  showChannelEditModal.value = true;
};

const handleDeleteChannel = (channel: Channel) => {
  selectedChannel.value = channel;
  confirmationConfig.value = {
    title: 'Delete channel',
    message: `Are you sure you want to delete #${channel.name}?`,
    secondaryMessage: 'This action cannot be undone. All messages in this channel will be permanently deleted.',
    confirmButtonText: 'Delete channel',
    requireConfirmation: true,
    confirmationText: channel.name,
    onConfirm: async () => {
      try {
        await serverChannelStore.deleteChannel(channel.id);
        closeConfirmationModal();
      } catch (error) {
        debug.error('Failed to delete channel:', error);
        toast.error(t('channel.errors.deleteFailed'));
        closeConfirmationModal();
      }
    }
  };
  showConfirmationModal.value = true;
};

const handleCreateChannelInCategory = (category: Category) => emit('createChannel', category.id);

const handleEditCategory = (category: Category) => {
  selectedCategory.value = category;
  showCategoryEditModal.value = true;
};

// Set when the confirmation input requests deleting the contained channels.
const deleteCategoryWithChannels = ref(false);

const handleDeleteCategory = (category: Category) => {
  selectedCategory.value = category;
  const channelCount = (props.categoryChannels[category.id] || []).length;
  deleteCategoryWithChannels.value = false; // Reset on each delete attempt
  
  let secondaryMsg = 'This action cannot be undone.';
  if (channelCount > 0) {
    secondaryMsg = `This category contains ${channelCount} channel(s). Channels will be moved to the top of the channel list (uncategorized). To also delete all channels, type "${category.name} DELETE" instead of just "${category.name}".`;
  }
  
  confirmationConfig.value = {
    title: 'Delete category',
    message: `Are you sure you want to delete "${category.name}"?`,
    secondaryMessage: secondaryMsg,
    confirmButtonText: 'Delete category',
    requireConfirmation: true,
    confirmationText: category.name,
    onConfirm: async () => {
      try {
        const confirmInput = document.querySelector<HTMLInputElement>('.confirmation-section input');
        const deleteChannels = confirmInput?.value?.trim().toUpperCase().endsWith(' DELETE') || false;
        
        await serverChannelStore.deleteCategory(category.id, deleteChannels);
        closeConfirmationModal();
      } catch (error) {
        debug.error('Failed to delete category:', error);
        toast.error(t('category.errors.deleteFailed'));
        closeConfirmationModal();
      }
    }
  };
  showConfirmationModal.value = true;
};

const handleLeaveThread = async () => {
  if (!selectedThread.value) return;
  try {
    const threadId = selectedThread.value.id;
    if (await threadService.leaveThread(threadId)) {
      threadsStore.patch(threadId, { is_member: false });
    }
  } catch (error) {
    debug.error('Failed to leave thread:', error);
  }
};

const handleEditThread = (thread: ThreadWithDetails) => {
  selectedThread.value = thread;
  showThreadEditModal.value = true;
};

const handleOpenSplitView = (thread: ThreadWithDetails) => {
  // Opens in the side panel; the full-page route is not used here.
  emit('openThread', thread);
};

const handleCloseThread = async (thread: ThreadWithDetails) => {
  try {
    if (await threadService.archiveThread(thread.id)) {
      threadsStore.patch(thread.id, { archived: true });
    }
  } catch (error) {
    debug.error('Failed to close thread:', error);
  }
};

const handleReopenThread = async (thread: ThreadWithDetails) => {
  try {
    if (await threadService.unarchiveThread(thread.id)) {
      threadsStore.patch(thread.id, { archived: false });
    }
  } catch (error) {
    debug.error('Failed to reopen thread:', error);
  }
};

const handleLockThread = async (thread: ThreadWithDetails) => {
  try {
    if (await threadService.lockThread(thread.id)) {
      threadsStore.patch(thread.id, { locked: true, archived: true });
    }
  } catch (error) {
    debug.error('Failed to lock thread:', error);
  }
};

const handleUnlockThread = async (thread: ThreadWithDetails) => {
  try {
    if (await threadService.unlockThread(thread.id)) {
      threadsStore.patch(thread.id, { locked: false });
    }
  } catch (error) {
    debug.error('Failed to unlock thread:', error);
  }
};

const handleDeleteThread = (thread: ThreadWithDetails) => {
  confirmationConfig.value = {
    title: 'Delete thread',
    message: `Are you sure you want to delete "${thread.name}"?`,
    secondaryMessage: 'This will permanently delete the thread and all its messages. This action cannot be undone.',
    confirmButtonText: 'Delete thread',
    requireConfirmation: false,
    confirmationText: thread.name,
    onConfirm: async () => {
      try {
        if (await threadService.deleteThread(thread.id)) {
          threadsStore.remove(thread.id);
        }
        closeConfirmationModal();
        // Deleting the open thread falls back to its parent channel.
        if (selectedThreadId.value === thread.id) {
          selectedThreadId.value = null;
          if (thread.channel_id) {
            router.push({
              name: 'ChatChannel',
              params: {
                serverId: props.currentServer?.id,
                channelId: thread.channel_id
              }
            });
          }
        }
      } catch (error) {
        debug.error('Failed to delete thread:', error);
        closeConfirmationModal();
      }
    }
  };
  showConfirmationModal.value = true;
};

const closeChannelEditModal = () => showChannelEditModal.value = false;
const closeCategoryEditModal = () => showCategoryEditModal.value = false;
const closeThreadEditModal = () => showThreadEditModal.value = false;
const closeConfirmationModal = () => showConfirmationModal.value = false;
const handleChannelUpdated = (_updatedChannel: Channel) => {}; // Store handles updates
const handleCategoryUpdated = (_updatedCategory: Category) => {}; // Store handles updates
const handleThreadUpdated = () => {
  loadActiveThreads(true); // Force refresh after mutation
};

// Lifecycle Hooks
watch(() => props.currentServer?.id, async (newServerId, oldServerId) => {
  debug.log('Server changed:', { old: oldServerId, new: newServerId });
  if (newServerId) {
    initializeCategoryStates();
    // Awaited so voice channel state is present before render.
    debug.log('Setting up voice channel broadcast for server:', newServerId);
    await serverUsersStore.setupVoiceChannelBroadcast(newServerId);
    debug.log('Voice channel broadcast setup complete for server:', newServerId);
    debug.log('Users in voice channels:', serverUsersStore.usersInVoiceChannels);
  }
}, { immediate: true });

// NOTE: the watch above runs with { immediate: true }; repeating the setup in
// onMounted initializes the broadcast twice.

// Bounds the cache to the visible server's categories.
watch(() => props.currentServer?.id, () => categoryChannelsCache.clear());

watch(() => props.currentServer?.id, (newServerId) => {
  if (newServerId) {
    loadActiveThreads();
    loadMutedChannels();
  }
}, { immediate: true });

// selectedThreadId tracks the route param used by the full thread view.
watch(() => route.params.threadId, (threadId) => {
  if (threadId && typeof threadId === 'string') {
    selectedThreadId.value = threadId;
  } else {
    selectedThreadId.value = null;
  }
}, { immediate: true });

// Keyboard and screen-reader layer: row names, roving focus, context menus
// from the keyboard, Move up/down.

const { polite, assertive } = useAnnouncer();
const idPrefix = uid('channels');
const ids = {
  voiceJoin: `${idPrefix}-voice-join`,
  voiceOpen: `${idPrefix}-voice-open`,
  voicePreview: `${idPrefix}-voice-preview`,
};
const categoryHeaderId = (categoryId: string) => `${idPrefix}-cat-${categoryId}`;
const categoryListId = (categoryId: string) => `${idPrefix}-list-${categoryId}`;

const isChannelUnread = (channelId: string): boolean =>
  hasUnreadMessages(channelId) && channelId !== props.currentChannelId;

const channelItemClasses = (channel: Channel, categoryId: string | null) => ({
  'selected': channel.id === props.currentChannelId && !selectedThreadId.value,
  'in-collapsed-category': categoryId !== null && collapsedCategories.value.has(categoryId),
  'dragging': dragState.value.isDragging && dragState.value.draggedItem?.id === channel.id,
  'voice-channel': isVoiceType(channel.type),
  'voice-connected': isVoiceType(channel.type) && isUserInVoiceChannel(channel.id),
  'channel-unread': isChannelUnread(channel.id),
  'muted': mutedChannelIds.value.has(channel.id),
});

const channelHref = (channelId: string): string =>
  router.resolve({ name: 'ChatChannel', params: { serverId: props.currentServer.id, channelId } }).href;

const threadHref = (thread: ThreadWithDetails): string =>
  router.resolve({ name: 'ThreadView', params: { serverId: props.currentServer.id, threadId: thread.id } }).href;

/**
 * A text channel is a link to its chat. A voice channel is a button, since
 * activating it joins the call; its description says so.
 */
const channelRowAttrs = (channel: Channel): Record<string, string> => {
  if (!isVoiceType(channel.type)) return { href: channelHref(channel.id) };
  let hint = ids.voiceJoin;
  if (isUserInVoiceChannel(channel.id)) hint = ids.voiceOpen;
  else if (isMobile.value) hint = ids.voicePreview;
  return { type: 'button', 'aria-describedby': hint };
};

/** Text after the visible name in a row's accessible name: type, then state. */
const channelStateText = (channel: Channel): string => {
  const voice = isVoiceType(channel.type);
  const parts = [voice ? t('chatNav.channel.voice') : t('chatNav.channel.text')];
  if (voice) {
    if (isUserInVoiceChannel(channel.id)) parts.push(t('chatNav.channel.youAreConnected'));
    const present = getUsersInVoiceChannel(channel.id).length;
    if (present > 0) parts.push(t('chatNav.channel.connected', { count: present }, present));
  }
  if (isChannelUnread(channel.id)) parts.push(t('chatNav.channel.unread'));
  const mentions = getChannelUnreadMentions(channel.id);
  if (mentions > 0) parts.push(t('chatNav.channel.mentions', { count: mentions }, mentions));
  if (mutedChannelIds.value.has(channel.id)) parts.push(t('chatNav.channel.muted'));
  if (serverChannelStore.isPrivateChannel(channel.id)) parts.push(t('chatNav.channel.private'));
  const lock = channelLockKey(channel);
  if (lock) parts.push(t(lock));
  return `, ${parts.join(', ')}`;
};

const onChannelClick = (event: MouseEvent, channel: Channel) => {
  event.preventDefault();
  if (isVoiceType(channel.type)) void handleVoiceChannelClick(channel.id);
  else selectChannel(channel.id);
};

const sidebarEl = ref<HTMLElement | null>(null);
const roving = useRovingTabindex(sidebarEl, { itemSelector: '[data-roving-item]', typeahead: true });

const navItem = (kind: string, id: string): HTMLElement | null =>
  sidebarEl.value?.querySelector<HTMLElement>(`[data-nav-kind="${kind}"][data-nav-id="${CSS.escape(id)}"]`) ?? null;

const focusNavItem = (kind: string, id: string) => {
  const el = navItem(kind, id);
  if (el && focusElement(el)) roving.sync();
};

// Rows are rendered by the draggable lists, whose updates do not re-render this
// component; the observer keeps exactly one tab stop as rows come and go.
let rovingSyncQueued = false;
const rovingObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => {
  if (rovingSyncQueued) return;
  rovingSyncQueued = true;
  queueMicrotask(() => {
    rovingSyncQueued = false;
    roving.sync();
  });
});

// The tab stop follows the current channel while focus is elsewhere.
watch([() => props.currentChannelId, selectedThreadId], async () => {
  await nextTick();
  const root = sidebarEl.value;
  if (!root || root.contains(document.activeElement)) return;
  roving.items().forEach(el => el.setAttribute('tabindex', '-1'));
  roving.sync();
});

const menuPointFor = (el: HTMLElement) => {
  const r = styleRect(el);
  return { x: r.left + Math.min(24, r.width / 2), y: r.bottom };
};

const openContextMenuFromKeyboard = (el: HTMLElement, kind: string, id: string) => {
  closeContextMenus();
  if (kind === 'channel' || kind === 'voice-chat') {
    const channel = props.channels.find(c => c.id === id);
    if (!channel) return;
    selectedChannel.value = channel;
    showChannelContextMenu.value = true;
  } else if (kind === 'category') {
    const category = storeCategories.value.find((c: Category) => c.id === id);
    if (!category) return;
    selectedCategory.value = category;
    showCategoryContextMenu.value = true;
  } else if (kind === 'thread') {
    const thread = threadsStore.byId[id] ?? findActiveThread(id);
    if (!thread || isOptimisticThreadId(thread.id)) return;
    selectedThread.value = thread;
    showThreadContextMenu.value = true;
  } else {
    return;
  }
  contextMenuTrigger.value = el;
  contextMenuPosition.value = menuPointFor(el);
};

const findActiveThread = (threadId: string): ThreadWithDetails | null => {
  for (const channel of props.channels) {
    const hit = getChannelActiveThreads(channel.id).find(th => th.id === threadId);
    if (hit) return hit;
  }
  return null;
};

const onNavKeydown = (event: KeyboardEvent) => {
  const el = event.target as HTMLElement | null;
  const kind = el?.dataset?.navKind;
  const id = el?.dataset?.navId;
  if (!el || !kind || !id) return;
  if (isContextMenuKey(event)) {
    event.preventDefault();
    openContextMenuFromKeyboard(el, kind, id);
    return;
  }
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    const delta = event.key === 'ArrowUp' ? -1 : 1;
    if (kind === 'channel') {
      const channel = props.channels.find(c => c.id === id);
      if (channel && canMoveChannel(channel, delta)) {
        event.preventDefault();
        void moveChannel(channel, delta);
      }
    } else if (kind === 'category') {
      const category = storeCategories.value.find((c: Category) => c.id === id);
      if (category && canMoveCategory(category, delta)) {
        event.preventDefault();
        void moveCategory(category, delta);
      }
    }
    return;
  }
  // A native link activates on Enter only; Space activates it as it does a button.
  if (event.key === ' ' && el.tagName === 'A') {
    event.preventDefault();
    el.click();
    return;
  }
  roving.onKeydown(event);
};

// Move up/down: the keyboard and single-pointer alternative to dragging.

const byOrder = (a: Channel, b: Channel) => (a.order || 0) - (b.order || 0);

const channelCategoryId = (channel: Channel): string | null => {
  for (const [categoryId, list] of Object.entries(props.categoryChannels || {})) {
    if (list.some(c => c.id === channel.id)) return categoryId;
  }
  return null;
};

/** Every channel in the channel's own list, collapsed categories included, in order. */
const siblingChannels = (categoryId: string | null): Channel[] => {
  if (categoryId === null) return [...orphanChannels.value];
  const members = new Set((props.categoryChannels[categoryId] || []).map(c => c.id));
  return props.channels.filter(c => members.has(c.id)).sort(byOrder);
};

const canMoveChannel = (channel: Channel, delta: -1 | 1): boolean => {
  if (!canDragAndDrop.value) return false;
  const list = siblingChannels(channelCategoryId(channel));
  const index = list.findIndex(c => c.id === channel.id);
  return index >= 0 && index + delta >= 0 && index + delta < list.length;
};

const moveChannel = async (channel: Channel, delta: -1 | 1) => {
  if (!canMoveChannel(channel, delta)) return;
  const categoryId = channelCategoryId(channel);
  const list = siblingChannels(categoryId);
  const index = list.findIndex(c => c.id === channel.id);
  const next = [...list];
  [next[index], next[index + delta]] = [next[index + delta], next[index]];
  // The store reorders optimistically before its first await.
  const saved = serverChannelStore.reorderChannelsInCategory(categoryId, next);
  await nextTick();
  focusNavItem('channel', channel.id);
  polite(t('chatNav.channel.moved', { name: channel.name, position: index + delta + 1, total: list.length }));
  try {
    await saved;
  } catch (error) {
    debug.error('Failed to move channel:', error);
    assertive(t('chatNav.channel.moveFailed', { name: channel.name }));
    await nextTick();
    focusNavItem('channel', channel.id);
  }
};

const canMoveCategory = (category: Category, delta: -1 | 1): boolean => {
  if (!canDragAndDrop.value) return false;
  const list = reorderableCategories.value;
  const index = list.findIndex(c => c.id === category.id);
  return index >= 0 && index + delta >= 0 && index + delta < list.length;
};

const moveCategory = async (category: Category, delta: -1 | 1) => {
  if (!canMoveCategory(category, delta)) return;
  const list = reorderableCategories.value;
  const index = list.findIndex(c => c.id === category.id);
  const next = [...list];
  [next[index], next[index + delta]] = [next[index + delta], next[index]];
  const saved = serverChannelStore.updateCategoryOrder(next);
  // The category list re-mounts on an order change (categoriesKey).
  await nextTick();
  focusNavItem('category', category.id);
  polite(t('chatNav.channel.moved', { name: category.name, position: index + delta + 1, total: list.length }));
  try {
    await saved;
  } catch (error) {
    debug.error('Failed to move category:', error);
    assertive(t('chatNav.channel.moveFailed', { name: category.name }));
    await nextTick();
    focusNavItem('category', category.id);
  }
};

// --- SERVER BANNER ---
// Stored banners are cropped to 16:5 (imageCrop server_banner); 640x200 covers the sidebar at 2x.
const BANNER_BOX = { width: 640, height: 200 } as const;
const bannerFailed = ref(false);
const bannerSrc = computed(() => getServerBannerUrl(props.currentServer?.banner, BANNER_BOX));
const bannerFullSize = computed(() => getRawServerBannerUrl(props.currentServer?.banner));
const showBanner = computed(() => props.currentServer?.sidebar_banner === true && !!bannerSrc.value && !bannerFailed.value);
watch(() => props.currentServer?.banner, () => { bannerFailed.value = false; });

// The name bar is transparent over the banner and solid once the banner's end has
// scrolled under it.
const bannerEndEl = ref<HTMLElement | null>(null);
const bannerCovered = ref(false);
let bannerObserver: IntersectionObserver | null = null;

const scrollParentOf = (el: HTMLElement): HTMLElement | null => {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return p;
  }
  return null;
};

watch(bannerEndEl, (el) => {
  bannerObserver?.disconnect();
  bannerObserver = null;
  bannerCovered.value = false;
  if (!el || typeof IntersectionObserver === 'undefined') return;
  const header = sidebarEl.value?.querySelector('.server-header') as HTMLElement | null;
  const inset = header?.offsetHeight ?? 48;
  bannerObserver = new IntersectionObserver(
    // rootBounds is the scroll box less the name bar; above its top the banner has scrolled under the bar.
    ([entry]) => { bannerCovered.value = !entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? inset); },
    { root: scrollParentOf(el), rootMargin: `-${inset}px 0px 0px 0px` },
  );
  bannerObserver.observe(el);
}, { flush: 'post' });

onMounted(() => {
  if (sidebarEl.value) rovingObserver?.observe(sidebarEl.value, { childList: true, subtree: true });
});

onUnmounted(() => {
  cancelChannelPrefetch();
  rovingObserver?.disconnect();
  bannerObserver?.disconnect();
});



</script>

<style scoped>
/* .channel-sidebar {
  width: 240px;
  min-width: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  height: 100vh;
} 
.channel-sidebar {
  background: var(--h-channel-sidebar, var(--background-tertiary));
  height: 100%;
}
*/

.server-header {
  position: relative;
  z-index: 10;
  flex-shrink: 0;
}

/* With a banner the name bar stays at the top while the banner scrolls under it. */
.server-header.has-banner {
  position: sticky;
  top: 0;
}

.server-header.over-banner .server-name {
  background: linear-gradient(to bottom, rgb(0 0 0 / 0.55), rgb(0 0 0 / 0));
  border-bottom-color: transparent;
  color: #fff;
  text-shadow: 0 1px 2px rgb(0 0 0 / 0.6);
}

.server-header.over-banner .server-name:hover {
  background: linear-gradient(to bottom, rgb(0 0 0 / 0.7), rgb(0 0 0 / 0.1));
}

.server-header.over-banner .server-name-chevron {
  color: #fff;
}

/* 16:5, the stored crop; a 112px floor keeps it taller than the name bar on a narrow
   sidebar, trimming the sides. 47px under the name bar, pulled up beneath it. */
.server-banner {
  position: relative;
  aspect-ratio: 16 / 5;
  min-height: 112px;
  margin-top: -47px;
  overflow: hidden;
  background: var(--background-secondary);
}

.server-banner-end {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
}

.server-name {
  width: 100%;
  border: none;
  border-radius: 0;
  font-family: inherit;
  font-size: 1.2rem;
  font-weight: 500;
  background: var(--background-tertiary);
  color: var(--text-primary);
  position: relative;
  z-index: 1;
  text-align: center;
  cursor: pointer;
  transition: 0.2s ease-in-out;
  /* 47px on the sidebar card's 1px top border: bottom edge at 48. */
  height: 47px;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1.2rem;
  border-bottom: 1px solid var(--border-color);
  gap: 6px;
  padding: 0 12px;
}

.server-name:hover {
  background: var(--background-secondary);
}

.server-name:focus-visible {
  outline: 2px solid var(--border-focus, var(--harmony-primary));
  outline-offset: -2px;
}

.server-name-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.server-remote-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.server-remote-strip {
  padding: 4px 12px;
  font-size: 0.75rem;
  color: var(--text-muted);
  background: var(--background-tertiary);
  border-bottom: 1px solid var(--border-color);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.server-remote-strip strong {
  color: var(--text-secondary);
  font-weight: 600;
}

.server-name-chevron {
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.server-name.open .server-name-chevron {
  transform: rotate(180deg);
}

/* draggable requires one wrapper element per item; holds channel plus participants. */
.channel-wrapper {
  display: block;
  width: 100%;
}

.channel-list-items,
.channel-threads {
  list-style: none;
  margin: 0;
  padding: 0;
}

.category-heading {
  margin: 0;
  font: inherit;
}

/* Row plus its sibling "Open chat" button for voice channels. */
.channel-row {
  position: relative;
}

/* Channel row inset, shared with the thread rows nested under a channel:
   margin, left padding, and the space between the channel icon and name. */
.channel-sidebar {
  --channel-row-margin: 4px;
  --channel-row-pad: 10px;
  --channel-icon-gap: 8px;
}

.channel-item {
  box-sizing: border-box;
  border: none;
  background: transparent;
  font-family: inherit;
  text-align: left;
  text-decoration: none;
  padding: 6px 10px 6px var(--channel-row-pad);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  align-items: center;
  width: calc(100% - 2 * var(--channel-row-margin));
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  position: relative;
  border-radius: 4px;
  margin: 1px var(--channel-row-margin);
}

.channel-item:hover {
  background-color: var(--channel-item-hover-bg, var(--background-quaternary));
}

.channel-item:focus-visible,
.category-header:focus-visible,
.channel-thread-item:focus-visible .thread-name,
.chat-btn:focus-visible {
  outline: 2px solid var(--border-focus, var(--harmony-primary));
  outline-offset: -2px;
}

.channel-thread-item:focus-visible {
  outline: none;
}

.channel-row.voice-row .channel-item {
  padding-right: 36px;
}

.channel-item.selected {
  position: relative;
  background-color: var(--channel-item-selected-bg, var(--background-quaternary));
  color: var(--text-primary);
}

.channel-item.voice-connected {
  background-color: color-mix(in srgb, var(--success) 10%, transparent);
}

.channel-item.voice-connected:hover {
  background-color: color-mix(in srgb, var(--success) 15%, transparent);
}

/* Muted channels dim the name and icon. The name keeps the muted text token
   (4.5:1); the icons fade further. The bell-off indicator and the mention
   badge stay at full strength: mentions cut through mute, and the bell-off
   icon is the mute cue. */
.channel-item.muted .channel-content {
  color: var(--text-muted);
}

.channel-item.muted .channel-content > svg {
  opacity: 0.6;
}

.channel-item.muted:hover .channel-content {
  color: var(--text-secondary);
}

/* Overrides channel-unread bold/white on muted channels regardless of the
   unread count reported by the store. */
.channel-item.muted.channel-unread {
  color: var(--text-secondary);
}

.channel-item.muted.channel-unread .channel-name {
  font-weight: 400;
}

.channel-lock {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  margin-left: 4px;
  color: var(--text-tertiary);
}

.muted-icon {
  color: var(--text-tertiary);
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  margin-left: auto;
}

.channel-item.dragging {
  opacity: 0.6;
  transform: scale(1.02) rotate(2deg);
  box-shadow: var(--shadow-large);
  z-index: 1000;
  background-color: color-mix(in srgb, var(--harmony-primary) 20%, transparent);
  border: 1px solid var(--harmony-primary);
}

.channel-item.channel-unread {
  color: var(--text-primary);
}

.channel-item.channel-unread .channel-name {
  font-weight: 600;
}

.unread-dot {
  position: absolute;
  left: -4px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-primary);
  flex-shrink: 0;
}

.channel-content {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
}

.channel-content > svg {
  margin-right: 8px;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.channel-name {
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.category .channel-item {
  padding-left: 20px;
}

.category-section {
  margin-bottom: 8px;
}

.category-header {
  box-sizing: border-box;
  width: calc(100% - 8px);
  border: none;
  background: none;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  padding: 8px 10px;
  margin-top: 6px;
  display: flex;
  font-size: 12px;
  font-weight: 600;
  align-items: center;
  transition: all 0.15s ease;
  border-radius: 4px;
  margin: 2px 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}

.category-header:hover {
  background-color: var(--background-modifier-hover);
}

.category-arrow {
  width: 12px;
  height: 12px;
  transition: transform 0.2s ease;
  flex-shrink: 0;
  margin: auto 3px auto 0;
}

.category-arrow.rotated {
  transform: rotate(-90deg);
}

.channel-list {
  transition: all 0.2s ease;
}

.collapsed-list {
  display: block; /* Always show if there are important channels */
}

.channel-item.in-collapsed-category {
  opacity: 0.8;
}

.channel-item.in-collapsed-category.selected {
  opacity: 1;
  background-color: var(--channel-item-selected-bg, var(--background-quaternary));
  color: var(--text-primary);
}

.category-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* .category-header.has-visible-channels.collapsed .category-name {
  font-size: 12px;
} */

.notification-badge {
  min-width: 18px;
  height: 18px;
  background-color: var(--error-fill);
  border-radius: var(--radius-full);
  margin-left: auto;
  margin-right: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-on-primary);
  line-height: 1;
  flex-shrink: 0;
}

.voice-controls {
  display: flex;
  align-items: center;
  gap: 4px;
}

.voice-controls,
.chat-btn {
  opacity: 0;
  transition: opacity 0.2s ease;
}

.channel-row:hover .voice-controls,
.channel-row:focus-within .voice-controls,
.channel-row.voice-connected .voice-controls,
.channel-row:hover .chat-btn,
.channel-row:focus-within .chat-btn,
.channel-row.voice-connected .chat-btn {
  opacity: 1;
}

.chat-btn {
  position: absolute;
  top: 50%;
  right: 10px;
  transform: translateY(-50%);
}

@media (hover: none) {
  .chat-btn {
    opacity: 1;
  }
}

.voice-btn {
  background: none;
  border: none;
  padding: 4px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}

.voice-btn:hover {
  background-color: var(--background-modifier-hover);
  color: var(--text-primary);
}

.voice-btn svg {
  width: 16px;
  height: 16px;
}

.chat-btn {
  color: var(--text-muted);
}

.chat-btn:hover {
  background-color: var(--background-modifier-hover);
  color: var(--text-primary);
}

.user-count {
  font-size: 10px;
  background-color: var(--background-modifier-active);
  padding: 2px 6px;
  border-radius: var(--radius-full);
  color: var(--text-primary);
  font-weight: 600;
  min-width: 16px;
  text-align: center;
}

.orphan-channels {
  min-height: 20px;
  transition: all 0.2s ease;
  border-radius: 4px;
  position: relative;
  margin-bottom: 12px;
  padding: 4px;
}

.categories-container {
  flex: 1;
  padding-bottom: 96px;
}

/* Thread items nested under a channel */
.channel-thread-item {
  box-sizing: border-box;
  text-decoration: none;
  display: flex;
  align-items: center;
  gap: 6px;
  /* Label starts where the channel name does: icon is 16px wide. */
  padding: 2px 0 2px calc(var(--channel-row-pad) + 16px + var(--channel-icon-gap));
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 14px;
  transition: all 0.1s ease;
  position: relative;
  margin: 0 var(--channel-row-margin);
  width: calc(100% - 2 * var(--channel-row-margin));
}
.channel-thread-item .thread-name {
  padding: 6px;
  border-radius: 4px;
  width: 100%;
}
.channel-thread-item .thread-name:hover {
  background: var(--channel-item-hover-bg, var(--background-quaternary));
}

.channel-thread-item.selected {
  color: var(--text-primary);
}
.channel-thread-item.selected .thread-name {
  color: var(--text-primary);
  background: var(--channel-item-selected-bg, var(--background-quaternary));
}

/* Tree line joining a thread to its parent channel, under the icon's centre */
.channel-thread-item .thread-branch {
  position: absolute;
  left: calc(var(--channel-row-pad) + 7px);
  width: 10px;
  height: 100%;
  pointer-events: none;
}

/* Vertical segment */
.channel-thread-item .thread-branch::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 50%;
  width: 2px;
  background: var(--text-muted);
  opacity: 0.5;
}

/* Horizontal segment reaching the label */
.channel-thread-item .thread-branch::after {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  /* Ends 3px short of the label */
  width: calc(var(--channel-icon-gap) + 6px);
  height: 2px;
  background: var(--text-muted);
  opacity: 0.5;
  border-radius: 0 2px 2px 0;
}

/* Last item: corner rounds off */
.channel-thread-entry:last-child .thread-branch::before {
  border-bottom-left-radius: 4px;
}

/* Otherwise the vertical segment runs to the next item */
.channel-thread-entry:not(:last-child) .thread-branch::before {
  bottom: 0;
}

.channel-thread-item .thread-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}

:global(.dragging-channel) {
  cursor: grabbing !important;
}

:global(.dragging-channel *) {
  cursor: grabbing !important;
}

.empty-category-placeholder {
  padding: 10px;
  text-align: center;
  font-size: 12px;
  color: var(--text-tertiary);
  border: 1px dashed var(--border-hover);
  border-radius: 4px;
  margin: 4px 0;
  transition: background-color 0.2s ease;
}

.empty-category-placeholder:hover {
  background-color: var(--background-modifier-hover);
}

/* =====================================
   MOBILE RESPONSIVE STYLES
   ===================================== */

@media (max-width: 768px) {
  .server-header {
    width:100%;
  }
  .channel-sidebar {
    --channel-row-margin: 8px;
    --channel-row-pad: 24px;
    /* svg margin-right plus the .channel-content gap */
    --channel-icon-gap: 20px;
  }

  /* 48px minimum touch target */
  .channel-item,
  .category-header {
    min-height: 48px;
    padding: 12px 24px;
    border-radius: 12px;
    margin: 4px 8px;
  }

  .channel-item {
    display: flex;
    align-items: center;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    width: calc(100% - 18px);
  }

  .channel-item:active {
    transform: scale(0.98);
    background: var(--background-modifier-active);
  }

  .channel-content {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
  }

  .channel-name {
    font-size: 16px;
    font-weight: 500;
  }

  .category-header {
    margin: 16px 0 8px;
  }

  .category-name {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.5px;
  }

  .voice-channel-item {
    padding: 16px;
    border-radius: 12px;
  }

  .voice-info {
    padding: 12px 0;
  }

  .voice-users {
    gap: 8px;
  }

  .voice-user {
    padding: 8px 12px;
    border-radius: 8px;
    min-height: 44px;
  }


  /* Drag is disabled on mobile; pointer cursor and no text selection. */
  .drag-disabled {
    user-select: none;
    -webkit-user-select: none;
  }

  .drag-disabled .channel-item,
  .drag-disabled .category-header {
    cursor: pointer !important;
  }
}

@media (max-width: 1024px) and (min-width: 769px) {
  .channel-sidebar {
    --channel-row-pad: 14px;
  }

  .channel-item,
  .category-header {
    min-height: 44px;
    padding: 10px 14px;
  }

  .channel-name {
    font-size: 15px;
  }

  .category-arrow {
    margin: 5px 3px auto 0;
  }
}
</style>