<template>
  <section
    :id="id"
    ref="rootEl"
    class="call-side-chat"
    :class="{ 'is-resizing': resizing }"
    :aria-label="t('voice.callChat.region', { name: title })"
    data-testid="call-side-chat"
  >
    <div
      class="call-chat-resize"
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      :aria-label="t('voice.callChat.resize')"
      :aria-valuenow="chat.width.value"
      :aria-valuemin="CALL_CHAT_WIDTH.min"
      :aria-valuemax="CALL_CHAT_WIDTH.max"
      @pointerdown="startResize"
      @keydown="onResizeKey"
    />
    <header class="call-chat-header">
      <h3 class="call-chat-title">
        <Icon :name="isDM ? 'message-square' : 'hash'" :size="16" class="call-chat-title-icon" aria-hidden="true" />
        <span class="call-chat-name">{{ title }}</span>
      </h3>
      <button
        ref="closeButton"
        type="button"
        class="call-chat-close"
        :title="t('voice.callChat.close')"
        :aria-label="t('voice.callChat.close')"
        data-testid="call-chat-close"
        @click="emit('close')"
      >
        <Icon name="x" :size="16" />
      </button>
    </header>

    <div class="call-chat-body">
      <UnifiedContentArea
        v-if="chat.routed.value"
        :mode="ViewMode.CHAT"
        :chat-messages="messages"
        :is-loading="loading"
        :is-d-m="isDM"
        :channel-id="channelId"
        :conversation-id="conversationId"
        :channel-name="isDM ? undefined : title"
        :dm-username="isDM ? title : undefined"
        :view-type="isDM ? ViewType.DM : ViewType.CHAT"
        :current-view="isDM ? 'dm' : 'chat'"
        @load-more-messages="loadMore"
      />
      <div v-else class="call-chat-away" data-testid="call-chat-away">
        <p class="call-chat-away-text">{{ t('voice.callChat.awayText') }}</p>
        <button type="button" class="call-chat-away-action" @click="chat.showTarget()">
          {{ t('voice.callChat.awayAction') }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import UnifiedContentArea from '@/components/common/UnifiedContentArea.vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import { useChatStore } from '@/stores/useChat'
import { useDMStore } from '@/stores/useDM'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { useUserData } from '@/composables/useUserData'
import {
  channelListLoading,
  conversationListLoading,
  loadOlderChannelMessages,
  loadOlderConversationMessages,
} from '@/composables/chatPaging'
import { ViewMode, ViewType } from '@/types/viewTypes'
import { toStylePx } from '@/utils/appZoom'
import { CALL_CHAT_WIDTH, setCallChatWidth, useCallChat } from './callChat'

const props = withDefaults(defineProps<{
  id: string
  /** Focus moves to the composer on mount. */
  autofocus?: boolean
}>(), { autofocus: false })

const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useT()
const chat = useCallChat()
const chatStore = useChatStore()
const dmStore = useDMStore()
const channelStore = useServerChannelStore()
const voice = useUnifiedVoiceChannelStore()
const { getUserDisplayName } = useUserData()

const rootEl = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)

const isDM = computed(() => chat.target.value?.kind === 'dm')
const channelId = computed(() => (chat.target.value?.kind === 'channel' ? chat.target.value.channelId : undefined))
const conversationId = computed(() => (chat.target.value?.kind === 'dm' ? chat.target.value.conversationId : undefined))

const messages = computed(() => (isDM.value ? dmStore.currentDMMessages : chatStore.messages))
const loading = computed(() => (isDM.value ? conversationListLoading.value : channelListLoading.value))

const title = computed(() => {
  if (isDM.value) {
    const other = voice.dmOtherUserId as string | null
    const name = other ? getUserDisplayName(other).value : ''
    return name || (voice.effectiveChannelName as string) || ''
  }
  const channel = channelStore.channels.find((c: { id: string }) => c.id === channelId.value) as { name?: string } | undefined
  return channel?.name || (voice.effectiveChannelName as string) || ''
})

const loadMore = () => (isDM.value
  ? loadOlderConversationMessages(conversationId.value)
  : loadOlderChannelMessages(channelId.value))

// RESIZE
// The handle sits on the panel's left edge: moving it left widens the panel.
const RESIZE_STEP = 16
const resizing = ref(false)
let resizeFrom: { x: number; width: number; pointerId: number; el: HTMLElement } | null = null

const onResizeMove = (event: PointerEvent) => {
  if (!resizeFrom || event.pointerId !== resizeFrom.pointerId) return
  setCallChatWidth(resizeFrom.width + toStylePx(resizeFrom.x - event.clientX))
}

const endResize = () => {
  if (!resizeFrom) return
  const { el, pointerId } = resizeFrom
  resizeFrom = null
  resizing.value = false
  el.removeEventListener('pointermove', onResizeMove)
  el.removeEventListener('pointerup', endResize)
  el.removeEventListener('pointercancel', endResize)
  if (el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId)
}

const startResize = (event: PointerEvent) => {
  if (event.button !== 0) return
  event.preventDefault()
  const el = event.currentTarget as HTMLElement
  const panel = rootEl.value?.getBoundingClientRect().width
  resizeFrom = { x: event.clientX, width: panel ? toStylePx(panel) : chat.width.value, pointerId: event.pointerId, el }
  resizing.value = true
  el.setPointerCapture?.(event.pointerId)
  el.addEventListener('pointermove', onResizeMove)
  el.addEventListener('pointerup', endResize)
  el.addEventListener('pointercancel', endResize)
}

const onResizeKey = (event: KeyboardEvent) => {
  const next: Record<string, number> = {
    ArrowLeft: chat.width.value + RESIZE_STEP,
    ArrowRight: chat.width.value - RESIZE_STEP,
    Home: CALL_CHAT_WIDTH.min,
    End: CALL_CHAT_WIDTH.max,
  }
  if (!(event.key in next)) return
  event.preventDefault()
  setCallChatWidth(next[event.key])
}

/** The composer when the list is shown, else the close button. */
const focusStart = () => {
  const composer = rootEl.value?.querySelector<HTMLElement>('[contenteditable="true"], textarea')
  ;(composer ?? closeButton.value)?.focus()
}

// Routing follows the user's Chat toggle only: a panel mounted because the call view opened
// on its own (a stream starting) leaves the main window where it is and offers the chat.
onMounted(() => {
  if (props.autofocus) void nextTick(focusStart)
})

onBeforeUnmount(endResize)
</script>

<style scoped>
.call-side-chat {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--background-primary);
  border-left: 1px solid var(--border-primary);
}

.call-chat-resize {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -4px;
  width: 8px;
  z-index: 2;
  cursor: col-resize;
  touch-action: none;
}

.call-chat-resize::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 2px;
  background: transparent;
  transition: background 0.15s ease;
}

.call-chat-resize:hover::after,
.call-chat-resize:focus-visible::after,
.call-side-chat.is-resizing .call-chat-resize::after {
  background: var(--harmony-primary);
}

.call-chat-resize:focus-visible {
  outline: none;
}

.call-chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 48px;
  padding: 0 8px 0 16px;
  border-bottom: 1px solid var(--border-primary);
  flex-shrink: 0;
}

.call-chat-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin: 0;
  font-size: var(--font-size-md, 15px);
  font-weight: 600;
  color: var(--text-primary);
}

.call-chat-title-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.call-chat-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.call-chat-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.call-chat-close:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.call-chat-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.call-chat-away {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
  color: var(--text-secondary);
}

.call-chat-away-text {
  margin: 0;
  font-size: var(--font-size-sm);
}

.call-chat-away-action {
  padding: 8px 16px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: var(--background-secondary);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.call-chat-away-action:hover {
  background: var(--background-modifier-hover);
}

@media (max-width: 768px) {
  .call-side-chat {
    border-left: none;
  }

  .call-chat-resize {
    display: none;
  }

  .call-chat-header {
    padding-top: env(safe-area-inset-top, 0px);
  }
}
</style>
