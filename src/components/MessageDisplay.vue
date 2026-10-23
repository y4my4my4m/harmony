<template>
  <div
    class="message-display"
    data-region="messages"
    ref="messageDisplayContainer"
    data-chat-messages
    v-bind="$attrs"
    @scroll="handleScroll"
    @click="dismissMobileActions"
    data-testid="message-list"
  >
    <!-- Loading skeletons when initially loading messages -->
    <div v-if="isLoading && messages.length === 0" class="loading-skeleton">
      <div v-for="n in 5" :key="`skeleton-${n}`" class="skeleton-message">
        <div class="skeleton-avatar"></div>
        <div class="skeleton-content">
          <div class="skeleton-header">
            <div class="skeleton-username"></div>
            <div class="skeleton-timestamp"></div>
          </div>
          <div class="skeleton-text-line" style="width: 90%;"></div>
          <div class="skeleton-text-line" style="width: 70%;"></div>
        </div>
      </div>
    </div>
    
    <EmptyState
      v-else-if="!isLoading && messages.length === 0"
      class="no-messages"
      icon="message-circle"
      :title="$t('message.noMessagesHere')"
      :description="historyRestricted ? $t('message.historyRestricted') : undefined"
      :data-testid="historyRestricted ? 'history-restricted' : undefined"
    />
    <!-- Sentinel for auto-loading older messages when the top is visible -->
    <div ref="topSentinelRef" class="top-sentinel"></div>

    <!-- Loading older messages indicator. The zero-height sticky wrapper floats it
         over the top of the viewport; showing or hiding it moves nothing below. -->
    <div v-show="isLoadingOlderMessages && messages.length > 0" class="loading-older-anchor">
      <div class="loading-older-messages">
        <LoadingSpinner :size="16" />
        <span>{{ $t('message.loadingOlder') }}</span>
      </div>
    </div>

    <!-- The "New messages" line is above the view: Discord's "new messages since" bar.
         Same zero-height sticky wrapper as the indicator above. -->
    <div v-if="showUnreadBar" class="unread-bar-anchor">
      <div class="unread-bar" data-testid="unread-bar">
        <button type="button" class="unread-bar-jump" aria-keyshortcuts="Shift+PageUp" @click="jumpToDivider">
          {{ $t('message.unreadSince', { count: unreadAfterDivider, time: dividerTime }, unreadAfterDivider) }}
        </button>
        <button type="button" class="unread-bar-dismiss" @click="clearReadDivider">
          {{ $t('message.markAsRead') }}
        </button>
      </div>
    </div>
    
    <!-- Virtual scrolled message list. Each virtual row is a listitem; the
         article inside it is the focusable row (keyboard model: onListKeydown). -->
    <div
      v-if="displayItems.length > 0"
      ref="virtualListRef"
      role="list"
      :aria-label="listLabel"
      :aria-busy="isLoadingOlderMessages ? 'true' : undefined"
      :style="{ height: `${totalSize}px`, width: '100%', position: 'relative' }"
      @keydown="onListKeydown"
      @focusin="onListFocusIn"
      @focusout="onListFocusOut"
    >
      <div
        v-for="virtualRow in virtualRows"
        :key="displayItems[virtualRow.index].key"
        :data-index="virtualRow.index"
        :ref="measureElement"
        role="listitem"
        :aria-posinset="virtualRow.index + 1"
        :aria-setsize="isAllMessagesLoaded && !isDetached ? displayItems.length : -1"
        :style="{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          transform: `translateY(${virtualRow.start}px)`
        }"
      >
      <template v-for="item in [displayItems[virtualRow.index]]" :key="item.key ?? virtualRow.index">
      <!-- Blocked Group Placeholder -->
      <div
        v-if="item.type === 'blocked-group'"
        class="blocked-message-group"
        role="article"
        data-message-row
        :data-row-key="item.key"
        :tabindex="rowTabindex(item.key)"
        :aria-label="t('messageA11y.row.blocked', { count: item.count }, item.count)"
      >
        <div class="blocked-group-content">
          <Icon name="ban" :size="16" class="blocked-icon" />
          <span class="blocked-text">{{ t('messageA11y.row.blocked', { count: item.count }, item.count) }}</span>
          <span class="blocked-separator" aria-hidden="true">-</span>
          <button type="button" class="reveal-btn" @click="revealBlockedGroup(item.groupId)">
            {{ t('messageA11y.row.showBlocked', { count: item.count }, item.count) }}
          </button>
        </div>
      </div>
      
      <!-- Reported Message Placeholder -->
      <div
        v-else-if="item.type === 'reported'"
        class="reported-message-group"
        role="article"
        data-message-row
        :data-row-key="item.key"
        :tabindex="rowTabindex(item.key)"
        :aria-label="t('messageA11y.row.reported')"
      >
        <div class="reported-group-content">
          <Icon name="flag" :size="14" class="reported-icon" />
          <span class="reported-text">{{ t('messageA11y.row.reported') }}</span>
          <span class="blocked-separator" aria-hidden="true">-</span>
          <button type="button" class="reveal-btn" @click="revealedReportedIds.add(item.message.id)">{{ t('messageA11y.row.showReported') }}</button>
          <button type="button" class="reveal-btn unreport-btn" @click="unreportMessage(item.message.id)">{{ t('messageA11y.row.unhideReported') }}</button>
        </div>
      </div>

      <!-- Regular Message or Revealed Blocked Message -->
      <template v-else-if="item.type === 'message'">
        <!-- Beginning of conversation indicator (only show when all messages loaded) -->
        <ConversationBeginning
          v-if="item.index === 0 && isAllMessagesLoaded"
          :kind="beginningInfo.kind"
          :name="beginningInfo.name"
          :user-id="beginningInfo.userId"
          :history-restricted="historyRestricted"
        />

        <!-- Date separator -->
        <div v-if="shouldShowDateSeparator(item.message, item.index)" class="date-separator" role="heading" aria-level="3">
          <div class="date-separator-line" aria-hidden="true"></div>
          <span class="date-separator-text">{{ formatDateSeparator(item.message.created_at) }}</span>
          <div class="date-separator-line" aria-hidden="true"></div>
        </div>

        <!-- "New messages" divider: pinned above the first unread message on open -->
        <div v-if="item.message.id === dividerBeforeMessageId" class="new-messages-divider" role="heading" aria-level="3">
          <span class="new-messages-label" aria-hidden="true">{{ $t('message.newMessages') }}</span>
          <span class="sr-only">{{ t('messageA11y.newMessagesDivider') }}</span>
          <div class="new-messages-line" aria-hidden="true"></div>
        </div>

        <div 
          :id="`message-${item.message.id}`" 
          :data-message-id="item.message.id"
          class="message-item" 
          role="article"
          data-message-row
          :data-row-key="item.key"
          :tabindex="rowTabindex(item.key)"
          :aria-labelledby="rowLabelledBy(item.message)"
          :class="{ 
            'shake-reject': isMessageShaking(item.message.id),
            'revealed-blocked': item.isRevealed,
            'is-sending': !item.message.failed && (item.message.sending || (item.message.id?.startsWith('temp-') && !item.message.failed)),
            'is-failed': item.message.failed,
            'mentions-me': mentionsMe(item.message),
            'highlighted': highlightedRowId === item.message.id
          }"
          @mouseover="handleMessageMouseover(item.message.id)" 
          @mouseleave="handleMessageMouseleave"
          @click="clearDividerIfMessageRead(item.message)"
          @mousedown="handleMessageMouseDown"
          @dblclick="handleMessageDoubleClick(item.message.id, $event)"
          @touchstart.passive="handleMessageTouchStart(item.message.id, $event)"
          @touchend.passive="handleMessageTouchEnd(item.message.id, $event)"
          @touchmove.passive="handleMessageTouchMove"
          @touchcancel.passive="cancelMessageLongPress"
          @contextmenu="handleMessageContextMenu(item.message, $event)"
        >
          <!-- Row name parts (rowLabelledBy). The author is spoken in browse mode
               only where no visible header names it. -->
          <span
            v-if="!item.message.is_system"
            :id="`msg-head-${item.message.id}`"
            class="sr-only"
            :aria-hidden="shouldShowHeader(item.message, item.index) ? 'true' : undefined"
          >{{ getAuthorDisplayName(item.message).value }}</span>
          <span v-if="mentionsMe(item.message)" class="sr-only">{{ t('messageA11y.row.mentionsYou') }}</span>
          <span :id="`msg-meta-${item.message.id}`" class="sr-only" aria-hidden="true">{{ rowMeta(item.message) }}</span>
          <!-- Hide button for revealed blocked messages -->
          <div v-if="item.isRevealed && item.isFirstInRevealedGroup" class="revealed-blocked-banner">
            <span class="blocked-warning">{{ t('messageA11y.row.fromBlocked', { count: item.revealedCount ?? 1 }, item.revealedCount ?? 1) }}</span>
            <button type="button" class="hide-btn" @click="item.groupId && hideBlockedGroup(item.groupId)">{{ t('messageA11y.row.hide') }}</button>
          </div>
          <!-- Banner for temporarily revealed reported message -->
          <div v-if="revealedReportedIds.has(item.message?.id)" class="revealed-blocked-banner reported-banner">
            <span class="blocked-warning">{{ t('messageA11y.row.reportedBanner') }}</span>
            <button type="button" class="hide-btn" @click="revealedReportedIds.delete(item.message.id)">{{ t('messageA11y.row.hideAgain') }}</button>
          </div>

          <!-- System message: an authorless event, rendered from metadata -->
          <div v-if="item.message.is_system" class="system-message">
            <div class="system-message-content">
              <AppTimestamp class="system-timestamp" :value="item.message.created_at">
                <template v-for="(line, lineIndex) in systemTimestampLines(item.message.created_at)" :key="lineIndex"><br v-if="lineIndex > 0" />{{ line }}</template>
              </AppTimestamp>
              <div :id="`msg-body-${item.message.id}`" class="system-content">
                <SystemEventBody
                  :message="item.message"
                  :conversation-id="item.message.conversation_id || props.conversationId"
                  :user-color="resolveChatUserColor"
                  :bot-name="botDisplayName"
                  @show-user-profile="showUserProfile"
                  @open-thread="handleOpenThread"
                  @show-all-threads="emit('showAllThreads')"
                />
              </div>
            </div>
            
            <!-- Message actions for system messages (hover or focus within the row); on mobile with tap use floating popup -->
            <div
              v-if="showsActionBar(item.message.id)"
              class="message-actions"
              role="group"
              :aria-label="t('messageA11y.actions.label')"
              :style="actionBarShift ? { right: `${actionBarShift}px` } : undefined"
            >
              <button type="button" class="action-btn" data-testid="msg-action-react" :aria-label="t('message.react')" :title="t('message.react')" aria-haspopup="dialog" @click="openEmojiReactor(item.message, $event)"><ReactionIcon/></button>
              <button type="button" class="action-btn" data-testid="msg-action-delete" :class="{ 'delete-danger': isShiftHeld }" v-if="canDeleteMessage(item.message)" :aria-label="deleteActionLabel(item.message)" :title="deleteActionLabel(item.message)" @click="deleteMessage(item.message.id, $event)"><Icon v-if="isInstanceHide(item.message)" name="eye-off" :size="18" /><DeleteIcon v-else/></button>
              <button type="button" class="action-btn" data-testid="msg-action-more" :aria-label="t('message.moreActions')" :title="t('message.moreActions')" aria-haspopup="menu" :aria-expanded="isMenuOpenFor(item.message.id) ? 'true' : 'false'" @click="openContextMenu(item.message, $event)"><MoreIcon/></button>
            </div>
            
            <!-- Reactions for system messages -->
            <MessageReactions
              :message="item.message"
              @show-reaction-tooltip="showTooltip"
              @hide-reaction-tooltip="hideTooltip"
              @open-emoji-picker="handleOpenEmojiPicker"
              @open-reactions="openReactionsModal"
              @layout-change="handleReactionsLayoutChange"
            />
          </div>

          <!-- Regular Message Content -->
          <template v-else>
            <!-- Reply reference -->
            <MessageReplyReference
              v-if="item.message.reply_to"
              :id="`msg-reply-${item.message.id}`"
              :reply-to-message-id="item.message.reply_to"
              :channel-id="channelId"
              :conversation-id="conversationId"
              :server-id="effectiveColoringServerId"
              @open-reply="handleReplyClick"
            />
          
          <!-- Message content with proper alignment -->
          <div class="message-group" :class="{ 'has-header': shouldShowHeader(item.message, item.index), 'compact': !shouldShowHeader(item.message, item.index) }">
            <!-- Message header (avatar + username + timestamp) -->
            <div v-if="shouldShowHeader(item.message, item.index)" class="message-header">
              <div class="message-avatar">
                <Avatar 
                  :src="getAuthorAvatarUrl(item.message).value"
                  size="sm" 
                  :interactive="true"
                  @click="handleAuthorClick(item.message, $event)"
                />
          </div>
          <div class="message-main">
            <div class="message-meta">
              <button type="button" class="username" :style="{color: getAuthorColor(item.message).value}" @click="handleAuthorClick(item.message, $event)">
                <span class="username-text"><DisplayName v-if="item.message.user_id && !item.message.bot_id && !hasDiscordUserMetadata(item.message)" :user-id="item.message.user_id" /><template v-else>{{ getAuthorDisplayName(item.message).value }}</template></span>
                <FederatedUserBadge v-if="getHarmonyProfileUserId(item.message)" :user-id="getHarmonyProfileUserId(item.message)" />
                <BridgeSourceBadge v-if="hasDiscordUserMetadata(item.message)" source="discord" />
                <span v-else-if="getWebhookAuthor(item.message)" class="bot-badge webhook-badge">{{ $t('webhooks.badge') }}</span>
                <span v-else-if="isMessageFromBot(item.message)" class="bot-badge">BOT</span>
                <span v-if="getInstanceBadge(item.message).value === 'admin'" class="instance-badge admin" title="Instance admin">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
                  ADMIN
                </span>
                <span v-else-if="getInstanceBadge(item.message).value === 'mod'" class="instance-badge mod" title="Instance moderator">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
                  MOD
                </span>
                <SupporterBadge v-if="getMessageAuthorId(item.message)" :user-id="getMessageAuthorId(item.message)!" />
              </button>
              <!-- Pin and encryption state are spoken in the row name (rowMeta). -->
              <span class="timestamp">
                <AppTimestamp :value="item.message.created_at" :short="formatTimestamp(item.message.created_at)" />
                <span
                  v-if="item.message.is_pinned"
                  class="pin-indicator"
                  :title="t('messageA11y.row.pinned')"
                  aria-hidden="true"
                ><Icon name="pin" :size="14" /></span>
                <span
                  v-if="item.message.decrypted"
                  class="encryption-dot decrypted"
                  :title="t('messageA11y.row.encrypted')"
                  aria-hidden="true"
                ></span>
                <span
                  v-else-if="item.message.encrypted"
                  class="encryption-indicator locked"
                  :class="{ unrecoverable: item.message.decryption_unrecoverable }"
                  :title="encryptionLockTooltip(item.message)"
                  aria-hidden="true"
                ><Icon name="lock" :size="12" /></span>
              </span>
            </div>
            <UnifiedMessageContent 
              :id="`msg-body-${item.message.id}`"
              :content="getDisplayContent(item.message)"
              :message-id="item.message.id"
              :editable-message-id="editableMessageId"
              :editable-content="editableMessageContent"
              :image-loaded="imageLoaded"
              :is-single-emoji="checkSingleEmoji(item.message.content)"
              :embed-payloads="item.message.metadata?.embeds"
              :metadata="item.message.metadata"
              :encrypted="item.message.encrypted || false"
              :decrypted="item.message.decrypted || false"
              :unrecoverable="item.message.decryption_unrecoverable || false"
              :sender-verified="item.message?.sender_verified"
              :can-decrypt="canDecryptMessages"
              :can-edit-attachments="canEditAttachments(item.message)"
              :media-hidden="serverMediaHidden"
              @image-loaded="handleImageLoaded"
              @embed-loaded="handleEmbedLoaded(item.message.id)"
              @update:message="saveEdit"
              @update:content="editableMessageContent = $event"
              @cancel-edit="cancelEdit"
              @remove-attachment="removeAttachment"
              @show-user-profile="showUserProfile"
              @decrypt-message="handleDecryptMessage(item.message)"
            />
            <!-- Edited indicator for messages with headers -->
            <span 
              v-if="isMessageEdited(item.message) || item.message.edit_pending" 
              class="edited-indicator inline"
              :class="{ 'edit-pending': item.message.edit_pending }"
              :data-testid="item.message.edit_pending ? 'edit-pending' : undefined"
              :title="item.message.edit_pending ? t('message.editSaving') : item.message.updated_at ? `Edited at ${formatTimestamp(item.message.updated_at)}` : 'Edited'"
            >({{ $t('message.edited') }})</span>
          </div>
        </div>
        
        <!-- Compact message (no header, just content aligned with previous messages) -->
        <div v-else class="message-content-only">
          <div class="message-gutter">
            <AppTimestamp class="message-gutter-time" :value="item.message.created_at" :short="formatTimeOnly(item.message.created_at)" />
          </div>
          <div class="message-main">
            <UnifiedMessageContent 
              :id="`msg-body-${item.message.id}`"
              :content="getDisplayContent(item.message)"
              :message-id="item.message.id"
              :editable-message-id="editableMessageId"
              :editable-content="editableMessageContent"
              :image-loaded="imageLoaded"
              :is-single-emoji="checkSingleEmoji(item.message.content)"
              :embed-payloads="item.message.metadata?.embeds"
              :metadata="item.message.metadata"
              :encrypted="item.message.encrypted || false"
              :decrypted="item.message.decrypted || false"
              :unrecoverable="item.message.decryption_unrecoverable || false"
              :sender-verified="item.message?.sender_verified"
              :can-decrypt="canDecryptMessages"
              :can-edit-attachments="canEditAttachments(item.message)"
              :media-hidden="serverMediaHidden"
              @image-loaded="handleImageLoaded"
              @embed-loaded="handleEmbedLoaded(item.message.id)"
              @update:message="saveEdit"
              @update:content="editableMessageContent = $event"
              @cancel-edit="cancelEdit"
              @remove-attachment="removeAttachment"
              @show-user-profile="showUserProfile"
              @decrypt-message="handleDecryptMessage(item.message)"
            />
            <!-- Edited indicator for compact messages -->
            <span 
              v-if="isMessageEdited(item.message) || item.message.edit_pending" 
              class="edited-indicator compact"
              :class="{ 'edit-pending': item.message.edit_pending }"
              :data-testid="item.message.edit_pending ? 'edit-pending' : undefined"
              :title="item.message.edit_pending ? t('message.editSaving') : item.message.updated_at ? `Edited at ${formatTimestamp(item.message.updated_at)}` : 'Edited'"
            >({{ $t('message.edited') }})</span>
          </div>
        </div>
        
        <!-- Failed message indicator with retry/discard -->
        <div v-if="item.message.failed" class="failed-message-bar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
          <span>{{ t('messageA11y.failed.label') }}</span>
          <button type="button" class="retry-btn" @click="$emit('retry-message', item.message)">{{ t('messageA11y.failed.retry') }}</button>
          <button type="button" class="discard-btn" @click="$emit('discard-message', item.message)">{{ t('messageA11y.failed.discard') }}</button>
        </div>

        <!-- Message actions on hover or focus within the row; on mobile with tap use floating popup -->
        <div
          v-if="!item.message.failed && showsActionBar(item.message.id)"
          class="message-actions"
          role="group"
          :aria-label="t('messageA11y.actions.label')"
          :style="actionBarShift ? { right: `${actionBarShift}px` } : undefined"
        >
          <button type="button" class="action-btn" data-testid="msg-action-react" :aria-label="t('message.react')" :title="t('message.react')" aria-haspopup="dialog" @click="openEmojiReactor(item.message, $event)"><ReactionIcon/></button>
          <button type="button" class="action-btn" data-testid="msg-action-reply" :aria-label="t('message.reply')" :title="t('message.reply')" @click="replyTo(item.message)"><ReplyIcon/></button>
          <button type="button" class="action-btn thread-btn" data-testid="msg-action-thread" v-if="!hideThreadCreate" :aria-label="t('messageA11y.actions.thread')" :title="t('messageA11y.actions.thread')" @click="createThread(item.message)"><ThreadIcon/></button>
          <button type="button" class="action-btn" data-testid="msg-action-edit" v-if="canEditMessage(item.message)" :aria-label="t('message.editMessage')" :title="t('message.editMessage')" @click="startEdit(item.message)"><EditIcon/></button>
          <button type="button" class="action-btn" data-testid="msg-action-delete" :class="{ 'delete-danger': isShiftHeld }" v-if="canDeleteMessage(item.message)" :aria-label="deleteActionLabel(item.message)" :title="deleteActionLabel(item.message)" @click="deleteMessage(item.message.id, $event)"><Icon v-if="isInstanceHide(item.message)" name="eye-off" :size="18" /><DeleteIcon v-else/></button>
          <button type="button" class="action-btn" data-testid="msg-action-more" :aria-label="t('message.moreActions')" :title="t('message.moreActions')" aria-haspopup="menu" :aria-expanded="isMenuOpenFor(item.message.id) ? 'true' : 'false'" @click="openContextMenu(item.message, $event)"><MoreIcon/></button>
        </div>
        
        <!-- Reactions -->
        <MessageReactions
          :message="item.message"
          @show-reaction-tooltip="showTooltip"
          @hide-reaction-tooltip="hideTooltip"
          @open-emoji-picker="handleOpenEmojiPicker"
          @open-reactions="openReactionsModal"
          @layout-change="handleReactionsLayoutChange"
        />
        
          <!-- Thread Indicator (if this message started a thread) - hidden in thread view -->
          <ThreadIndicator
            v-if="!props.hideThreadActions && getThreadIndicator(item.message.id)"
            :thread="getThreadIndicator(item.message.id)"
            @open="openThread"
            class="message-thread-indicator"
          />
        </div>
        </template>
      </div>
    </template>
      </template>
    </div>
  </div>

    <!-- A jump detached the list from the present: Discord's "viewing older messages" bar.
         It replaces the floating control below. -->
    <div v-if="isDetached" class="history-bar-anchor">
      <div class="history-bar" data-testid="history-bar">
        <span class="history-bar-text">
          {{ $t('message.viewingOlder') }}
          <template v-if="detachedUnseen > 0"> - {{ $t('message.newMessagesBelow', { count: detachedUnseen }, detachedUnseen) }}</template>
        </span>
        <button type="button" class="history-bar-jump" data-testid="history-jump-present" @click="jumpToPresent">
          {{ $t('message.jumpToPresent') }}
          <Icon name="arrow-down" :size="14" />
        </button>
      </div>
    </div>

    <!-- Jump to present; rules in utils/chatScroll showJumpToPresent. With messages
         that arrived while scrolled up it carries their count. -->
    <div v-if="showJump" class="jump-present-anchor">
      <button
        ref="jumpButtonRef"
        type="button"
        class="jump-present"
        :class="{ 'has-count': unseenCount > 0 }"
        data-testid="jump-to-present"
        :aria-label="unseenCount > 0 ? undefined : $t('message.jumpToPresent')"
        :title="$t('message.jumpToPresent')"
        @click="jumpToPresent"
      >
        <span v-if="unseenCount > 0">{{ $t('message.newMessagesBelow', { count: unseenCount }, unseenCount) }}</span>
        <Icon :name="unseenCount > 0 ? 'chevron-down' : 'arrow-down'" :size="unseenCount > 0 ? 14 : 18" />
      </button>
    </div>
  </div>

  <!-- Modern User Profile Modal -->
  <UserProfileModal
    :show="showProfileModal"
    :user="selectedUser"
    @close="closeProfile"
    @invite="openInviteModal"
    @mention="(username: string) => { emit('mentionUser', username); closeProfile(); }"
  />

  <BotProfileModal
    v-if="selectedBot"
    :show="true"
    :bot-id="selectedBot.id"
    :server-id="conversationId ? null : serverChannelStore.currentServerId"
    :preview="selectedBot"
    @close="selectedBot = null"
  />

  <!-- Invite Modal -->
  <InviteModal 
    :show="showInviteModal" 
    :server-id="serverChannelStore.currentServerId || undefined"
    :server-data="currentServerData || undefined"
    @close="closeInviteModal"
  />

  <ReactionTooltip
    :visible="tooltip.visible"
    :x="tooltip.x"
    :y="tooltip.y"
    :emoji="tooltip.emoji"
    :users="tooltip.content"
  />

  <ReactionsModal
    v-if="reactionsModal"
    :message-id="reactionsModal.messageId"
    :initial-emoji-key="reactionsModal.emojiKey"
    :resolvers="reactionUserResolvers"
    @close="closeReactionsModal"
    @select-user="handleReactionUserSelect"
  />

  <!-- Mobile: message-actions floating above tap (thumb reach ~48px) -->
  <MessageFloatingActions
    v-if="isMobile && hoveredMessageId && mobileActionTapPosition && hoveredMessageItem"
    :message="hoveredMessageItem.message"
    :style="floatingActionsStyle"
    :hide-thread-actions="hideThreadCreate"
    :is-shift-held="isShiftHeld"
    :can-edit="canEditMessage(hoveredMessageItem.message)"
    :can-delete="canDeleteMessage(hoveredMessageItem.message)"
    :delete-label="deleteActionLabel(hoveredMessageItem.message)"
    :hides-on-instance="isInstanceHide(hoveredMessageItem.message)"
    @react="openEmojiReactor"
    @reply="replyTo"
    @thread="createThread"
    @edit="startEdit"
    @delete="deleteMessage"
    @context-menu="openContextMenu"
  />

  <!-- Message Context Menu -->
  <MessageContextMenu
    :is-visible="contextMenuVisible"
    :position="contextMenuPosition"
    :trigger="contextMenuTrigger"
    :message="contextMenuMessage"
    :server-id="serverChannelStore.currentServerId ?? undefined"
    :channel-id="props.channelId"
    :thread-id="props.threadId"
    :conversation-id="props.conversationId"
    :current-user-id="props.currentUserId"
    :hide-thread-actions="props.hideThreadActions"
    :can-edit="contextMenuMessage ? canEditMessage(contextMenuMessage) : false"
    :can-delete="contextMenuMessage ? canDeleteMessage(contextMenuMessage) : false"
    :hides-on-instance="contextMenuMessage ? isInstanceHide(contextMenuMessage) : false"
    @close="closeContextMenu"
    @add-reaction="handleContextMenuReaction"
    @open-emoji-picker="handleContextMenuEmojiPicker"
    @report="handleReportMessage"
    @view-reactions="(message: Message) => openReactionsModal(message.id, null)"
    @reply="replyTo"
    @edit="startEdit"
    @thread="createThread"
    @delete="deleteMessage"
  />

  <!-- Report Modal -->
  <ReportModal
    v-if="showReportModal"
    report-type="message"
    :target-user-id="reportTargetUserId"
    :target-message-id="reportTargetMessageId"
    :target-message-preview="reportTargetMessagePreview"
    :target-user="reportTargetUser"
    :target-server="reportTargetServer"
    @close="showReportModal = false"
    @hide="handleHideReportedContent"
  />

  <!-- Delete Message Confirmation Modal -->
  <!-- A hide in a copy names its scope: this instance only, never the host. -->
  <ConfirmationModal
    :show="showDeleteConfirmModal"
    :title="deleteConfirmConfig.hide ? t('serverCopy.hide.action', { instance: instanceDomain }) : t('message.deleteMessage')"
    :message="deleteConfirmConfig.hide
      ? t('serverCopy.hide.confirm', { instance: instanceDomain, host: copyHost })
      : deleteConfirmConfig.hasThread ? `This message has a thread attached: '${deleteConfirmConfig.threadName}'` : 'Are you sure you want to delete this message? This action cannot be undone.'"
    :secondary-message="!deleteConfirmConfig.hide && deleteConfirmConfig.hasThread ? 'Deleting this message will permanently delete the thread and all its replies.' : undefined"
    :confirm-button-text="deleteConfirmConfig.hide ? t('serverCopy.hide.button') : deleteConfirmConfig.hasThread ? 'Delete message and thread' : 'Delete'"
    @close="cancelDeleteMessage"
    @confirm="confirmDeleteMessage"
  />
</template>

<script setup lang="ts">
defineOptions({ inheritAttrs: false })
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import Icon from '@/components/common/Icon.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import { historyCutoff } from '@/services/channelHistoryCutoff';
import { classifySendFailure, permissionRefusalMessage } from '@/utils/sendFailure';
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { debug } from '@/utils/debug'
import type { PropType, Ref, ComputedRef } from 'vue';
import type { Message, MessagePart, User, Emoji, FileContent, ReactionActor, ReactionGroup } from '@/types';
import { hasSubstantiveMessageContent, removeFilePartByUrl } from '@/utils/messageContentUtils';
import { getHarmonyProfileUserId, getWebhookAuthor, isBridgedAuthorMessage } from '@/utils/messageAuthor';
import { pollPartOf } from '@/utils/messagePoll';
import { remoteServerHost } from '@/utils/serverUtils';
import { getInstanceDomain } from '@/services/instanceConfig';
import { mediaLoadKey } from '@/services/privateMedia';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useChatStore } from '@/stores/useChat';
import { useDMStore } from '@/stores/useDM';
import { saveEditOptimistically } from '@/stores/shared/optimisticEdit';
import { services } from '@/services';
import { ensureMessageEmbeds } from '@/utils/messageEmbedUtils';
import { useOutboxStore } from '@/stores/useOutbox';
import { isOptimisticId } from '@/stores/shared/optimisticMessages';
import { useAuthStore } from '@/stores/auth';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { showInstanceStaffBadge } from '@/utils/instanceBadge';
import { useServerRolesStore } from '@/stores/useServerRoles';
import { useProfileStore } from '@/stores/useProfile';
import { useNotificationStore } from '@/stores/useNotification';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { isModerationRejectionCode } from '@/services/AutoModService';
import { useToast } from 'vue-toastification';
import { supabase } from '@/supabase'; 
import { throttle } from '@/utils/throttle';
import { getReactionTooltipAnchor } from '@/utils/reactionTooltipPosition';
import { useServerPermissions } from '@/composables/useServerPermissions';
import { useChannelMessagePermissions } from '@/composables/useChannelMessagePermissions';
import { useServerMediaHidden } from '@/composables/useInstanceMediaHidden';
import { useUserData, DEFAULT_USER_COLOR } from '@/composables/useUserData';
import { useHapticSettings } from '@/composables/useHapticSettings';
import { useQuickReactSettings } from '@/composables/useQuickReactSettings';
import { useLayoutState } from '@/composables/useLayoutState';
import { useUnreadCounts } from '@/composables/useUnreadCounts';
import { useReadDivider } from '@/composables/useReadDivider';
import { markChannelRead, markConversationRead } from '@/services/readState';
import { createReadMarkerQueue, type QueuedRead } from '@/utils/readMarkerQueue';
import { format, isToday, isYesterday, isSameDay, isValid } from 'date-fns';
import UserProfileModal from '@/components/UserProfileModal.vue';
import BotProfileModal from '@/components/BotProfileModal.vue';
import type { ServerBot } from '@/services/serverBotsService';
import { BOT_NAME_COLOR } from '@/utils/botUtils';
import InviteModal from '@/components/InviteModal.vue';
import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue';
import ReactionIcon from '@/components/icons/Reaction.vue';
import ReplyIcon from '@/components/icons/Reply.vue';
import ThreadIcon from '@/components/icons/Thread.vue';
import EditIcon from '@/components/icons/Edit.vue';
import DeleteIcon from '@/components/icons/Delete.vue';
import MoreIcon from '@/components/icons/More.vue';
import Avatar from '@/components/common/Avatar.vue';
import DisplayName from '@/components/DisplayName.vue';
import ConversationBeginning from '@/components/ConversationBeginning.vue';
import ReactionTooltip from '@/components/messages/ReactionTooltip.vue';
import ReactionsModal from '@/components/messages/ReactionsModal.vue';
import {
  formatUserHandle,
  reactionProfileIds,
  toReactionUsers,
  type ReactionUser,
  type ReactionUserResolvers,
} from '@/utils/reactionUsers';
import BridgeSourceBadge from '@/components/messages/BridgeSourceBadge.vue';
import FederatedUserBadge from '@/components/messages/FederatedUserBadge.vue';
import SystemEventBody from '@/components/messages/SystemEventBody.vue';
import {
  findBridgedUserInCache,
  resolveBridgedUserColor,
  bridgedUserToProfileUser,
  discordMetadataToBridgedUser,
  fetchBridgedChannelUsers,
  BRIDGED_DISCORD_USER_ID_PREFIX,
} from '@/services/bridgedChannelUsersService';
import MessageReactions from '@/components/MessageReactions.vue';
import MessageContextMenu from '@/components/MessageContextMenu.vue';
import { shouldAllowNativeContextMenu } from '@/utils/nativeContextMenu';
import { stylePoint, styleRect, styleViewport } from '@/utils/appZoom';
import ReportModal from '@/components/moderation/ReportModal.vue';
import SupporterBadge from '@/components/common/SupporterBadge.vue';
import { fundingService } from '@/services/FundingService';
import ThreadIndicator from '@/components/threads/ThreadIndicator.vue';
import ConfirmationModal from '@/components/ConfirmationModal.vue';
import MessageFloatingActions from '@/components/messages/MessageFloatingActions.vue';
import MessageReplyReference from '@/components/messages/MessageReplyReference.vue';
import AppTimestamp from '@/components/a11y/AppTimestamp.vue';
import { useT } from '@/composables/useT';
import { useAnnouncer } from '@/composables/useAnnouncer';
import { useRovingTabindex } from '@/composables/useRovingTabindex';
import { isContextMenuKey } from '@/composables/useMenu';
import { createNewMessageAnnouncer } from '@/composables/useNewMessageAnnouncer';
import { messageSpeechText } from '@/utils/a11y/messageSpeech';
import { currentFocusOrigin, focusElement } from '@/utils/a11y/focus';
import { hasOpenLayer, resolveFocusOrigin } from '@/utils/a11y/layers';
import { useThreadsStore } from '@/stores/useThreads';
import { threadService, type ThreadWithDetails } from '@/services/ThreadService';
import { messagePartsToMarkdown, isSingleEmojiMessage as checkSingleEmoji, stripLeadingSelfMention } from '@/utils/messageContentUtils';
import { mentionsViewer } from '@/utils/hereMention';
import { parseContentToMessageParts, resolveMentionsUserData, resolveEmojisData, resolveRoleMentionsData } from '@/utils/unifiedContentProcessing';
import { buildChatParseOptions } from '@/utils/chatParseOptions';
import { isPointOverText, isQuickReactDoubleClick, type PointerDown } from '@/utils/quickReactGesture';
import { useReactionsStore } from '@/stores/useReactions';
import { usePostReactionsStore } from '@/stores/postReactions';
import { useVirtualizer, defaultRangeExtractor, type Range, type VirtualItem, type Virtualizer } from '@tanstack/vue-virtual';
import { floatingReturnTarget, useFloatingVideo } from '@/composables/useFloatingVideo';
import {
  PIN_THRESHOLD_PX,
  bottomScrollTop,
  distanceFromBottom,
  nextPinState,
  scrollTopAfterPrepend,
  correctForItemResize,
  showJumpToPresent,
  type PinState,
} from '@/utils/chatScroll';

// --- PROPS & EMITS ---
const props = defineProps({
  messages: {
    type: Array as PropType<Message[]>,
    required: true
  },
  loadMoreMessages: Function as PropType<() => void>,
  isAtBottom: Boolean,
  currentUserId: String,
  isLoading: {
    type: Boolean,
    default: false
  },
  channelId: String,
  conversationId: String,
  threadId: String,
  hideThreadActions: {
    type: Boolean,
    default: false
  },
  // Whether the "New messages" divider is active for this context. Channels and
  // DMs derive their read boundary from the unread_counts store. Threads have no
  // per-thread read-state, and they reuse this component with their PARENT
  // channel id - feeding that channel's unread row against thread messages would
  // place a bogus/stuck "NEW" line. So thread views pass false until real
  // per-thread read tracking exists.
  enableReadDivider: {
    type: Boolean,
    default: true
  },
});

const emit = defineEmits(['loadMoreMessages', 'toggleEmojiList', 'sendReaction', 'replyingTo', 'update:isAtBottom', 'createThread', 'showAllThreads', 'mentionUser', 'retry-message', 'discard-message']);

// --- STORES & COMPOSABLES ---
const { t, locale } = useT();
const { polite, assertive } = useAnnouncer();
const serverUsersStore = useServerUsersStore();
const serverChannelStore = useServerChannelStore();
const serverRolesStore = useServerRolesStore();

// Server whose role colors are applied to the rendered messages. Decoupled
// from `serverChannelStore.currentServerId`: on a server switch
// `currentServerId` flips synchronously while the old server's messages are
// still on screen, repainting those names through the new server's role
// lookup, which usually falls back to profile color - the visible "color
// flash". `coloringServerId` advances only once the new channel's messages
// have rendered (see the initial-load block in the message watcher), by
// which point the new server's roles have been requested below.
const coloringServerId = ref<string | null>(serverChannelStore.currentServerId);

// Role data is loaded for the current server so author colors reflect the
// highest colored role. DMs and contexts without a server fall back to
// user.color via `getUserColor` below.
watch(
  () => serverChannelStore.currentServerId,
  (serverId) => {
    if (serverId) serverRolesStore.ensureServerLoaded(serverId)
  },
  { immediate: true },
);

// A DM belongs to no server. coloringServerId seeds from currentServerId and
// only advances when a channel's messages render, so in a conversation it
// still holds the last server opened and would colour DM authors through that
// server's roles. Null here forces the profile colour.
const effectiveColoringServerId = computed(() =>
  props.conversationId ? null : coloringServerId.value
);

/**
 * Resolve a chat-author's display color, preferring their highest-position
 * colored role within the server the rendered messages belong to. Falls back
 * to the user's profile color (and ultimately the default in `getUserColor`).
 */
const resolveChatUserColor = (userId: string | null | undefined): string => {
  if (!userId) return DEFAULT_USER_COLOR;
  const serverId = effectiveColoringServerId.value;
  const roleColor = serverId ? serverRolesStore.getUserRoleColor(serverId, userId) : null;
  return roleColor || getUserColor(userId).value;
};

// "New messages" divider state. The boundary is snapshotted at open (before the
// context is marked read) and resolved once messages render; see useReadDivider.
const { getUnreadCount } = useUnreadCounts();
const { dividerBeforeMessageId, captureBoundary, resolveDivider, clear: clearReadDivider } = useReadDivider();

/**
 * Retires the "New messages" divider when the user clicks a message at or
 * after it, which signals the content has been read. Scrolling alone never
 * clears it, and clicking an older message above the divider leaves it.
 */
const clearDividerIfMessageRead = (message: Message) => {
  const dividerId = dividerBeforeMessageId.value;
  if (!dividerId || !message?.id) return;
  if (message.id === dividerId) { clearReadDivider(); return; }
  const items = displayItems.value;
  const dividerIdx = items.findIndex(it => it.type === 'message' && it.message.id === dividerId);
  const clickedIdx = items.findIndex(it => it.type === 'message' && it.message.id === message.id);
  if (dividerIdx >= 0 && clickedIdx >= dividerIdx) {
    clearReadDivider();
  }
};

const currentUnreadContext = (): { channelId?: string; conversationId?: string } | null => {
  if (props.conversationId) return { conversationId: props.conversationId };
  if (props.channelId) return { channelId: props.channelId };
  return null;
};

// Snapshot the read boundary for the active context BEFORE it gets marked read.
const captureReadBoundary = () => {
  // Divider disabled for this context (e.g. threads): with no boundary
  // captured, resolveDivider has nothing to place and no "NEW" line appears.
  if (!props.enableReadDivider) {
    captureBoundary(null);
    return;
  }
  const ctx = currentUnreadContext();
  captureBoundary(ctx ? getUnreadCount(ctx) : null);
};
const chatStore = useChatStore();
const dmStore = useDMStore();
const outbox = useOutboxStore();
const toast = useToast();
const authStore = useAuthStore();
const profileStore = useProfileStore();
const activityPubStore = useActivityPubStore();
const reactionsStore = useReactionsStore();
const postReactionsStore = usePostReactionsStore();

const isShiftHeld = ref(false);
const onShiftDown = (e: KeyboardEvent) => {
  if (e.key === 'Shift') isShiftHeld.value = true;
  // Discord's "jump to oldest unread". A row's own PageUp has already moved focus.
  if (e.key === 'PageUp' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.defaultPrevented && dividerBeforeMessageId.value) {
    e.preventDefault();
    jumpToDivider();
  }
};
const onShiftUp = (e: KeyboardEvent) => { if (e.key === 'Shift') isShiftHeld.value = false; };

// Track which blocked message groups the user has chosen to reveal (by first message ID in group)
const revealedBlockedGroups = ref<Set<string>>(new Set());

// Bumped by the watcher on the store's blockedUsers size, to force
// re-evaluation of block checks.
const blockCheckVersion = ref(0);

// Reactive computed that tracks the blocked users count for change detection
const blockedUsersCount = computed(() => activityPubStore.blockedUsers.size);

// Watch for changes to blocked users count and force re-evaluation
watch(blockedUsersCount, (newCount, _oldCount) => {
  blockCheckVersion.value++;
  debug.log('Blocked users changed, forcing re-render. Count:', newCount);
});

const getDisplayContent = (message: Message): MessagePart[] => {
  if (!message.metadata?.federated) return message.content;
  // Only strip leading self-mentions for DM conversations (ActivityPub convention),
  // not for channel messages where @mentions are intentional content
  if (!message.conversation_id && !props.conversationId) return message.content;
  const username = profileStore.profile?.username;
  if (!username) return message.content;
  return stripLeadingSelfMention(message.content, username);
};

const isMessageFromBlockedUser = (message: Message): boolean => {
  // Access the version to make this reactive to blocked user changes
  blockCheckVersion.value;
  
  const authorId = message.user_id || message.bot_id;
  if (!authorId) return false;
  
  return activityPubStore.isBlocked(authorId);
};

// Computed: Group consecutive blocked messages together (Discord-like)
interface BlockedMessageGroup {
  type: 'blocked-group';
  firstMessageId: string;
  messageIds: string[];
  count: number;
}

interface ProcessedMessage {
  type: 'message' | 'blocked-group';
  message?: Message;
  group?: BlockedMessageGroup;
  index: number;
}

// eslint-disable-next-line unused-imports/no-unused-vars
const processedMessages = computed((): ProcessedMessage[] => {
  // Force reactivity
  blockCheckVersion.value;
  
  const result: ProcessedMessage[] = [];
  let currentBlockedGroup: BlockedMessageGroup | null = null;
  
  props.messages.forEach((message, index) => {
    const isBlocked = isMessageFromBlockedUser(message);
    const isRevealed = currentBlockedGroup && revealedBlockedGroups.value.has(currentBlockedGroup.firstMessageId);
    
    if (isBlocked && !isRevealed) {
      if (!currentBlockedGroup) {
        currentBlockedGroup = {
          type: 'blocked-group',
          firstMessageId: message.id,
          messageIds: [message.id],
          count: 1
        };
      } else {
        currentBlockedGroup.messageIds.push(message.id);
        currentBlockedGroup.count++;
      }
    } else {
      // End current blocked group if exists
      if (currentBlockedGroup) {
        result.push({
          type: 'blocked-group',
          group: currentBlockedGroup,
          index: result.length
        });
        currentBlockedGroup = null;
      }
      
      result.push({
        type: 'message',
        message,
        index
      });
    }
  });
  
  // Flush the trailing blocked group.
  if (currentBlockedGroup) {
    result.push({
      type: 'blocked-group',
      group: currentBlockedGroup,
      index: result.length
    });
  }
  
  return result;
});

// eslint-disable-next-line unused-imports/no-unused-vars
const isBlockedGroupRevealed = (firstMessageId: string): boolean => {
  return revealedBlockedGroups.value.has(firstMessageId);
};

const revealBlockedGroup = (firstMessageId: string) => {
  revealedBlockedGroups.value.add(firstMessageId);
  // Force re-computation
  blockCheckVersion.value++;
};

const hideBlockedGroup = (firstMessageId: string) => {
  revealedBlockedGroups.value.delete(firstMessageId);
  // Force re-computation
  blockCheckVersion.value++;
};

// eslint-disable-next-line unused-imports/no-unused-vars
const getRevealedBlockedMessages = (messageIds: string[]): Message[] => {
  return props.messages.filter(m => messageIds.includes(m.id));
};

// Legacy functions for backwards compatibility
// eslint-disable-next-line unused-imports/no-unused-vars
const isBlockedMessageRevealed = (messageId: string): boolean => {
  return revealedBlockedGroups.value.has(messageId);
};

// eslint-disable-next-line unused-imports/no-unused-vars
const revealBlockedMessage = (messageId: string) => {
  revealedBlockedGroups.value.add(messageId);
  blockCheckVersion.value++;
};

// eslint-disable-next-line unused-imports/no-unused-vars
const hideBlockedMessage = (messageId: string) => {
  revealedBlockedGroups.value.delete(messageId);
  blockCheckVersion.value++;
};

// Display items: transforms messages into displayable items with blocked groups
type DisplayItem =
  | {
      type: 'message';
      key: string;
      message: Message;
      index: number;
      isRevealed?: boolean;
      isFirstInRevealedGroup?: boolean;
      groupId?: string;
      revealedCount?: number;
    }
  | {
      type: 'blocked-group';
      key: string;
      groupId: string;
      count: number;
    }
  | {
      type: 'reported';
      key: string;
      message: Message;
      index: number;
    };

const displayItems = computed((): DisplayItem[] => {
  // Force reactivity
  blockCheckVersion.value;
  
  const result: DisplayItem[] = [];
  let i = 0;
  
  while (i < props.messages.length) {
    const message = props.messages[i];
    const isBlocked = isMessageFromBlockedUser(message);
    
    if (isBlocked) {
      const groupStartIndex = i;
      const groupId = message.id;
      const groupMessages: Message[] = [];
      
      while (i < props.messages.length && isMessageFromBlockedUser(props.messages[i])) {
        groupMessages.push(props.messages[i]);
        i++;
      }
      
      const isRevealed = revealedBlockedGroups.value.has(groupId);
      
      if (isRevealed) {
        // Show revealed messages individually with a banner on the first one
        groupMessages.forEach((msg, idx) => {
          result.push({
            type: 'message',
            key: `msg-${msg.id}`,
            message: msg,
            index: groupStartIndex + idx,
            isRevealed: true,
            isFirstInRevealedGroup: idx === 0,
            groupId: groupId,
            revealedCount: groupMessages.length
          });
        });
      } else {
        result.push({
          type: 'blocked-group',
          key: `blocked-${groupId}`,
          groupId: groupId,
          count: groupMessages.length
        });
      }
    } else if (reportedMessageIds.value.has(message.id) && !revealedReportedIds.value.has(message.id)) {
      result.push({
        type: 'reported',
        key: `reported-${message.id}`,
        message: message,
        index: i,
      });
      i++;
    } else {
      // Regular message
      result.push({
        type: 'message',
        key: `msg-${message.id}`,
        message: message,
        index: i,
        isRevealed: false
      });
      i++;
    }
  }
  
  return result;
});

const hoveredMessageItem = computed(() => {
  const id = hoveredMessageId.value;
  if (!id) return null;
  return (
    displayItems.value.find(
      (item): item is Extract<DisplayItem, { type: 'message' }> =>
        item.type === 'message' && item.message?.id === id
    ) ?? null
  );
});

// Read context kept above a divider or a tall jump target, px.
const CONTEXT_NUDGE_PX = 72;

const THUMB_REACH_PX = 48;
const floatingActionsStyle = computed((): Record<string, string> => {
  const pos = mobileActionTapPosition.value;
  if (!pos || typeof window === 'undefined') return {};
  const viewport = styleViewport();
  const bottomPx = Math.max(8, viewport.height - pos.y + THUMB_REACH_PX);
  const popupWidth = 220;
  const leftPx = Math.max(popupWidth / 2, Math.min(pos.x, viewport.width - popupWidth / 2));
  return {
    left: `${leftPx}px`,
    bottom: `${bottomPx}px`,
    transform: 'translateX(-50%)',
  };
});
const { isCurrentUserServerOwner, getCurrentUserRole } = useServerPermissions();
// Channel-resolved, as messages_update_authorized and messages_delete_authorized decide it.
const { canManageMessages, canCreateThreads } = useChannelMessagePermissions(() => serverChannelStore.currentServerId, () => props.channelId);
// create_thread needs CREATE_PUBLIC_THREADS in the channel.
const hideThreadCreate = computed(() => props.hideThreadActions || !canCreateThreads.value);
// Pictures, videos and files of a server hosted elsewhere whose media this instance hides.
const serverMediaHidden = useServerMediaHidden(() => (props.conversationId ? null : serverChannelStore.currentServerId));
const viewerRoleIds = computed(() => new Set((getCurrentUserRole.value?.roles ?? []).map(role => role.id)));
// A conversation has no roles, @everyone or @here; its messages are not highlighted.
const mentionsMe = (message: Message): boolean =>
  !!props.channelId
  && mentionsViewer(getDisplayContent(message), { profileId: profileStore.profile?.id, roleIds: viewerRoleIds.value });
const { triggerInteraction, triggerDestructive } = useHapticSettings();
const quickReact = useQuickReactSettings();
const { isMobile } = useLayoutState();
const { 
  getUser,
  getUserDisplayName, 
  getUserColor, 
  getUserAvatarUrl, 
  ensureProfilesAvailable,
  fetchUserProfile,
  getUserProfile
} = useUserData();

// Bot data cache
const botDataCache = ref<Map<string, { username: string; display_name: string; avatar_url: string }>>(new Map());
const fetchingBots = ref<Set<string>>(new Set());

const threadsStore = useThreadsStore();

// Thread views hide indicators and skip the read.
const loadChannelThreads = async () => {
  if (!props.channelId || props.hideThreadActions) return;
  try {
    await threadsStore.loadChannelThreads(props.channelId);
  } catch (error) {
    debug.error('Failed to load threads:', error);
  }
};

const getThreadForMessage = (messageId: string): ThreadWithDetails | undefined => {
  return threadsStore.threadForMessage(messageId);
};

// Archived threads carry no indicator.
const getThreadIndicator = (messageId: string): ThreadWithDetails | undefined => {
  const thread = threadsStore.threadForMessage(messageId);
  return thread && !thread.archived ? thread : undefined;
};

// Accepts the lighter `ThreadData` shape emitted by `<ThreadIndicator>` as
// well as the full `ThreadWithDetails` from `threadService`; the value is
// forwarded to the parent unchanged.
const openThread = (thread: unknown) => {
  emit('createThread', { thread } as any);
};

// Opens at once from the store entry, or from the id and name the system
// message carries; the thread view fills in the rest.
const handleOpenThread = (threadId?: string, threadName?: string) => {
  if (!threadId) return;
  const thread = threadsStore.byId[threadId] ?? { id: threadId, name: threadName || 'Thread' };
  emit('createThread', { thread } as any);
};

// Encryption capability check (cached - only updates when service state changes)
const canDecryptMessages = ref(false);

// Re-check unlock state whenever the encryption service signals progress.
// The mount-time check races the service's lazy init/auto-unlock: on a
// direct page load into a DM this component mounts BEFORE auto-unlock
// completes, caches `false`, and click-to-decrypt never enables. Navigating
// chat -> DM works only because encryption is already unlocked by then.
// `megolm-key-received` fires on auto-unlock, manual unlock, and every
// received key.
const refreshCanDecrypt = async () => {
  try {
    const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService');
    canDecryptMessages.value = megolmMessageEncryptionService.isUnlocked();
  } catch {
    canDecryptMessages.value = false;
  }
};

// The timestamp lock explains WHY a message is still encrypted instead of a
// generic "you cannot decrypt this".
const encryptionLockTooltip = (message: any): string => {
  if (message.decryption_unrecoverable) {
    return "This message can't be decrypted: it was encrypted before your current encryption identity was created (e.g. before a key reset), and the key that could unlock it no longer exists on this account.";
  }
  if (canDecryptMessages.value) {
    return 'End-to-end encrypted - click the message text to decrypt';
  }
  return 'End-to-end encrypted - unlock encryption (Settings → Privacy & Encryption) to decrypt';
};

// Check encryption status on mount and load threads
onMounted(async () => {
  await refreshCanDecrypt();
  window.addEventListener('megolm-key-received', refreshCanDecrypt);

  loadChannelThreads();
  // Bot owners can change avatar/display_name in settings. UserBotsManagement
  // fires `bot:updated` after a successful save, which refreshes the
  // in-memory cache instead of waiting for a full re-render.
  window.addEventListener('bot:updated', handleBotUpdated as EventListener);
});

watch(() => props.channelId, () => {
  loadChannelThreads();
});

const handleBotUpdated = (event: CustomEvent) => {
  const updated = event.detail as { id: string; display_name?: string | null; avatar_url?: string | null; bio?: string | null } | null
  if (!updated?.id) return
  const existing = botDataCache.value.get(updated.id)
  // Merged so fields the event omits (e.g. username) survive.
  botDataCache.value.set(updated.id, {
    username: existing?.username ?? '',
    display_name: updated.display_name ?? existing?.display_name ?? '',
    avatar_url: updated.avatar_url ?? existing?.avatar_url ?? '',
  });
};

const fetchBotData = async (botId: string) => {
  if (botDataCache.value.has(botId) || fetchingBots.value.has(botId)) {
    return;
  }
  
  fetchingBots.value.add(botId);
  
  try {
    const { data, error } = await supabase
      .from('bots')
      .select('id, username, display_name, avatar_url')
      .eq('id', botId)
      .single();
    
    if (!error && data) {
      botDataCache.value.set(botId, data);
    }
  } catch (error) {
    debug.error('Failed to fetch bot data:', error);
  } finally {
    fetchingBots.value.delete(botId);
  }
};

// Users and bots.
const getMessageAuthorId = (message: Message): string | null => {
  return message.user_id || message.bot_id || null;
};

const isMessageFromBot = (message: Message): boolean => {
  return !!message.bot_id;
};

// Discord bridge messages carry discord_user metadata.
const hasDiscordUserMetadata = (message: Message): boolean => {
  const hasMetadata = !!message.metadata?.discord_user;
  return hasMetadata;
};

// eslint-disable-next-line unused-imports/no-unused-vars
const getDiscordUserInfo = (message: Message): { username: string; display_name: string; avatar_url: string } | null => {
  return message.metadata?.discord_user || null;
};

const getInstanceBadge = (message: Message): ComputedRef<'admin' | 'mod' | null> => {
  return computed(() => {
    const userId = message.user_id;
    if (!userId) return null;
    // Global instance staff flags must not surface inside a federated server.
    if (!showInstanceStaffBadge(serverChannelStore.currentServer)) return null;
    const profile = getUserProfile(userId).value;
    if (profile?.is_admin) return 'admin';
    if (profile?.is_moderator) return 'mod';
    return null;
  });
};

// Helper functions for bot display
const getBotDisplayName = (botId: string): ComputedRef<string> => {
  return computed(() => {
    if (!botDataCache.value.has(botId) && !fetchingBots.value.has(botId)) {
      fetchBotData(botId);
    }
    
    const bot = botDataCache.value.get(botId);
    return bot?.display_name || bot?.username || `Bot-${botId.slice(0, 8)}`;
  });
};

const botDisplayName = (botId: string): string => getBotDisplayName(botId).value;

// eslint-disable-next-line unused-imports/no-unused-vars
const getBotAvatarUrl = (botId: string): ComputedRef<string> => {
  return computed(() => {
    const bot = botDataCache.value.get(botId);
    return bot?.avatar_url || '/default_avatar.webp';
  });
};

// eslint-disable-next-line unused-imports/no-unused-vars
const getBotColor = (_botId: string): ComputedRef<string> => {
  return computed(() => BOT_NAME_COLOR);
};

// Unified helper functions that work for users, bots, and Discord users
// All checks must be INSIDE computed() for reactivity
const getAuthorDisplayName = (message: Message): ComputedRef<string> => {
  return computed(() => {
    // Check for Discord user metadata first (puppeting)
    if (message.metadata?.discord_user) {
      const discordUser = message.metadata.discord_user;
      return discordUser.display_name || discordUser.username || 'Discord User';
    }
    
    const webhook = getWebhookAuthor(message);
    if (webhook) return webhook.name;

    // Regular bot
    if (message.bot_id) {
      if (!botDataCache.value.has(message.bot_id) && !fetchingBots.value.has(message.bot_id)) {
        fetchBotData(message.bot_id);
      }
      const bot = botDataCache.value.get(message.bot_id);
      return bot?.display_name || bot?.username || `Bot-${message.bot_id.slice(0, 8)}`;
    }
    
    // Regular user
    if (message.user_id) {
      return getUserDisplayName(message.user_id).value;
    }
    
    return 'Unknown';
  });
};

const getAuthorAvatarUrl = (message: Message): ComputedRef<string> => {
  return computed(() => {
    // Check for Discord user metadata first (puppeting)
    if (message.metadata?.discord_user) {
      return message.metadata.discord_user.avatar_url || '/default_avatar.webp';
    }
    
    const webhook = getWebhookAuthor(message);
    if (webhook) return webhook.avatar_url || '/default_avatar.webp';

    // Regular bot
    if (message.bot_id) {
      const bot = botDataCache.value.get(message.bot_id);
      return bot?.avatar_url || '/default_avatar.webp';
    }
    
    // Regular user
    if (message.user_id) {
      return getUserAvatarUrl(message.user_id).value;
    }
    
    return '/default_avatar.webp';
  });
};

const getAuthorColor = (message: Message): ComputedRef<string> => {
  return computed(() => {
    if (message.metadata?.discord_user) {
      const discordUser = message.metadata.discord_user;
      const cached = props.channelId
        ? findBridgedUserInCache(props.channelId, discordUser.id)
        : null;
      const color = cached
        ? resolveBridgedUserColor(cached)
        : undefined;
      return color || 'var(--text-primary)';
    }
    
    if (message.bot_id) {
      return BOT_NAME_COLOR;
    }
    
    // Regular user - prefer highest-position role color in the active server.
    if (message.user_id) {
      return resolveChatUserColor(message.user_id);
    }
    
    return '#dddddd';
  });
};

// Unified computed properties that work for both chat and DMs
const isLoadingOlderMessages = computed(() => {
  if (props.conversationId) return dmStore.loadingMessages;
  if (props.channelId) return chatStore.loadingOlderMessages;
  return false;
});

const isAllMessagesLoaded = computed(() => {
  if (props.conversationId) return dmStore.allMessagesLoaded;
  if (props.channelId) return chatStore.allMessagesLoaded;
  return false;
});

// A jump detached the list from the present: it ends before the newest message.
// Thread views carry their parent channel's id but not its list.
const isDetached = computed(() => {
  if (props.conversationId) return dmStore.hasNewerMessages;
  if (props.channelId && !props.threadId) return chatStore.hasNewerMessages;
  return false;
});

const isLoadingNewerMessages = computed(() => {
  if (props.conversationId) return dmStore.loadingNewerMessages;
  if (props.channelId && !props.threadId) return chatStore.loadingNewerMessages;
  return false;
});

// Messages from others that arrived while detached.
const detachedUnseen = computed(() => {
  if (props.conversationId) return dmStore.unseenWhileDetached;
  if (props.channelId && !props.threadId) return chatStore.unseenWhileDetached;
  return 0;
});

// Context shown by the conversation-start line (channel vs DM vs group).
// get_message_page reported a READ_MESSAGE_HISTORY cutoff: the channel starts where the viewer opened it.
const historyRestricted = computed(() => !!props.channelId && !props.conversationId && !!historyCutoff(props.channelId));

const beginningInfo = computed((): { kind: 'channel' | 'dm' | 'group'; name: string; userId?: string } => {
  if (props.channelId) {
    const channel = serverChannelStore.channels.find(c => c.id === props.channelId);
    return { kind: 'channel', name: channel?.name || '' };
  }
  if (props.conversationId) {
    const conv = dmStore.getCurrentConversation;
    if (conv?.type === 'group') return { kind: 'group', name: conv.name || '' };
    const other = conv?.other_user;
    return {
      kind: 'dm',
      name: other?.display_name || other?.username || '',
      userId: other?.id || undefined,
    };
  }
  return { kind: 'channel', name: '' };
});

// --- REFS ---
const messageDisplayContainer = ref<HTMLDivElement | null>(null);
const topSentinelRef = ref<HTMLDivElement | null>(null);
const virtualListRef = ref<HTMLDivElement | null>(null);
const imageLoaded: Ref<Record<string, boolean>> = ref({});
const embedLoaded: Ref<Record<string, number>> = ref({}); // Track embed load count per message
const tooltip = ref({
  visible: false,
  content: [] as ReactionUser[],
  x: 0,
  y: 0,
  emoji: null as Emoji | null,
});
const tooltipTimer: Ref<NodeJS.Timeout | null> = ref(null);
const editableMessageId = ref<string | null>(null);
const editableMessageContent = ref('');
const hoveredMessageId = ref<string | null>(null);
// Row that holds the tab stop once a row has been focused; null: the newest row.
const activeRowKey = ref<string | null>(null);
// Message whose row holds focus; its action bar shows as on hover.
const focusMessageId = ref<string | null>(null);
const longPressTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const LONG_PRESS_DURATION = 500;
/** On mobile: tap position for positioning message-actions above the finger (thumb reach ~48px) */
const mobileActionTapPosition = ref<{ x: number; y: number } | null>(null);

// An unsent row (temp- id: an optimistic copy or an outbox row) has no actions: reply,
// react and delete need the persisted message. A failed row offers Retry and Delete.
const handleMessageMouseover = (messageId: string) => {
  if (!isMobile.value && !isOptimisticId(messageId)) {
    hoveredMessageId.value = messageId;
  }
};

const handleMessageMouseleave = () => {
  if (!isMobile.value) {
    hoveredMessageId.value = null;
  }
};

const LONG_PRESS_MOVE_TOLERANCE = 10; // px of finger jitter tolerated before cancel
let longPressStartPos: { x: number; y: number } | null = null;

// Reaction pills own their touch gestures: tap toggles, long-press opens the
// reactions list. Propagation stays intact; window-level swipe gestures may start on a pill.
const isReactionTouch = (event: TouchEvent): boolean =>
  event.target instanceof Element && !!event.target.closest('.message-reactions');

const cancelMessageLongPress = () => {
  if (longPressTimer.value) {
    clearTimeout(longPressTimer.value);
    longPressTimer.value = null;
  }
  longPressStartPos = null;
};

const handleMessageTouchStart = (messageId: string, event: TouchEvent) => {
  cancelMessageLongPress();
  if (isOptimisticId(messageId) || isReactionTouch(event)) return;
  const touch = event.touches[0];
  const tapPos = touch ? { x: touch.clientX, y: touch.clientY } : null;
  const tapStylePos = touch ? stylePoint(touch) : null;
  longPressStartPos = tapPos;
  longPressTimer.value = setTimeout(() => {
    longPressTimer.value = null;
    hoveredMessageId.value = messageId;
    mobileActionTapPosition.value = tapStylePos;
    triggerInteraction();
  }, LONG_PRESS_DURATION);
};

// Double-tap (mobile) detection. Window is shorter than LONG_PRESS_DURATION so
// two quick taps never trigger the long-press action bar.
const DOUBLE_TAP_WINDOW = 300;
const lastTap = ref<{ id: string; time: number } | null>(null);

// Event.timeStamp of the last touchend on a message. Mobile browsers follow a double tap
// with a compatibility dblclick, which is not a double-click.
let lastTouchEndAt = -Infinity;
const TOUCH_DBLCLICK_MS = 1000;

const handleMessageTouchEnd = (messageId: string, event: TouchEvent) => {
  cancelMessageLongPress();
  lastTouchEndAt = event.timeStamp;
  if (isReactionTouch(event)) {
    lastTap.value = null;
    return;
  }
  // Skip double-tap if the long-press action bar is already showing.
  if (hoveredMessageId.value === messageId && mobileActionTapPosition.value) return;
  if (!quickReact.doubleTap.value) return;

  const now = Date.now();
  if (lastTap.value && lastTap.value.id === messageId && now - lastTap.value.time < DOUBLE_TAP_WINDOW) {
    lastTap.value = null;
    triggerQuickReact(messageId);
    return;
  }
  lastTap.value = { id: messageId, time: now };
};

// Cancels on drags only; a zero tolerance never fires for a resting finger.
// Mirrors UserSidebar's member long-press.
const handleMessageTouchMove = (event: TouchEvent) => {
  if (!longPressTimer.value || !longPressStartPos) return;
  const touch = event.touches[0];
  if (!touch) return;
  const dx = Math.abs(touch.clientX - longPressStartPos.x);
  const dy = Math.abs(touch.clientY - longPressStartPos.y);
  if (dx > LONG_PRESS_MOVE_TOLERANCE || dy > LONG_PRESS_MOVE_TOLERANCE) {
    cancelMessageLongPress();
  }
};

// Desktop double-click to quick-react; the rules are in isQuickReactDoubleClick.
let quickReactFirstDown: PointerDown | null = null;

const handleMessageMouseDown = (event: MouseEvent) => {
  if (event.detail <= 1) {
    quickReactFirstDown = { x: event.clientX, y: event.clientY, time: event.timeStamp };
  }
};

const handleMessageDoubleClick = (messageId: string, event: MouseEvent) => {
  const firstDown = quickReactFirstDown;
  quickReactFirstDown = null;
  if (!quickReact.doubleClick.value) return;
  if (event.timeStamp - lastTouchEndAt < TOUCH_DBLCLICK_MS) return;
  if (!isQuickReactDoubleClick(event, firstDown, isPointOverText(event.clientX, event.clientY))) return;
  // Hit-testing beside a line of text selects its nearest word.
  window.getSelection?.()?.removeAllRanges();
  triggerQuickReact(messageId);
};

const triggerQuickReact = (messageId: string) => {
  // An unsent row (temp- id: optimistic copy or outbox row) has no message to react to.
  if (isOptimisticId(messageId)) return;
  const e = quickReact.emoji.value;
  if (!e?.id) return;
  const emojiForReaction: Emoji = {
    id: e.id,
    name: e.name,
    url: e.url || '',
    content: e.content,
  };
  handleToggleReaction(messageId, emojiForReaction);
};

const dismissMobileActions = (event: MouseEvent) => {
  if (!isMobile.value || !hoveredMessageId.value) return;
  const target = event.target as HTMLElement;
  if (!target.closest('.message-actions')) {
    hoveredMessageId.value = null;
  }
};

watch(hoveredMessageId, (id) => {
  if (!id) mobileActionTapPosition.value = null;
});

const isAtTop = ref(false);
const hasScrollbar = ref(false);
const selectedUser = ref<User | null>(null);
const showProfileModal = ref(false);
const selectedBot = ref<(Partial<ServerBot> & { id: string }) | null>(null);
const showInviteModal = ref(false);

const showDeleteConfirmModal = ref(false);
const deleteConfirmConfig = ref<{ messageId: string; hasThread: boolean; threadName: string; focusAfter?: string | null; hide?: boolean }>({
  messageId: '',
  hasThread: false,
  threadName: '',
});

// Context menu state
const contextMenuVisible = ref(false);
const contextMenuPosition = ref({ x: 0, y: 0 });
const contextMenuMessage = ref<Message | null>(null);

// Report modal state - persist reported/hidden messages in localStorage
const REPORTED_STORAGE_KEY = 'harmony_reported_messages';
const loadReportedMessages = (): Set<string> => {
  try {
    const stored = localStorage.getItem(REPORTED_STORAGE_KEY);
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch { return new Set(); }
};
const reportedMessageIds = ref<Set<string>>(loadReportedMessages());
const revealedReportedIds = ref<Set<string>>(new Set());
const saveReportedMessages = () => {
  localStorage.setItem(REPORTED_STORAGE_KEY, JSON.stringify([...reportedMessageIds.value]));
};
const showReportModal = ref(false);
const reportTargetUserId = ref<string | undefined>();
const reportTargetMessageId = ref<string | undefined>();
const reportTargetMessagePreview = ref<string | undefined>();
const reportTargetUser = ref<{ username: string; display_name?: string; avatar_url?: string; domain?: string | null; is_local?: boolean | null } | undefined>();
const reportTargetServer = ref<{ name?: string | null; is_local_server?: boolean | null; federation_domain?: string | null } | null>(null);

// --- STICK TO BOTTOM ---
// Whether the view follows the end of the list; rules in utils/chatScroll.
const pinState: PinState = { pinned: true, lastScrollTop: 0 };
const isPinned = ref(true);
// Messages from others appended while not pinned.
const unseenCount = ref(0);
// distanceFromBottom and clientHeight at the last scroll, resize or list update.
const distanceToEnd = ref(0);
const viewportHeight = ref(0);

const setPinned = (pinned: boolean) => {
  pinState.pinned = pinned;
  isPinned.value = pinned;
  if (pinned) unseenCount.value = 0;
};

// Pin state after the scroll position moved; rules in nextPinState. The end of a
// detached list is not the present and never pins.
const applyScroll = (el: HTMLElement) => {
  const settling = Date.now() < openFollowBottomUntil;
  const next = nextPinState(pinState, el, { settling });
  pinState.lastScrollTop = next.lastScrollTop;
  if (isDetached.value) next.pinned = false;
  if (next.pinned !== pinState.pinned) {
    setPinned(next.pinned);
    // A deliberate scroll-up ends the post-open grace window.
    if (!next.pinned) openFollowBottomUntil = 0;
  }
};

// Landing retries (open, jumpToMessageRow) run while they hold the current
// value; a newer jump to a message or to the present ends them.
let seatGeneration = 0;

const measureEnd = () => {
  const el = messageDisplayContainer.value;
  if (!el) return;
  distanceToEnd.value = distanceFromBottom(el);
  viewportHeight.value = el.clientHeight;
  measureDivider(el);
};

// The "New messages" line is above the view: its row ends above the viewport, or
// is not rendered and precedes the first rendered row.
const dividerAbove = ref(false);
const measureDivider = (el: HTMLElement) => {
  const id = dividerBeforeMessageId.value;
  if (!id) {
    dividerAbove.value = false;
    return;
  }
  const line = el.querySelector('.new-messages-divider');
  if (line) {
    dividerAbove.value = line.getBoundingClientRect().bottom <= el.getBoundingClientRect().top;
    return;
  }
  const idx = displayItems.value.findIndex(it => it.type === 'message' && it.message.id === id);
  const first = rowVirtualizer.value.getVirtualItems()[0]?.index;
  dividerAbove.value = idx >= 0 && first !== undefined && idx < first;
};

const showUnreadBar = computed(() => !!dividerBeforeMessageId.value && dividerAbove.value);

// Loaded messages from the divider on, other authors only: the ones the line marks.
const unreadAfterDivider = computed(() => {
  const id = dividerBeforeMessageId.value;
  const start = id ? props.messages.findIndex(m => m.id === id) : -1;
  if (start < 0) return 0;
  return props.messages.slice(start).filter(m => m.user_id !== props.currentUserId).length;
});

const dividerTime = computed(() => {
  const id = dividerBeforeMessageId.value;
  const message = id ? props.messages.find(m => m.id === id) : undefined;
  return message ? formatTimestamp(message.created_at) : '';
});

// Seats the "New messages" line near the top with read context above it; retries
// while rows above it measure.
const jumpToDivider = () => {
  const id = dividerBeforeMessageId.value;
  if (!id) return;
  setPinned(false);
  openFollowBottomUntil = 0;
  const generation = ++seatGeneration;
  let attempts = 0;
  const seat = () => {
    if (generation !== seatGeneration) return;
    attempts++;
    const idx = displayItems.value.findIndex(it => it.type === 'message' && it.message.id === id);
    if (idx < 0) return;
    rowVirtualizer.value.scrollToIndex(idx, { align: 'start' });
    requestAnimationFrame(() => {
      const c = messageDisplayContainer.value;
      if (!c || generation !== seatGeneration) return;
      const line = c.querySelector('.new-messages-divider');
      if (line) {
        const delta = styleRect(line).top - styleRect(c).top - CONTEXT_NUDGE_PX;
        c.scrollTop = Math.max(0, c.scrollTop + delta);
      }
      if (attempts < 6) setTimeout(seat, attempts < 3 ? 50 : 150);
      else measureEnd();
    });
  };
  seat();
};

const showJump = computed(() => showJumpToPresent({
  distance: distanceToEnd.value,
  viewport: viewportHeight.value,
  pinned: isPinned.value,
  unseen: unseenCount.value,
  detached: isDetached.value,
}));

watch(isDetached, (detached) => {
  if (!detached) return;
  setPinned(false);
  openFollowBottomUntil = 0;
});

// The control sits at the bottom-right of the viewport, where the action bar of
// a message near the bottom edge opens. That bar moves left of the control
// instead of under it. Offset in px from the bar's resting `right: 0`.
const jumpButtonRef = ref<HTMLButtonElement | null>(null);
const actionBarShift = ref(0);
const ACTION_BAR_GAP_PX = 8;

const updateActionBarShift = () => {
  const btn = jumpButtonRef.value;
  const id = hoveredMessageId.value ?? focusMessageId.value;
  const bar = btn && id ? document.getElementById(`message-${id}`)?.querySelector<HTMLElement>('.message-actions') : null;
  const item = bar?.offsetParent;
  if (!btn || !bar || !item) {
    actionBarShift.value = 0;
    return;
  }
  // Resting box: the shift moves the bar horizontally only.
  const a = styleRect(bar);
  const right = styleRect(item).right;
  const left = right - a.width;
  const b = styleRect(btn);
  const overlaps = left < b.right && b.left < right && a.top < b.bottom && b.top < a.bottom;
  actionBarShift.value = overlaps ? Math.ceil(right - b.left + ACTION_BAR_GAP_PX) : 0;
};

watch([hoveredMessageId, focusMessageId, showJump], () => nextTick(updateActionBarShift));
watch(dividerBeforeMessageId, () => nextTick(measureEnd));

// Seats a pinned view at the end. Synchronous, so a call before paint leaves no
// frame with the end uncovered.
const stickToBottom = () => {
  const el = messageDisplayContainer.value;
  if (!el || !pinState.pinned) return;
  const target = bottomScrollTop(el);
  if (target - el.scrollTop > 0.5) el.scrollTop = target;
};

let stickQueued = false;
const queueStickToBottom = () => {
  if (stickQueued) return;
  stickQueued = true;
  nextTick(() => {
    stickQueued = false;
    stickToBottom();
  });
};

// virtual-core notifies after every row measurement. The list element's height
// follows totalSize only after the re-render that notification schedules, so
// the re-seat waits for that flush.
let lastTotalSize = 0;
const handleVirtualizerChange = (instance: Virtualizer<HTMLDivElement, Element>) => {
  const total = instance.getTotalSize();
  if (total === lastTotalSize) return;
  lastTotalSize = total;
  if (pinState.pinned) queueStickToBottom();
};

// Replaces virtual-core's built-in correction for a row resized above the
// viewport, which scrolls to its cached offset (the position at the last scroll
// event) plus the accumulated deltas and so undoes whatever the user scrolled
// since that event. Applied relative to the live scrollTop instead. A pinned
// view is left to the end re-seat.
const adjustForItemResize = (item: VirtualItem, delta: number): boolean => {
  const el = messageDisplayContainer.value;
  const list = virtualListRef.value;
  if (!el || !list || pinState.pinned) return false;
  const listOffset = styleRect(list).top - styleRect(el).top + el.scrollTop;
  // The total size excludes this resize until virtual-core records it after this call.
  return correctForItemResize(el, listOffset, item.start, delta, () => {
    list.style.height = `${rowVirtualizer.value.getTotalSize() + delta}px`;
  });
};

// --- VIRTUAL SCROLLING ---
// Track the initial offset separately so it doesn't change on prepend
const frozenInitialOffset = ref(0);
let hasSetInitialOffset = false;

// --- KEYBOARD ROWS ---
// One row holds the tab stop: the last focused row, else the newest. It stays
// mounted while scrolled out of range, so the tab stop and focus survive
// virtualization.
const ROW_SELECTOR = '[data-message-row]';
const tabStopKey = computed(() => {
  const items = displayItems.value;
  const active = activeRowKey.value;
  if (active && items.some(item => item.key === active)) return active;
  return items[items.length - 1]?.key ?? null;
});
const tabStopIndex = computed(() => {
  const key = tabStopKey.value;
  return key ? displayItems.value.findIndex(item => item.key === key) : -1;
});
const rowTabindex = (key: string) => (key === tabStopKey.value ? 0 : -1);

// The row holding the floating video stays mounted while it is out of range;
// its placeholder is where the video docks when scrolled back into view.
const { floatingMessageId } = useFloatingVideo();
const floatingRowIndex = computed(() => {
  const id = floatingMessageId.value;
  if (!id) return -1;
  return displayItems.value.findIndex(item => item.type !== 'blocked-group' && item.message.id === id);
});

const rowVirtualizer = useVirtualizer<HTMLDivElement, Element>(
  computed(() => {
    const pinnedIndex = floatingRowIndex.value;
    const stopIndex = tabStopIndex.value;
    return {
      count: displayItems.value.length,
      getScrollElement: () => messageDisplayContainer.value,
      estimateSize: () => 60,
      overscan: 15,
      initialOffset: frozenInitialOffset.value,
      // Stable per-item keys. Otherwise the measurement cache is keyed by
      // INDEX: prepending a history page shifts every row's index, so each row
      // inherits a stale height from the row previously at that index, and the
      // cascade of corrective re-measurements bounces the viewport. With stable
      // keys, existing measurements survive the prepend and only new rows
      // measure in; the virtualizer's scroll adjustment compensates for those
      // above the viewport.
      getItemKey: (index: number) => displayItems.value[index]?.key ?? index,
      onChange: handleVirtualizerChange,
      rangeExtractor: (range: Range) => {
        const indexes = defaultRangeExtractor(range);
        const extra = [pinnedIndex, stopIndex].filter((index, n, all) => index >= 0 && !indexes.includes(index) && all.indexOf(index) === n);
        return extra.length > 0 ? [...indexes, ...extra].sort((a, b) => a - b) : indexes;
      },
    };
  }) as any
);

rowVirtualizer.value.shouldAdjustScrollPositionOnItemSizeChange = adjustForItemResize;

const virtualRows = computed(() => rowVirtualizer.value.getVirtualItems());
const totalSize = computed(() => rowVirtualizer.value.getTotalSize());

// --- ROW SEMANTICS ---
const listLabel = computed(() => {
  if (props.threadId) return t('messageA11y.list.thread');
  const name = beginningInfo.value.name;
  if (props.conversationId) return name ? t('messageA11y.list.conversation', { name }) : t('messageA11y.list.generic');
  return name ? t('messageA11y.list.channel', { name }) : t('messageA11y.list.generic');
});

const spokenTimeFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'long', timeStyle: 'short' }));
const spokenTime = (value: Date | string): string => {
  const date = new Date(value);
  return isValid(date) ? spokenTimeFormat.value.format(date) : '';
};

const isSendingRow = (message: Message): boolean =>
  !message.failed && (!!message.sending || !!message.id?.startsWith('temp-'));

/** Time and state, read after the row's content in its accessible name. */
const rowMeta = (message: Message): string => {
  const parts = [spokenTime(message.created_at)];
  if (isMessageEdited(message)) parts.push(t('messageA11y.row.edited'));
  if (mentionsMe(message)) parts.push(t('messageA11y.row.mentionsYou'));
  if (message.is_pinned) parts.push(t('messageA11y.row.pinned'));
  if (message.decrypted) parts.push(t('messageA11y.row.encrypted'));
  if (message.failed) parts.push(t('messageA11y.row.failed'));
  else if (isSendingRow(message)) parts.push(t('messageA11y.row.sending'));
  return parts.filter(Boolean).join(', ');
};

/** Author, reply reference, content, then time and state. */
const rowLabelledBy = (message: Message): string => {
  const id = message.id;
  if (message.is_system) return `msg-body-${id} msg-meta-${id}`;
  const parts = [`msg-head-${id}`];
  if (message.reply_to) parts.push(`msg-reply-${id}`);
  parts.push(`msg-body-${id}`, `msg-meta-${id}`);
  return parts.join(' ');
};

const showsActionBar = (messageId: string): boolean =>
  !isOptimisticId(messageId)
  && (hoveredMessageId.value === messageId || (!isMobile.value && focusMessageId.value === messageId))
  && editableMessageId.value !== messageId
  && !(isMobile.value && mobileActionTapPosition.value);

const isMenuOpenFor = (messageId: string): boolean =>
  contextMenuVisible.value && contextMenuMessage.value?.id === messageId;

// --- ROW FOCUS ---
// Popups opened from a row; focus inside one keeps the row's action bar, so
// focus can return to the button that opened it.
const POPUP_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"]';

const rowOf = (target: EventTarget | null): HTMLElement | null =>
  target instanceof Element ? target.closest<HTMLElement>(ROW_SELECTOR) : null;

const findRow = (key: string): HTMLElement | null =>
  Array.from(virtualListRef.value?.querySelectorAll<HTMLElement>(ROW_SELECTOR) ?? []).find(el => el.dataset.rowKey === key) ?? null;

/** False for focus a pointer press gave; such a row shows its bar on hover only. */
const isKeyboardFocus = (el: Element): boolean => {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
};

const onListFocusIn = (event: FocusEvent) => {
  const row = rowOf(event.target);
  if (!row) return;
  const key = row.dataset.rowKey ?? null;
  if (key && key !== activeRowKey.value) activeRowKey.value = key;
  if (isKeyboardFocus(event.target as Element)) focusMessageId.value = row.dataset.messageId ?? null;
  scheduleMute();
};

const releaseRowFocus = () => {
  const active = document.activeElement;
  if (active instanceof Element && (virtualListRef.value?.contains(active) || active.closest(POPUP_SELECTOR))) return;
  if (hasOpenLayer('dialog') || hasOpenLayer('menu')) return;
  focusMessageId.value = null;
};

const onListFocusOut = (event: FocusEvent) => {
  const next = event.relatedTarget;
  if (next instanceof Node && virtualListRef.value?.contains(next)) return;
  if (next instanceof Element && next.closest(POPUP_SELECTOR)) return;
  setTimeout(releaseRowFocus, 0);
};

const onDocumentFocusIn = (event: FocusEvent) => {
  const target = event.target;
  if (!(target instanceof Element) || virtualListRef.value?.contains(target) || target.closest(POPUP_SELECTOR)) return;
  focusMessageId.value = null;
};

// Row moves use the roving helper while the target row is mounted; a row off
// the rendered range is scrolled to first and focused once it mounts.
const roving = useRovingTabindex(virtualListRef, {
  itemSelector: ROW_SELECTOR,
  loop: false,
  onActivate: (el) => { activeRowKey.value = el.dataset.rowKey ?? null; },
  initialIndex: (items) => {
    const at = items.findIndex(el => el.dataset.rowKey === tabStopKey.value);
    return at >= 0 ? at : items.length - 1;
  },
});

/** Keeps a focused row inside the viewport; a row taller than it aligns by its top. */
const revealRow = (el: HTMLElement) => {
  const c = messageDisplayContainer.value;
  if (!c) return;
  const box = styleRect(el);
  const view = styleRect(c);
  const margin = 8;
  if (box.top < view.top + margin || box.height > view.height - 2 * margin) c.scrollTop += box.top - view.top - margin;
  else if (box.bottom > view.bottom - margin) c.scrollTop += box.bottom - view.bottom + margin;
};

const focusRowIndex = (index: number) => {
  const item = displayItems.value[index];
  if (!item) return;
  activeRowKey.value = item.key;
  const mounted = roving.items();
  const at = mounted.findIndex(el => el.dataset.rowKey === item.key);
  if (at >= 0) {
    roving.focusItem(at);
    revealRow(mounted[at]);
    return;
  }
  rowVirtualizer.value.scrollToIndex(index, { align: 'auto' });
  nextTick(() => requestAnimationFrame(() => {
    const el = findRow(item.key);
    if (el && focusElement(el)) revealRow(el);
  }));
};

const focusRowKey = (key: string | null | undefined) => {
  if (!key) return;
  const index = displayItems.value.findIndex(item => item.key === key);
  if (index >= 0) focusRowIndex(index);
};

/** Rows that fit the viewport, less one: the PageUp/PageDown step. */
const pageStep = (): number => {
  const c = messageDisplayContainer.value;
  if (!c) return 5;
  const view = c.getBoundingClientRect();
  const visible = roving.items().filter((el) => {
    const box = el.getBoundingClientRect();
    return box.bottom > view.top && box.top < view.bottom;
  }).length;
  return Math.max(1, visible - 1);
};

/** Enter, the ContextMenu key or Shift+F10 on a row. */
const activateRow = (item: DisplayItem, row: HTMLElement) => {
  if (item.type === 'blocked-group') {
    revealBlockedGroup(item.groupId);
    nextTick(() => focusRowKey(`msg-${item.groupId}`));
    return;
  }
  if (item.type === 'reported') {
    revealedReportedIds.value.add(item.message.id);
    nextTick(() => focusRowKey(`msg-${item.message.id}`));
    return;
  }
  if (isOptimisticId(item.message.id)) return;
  const box = styleRect(row);
  showContextMenu(item.message, box.left + 56, box.top + Math.min(box.height, 24), row);
};

const onListKeydown = (event: KeyboardEvent) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.matches(ROW_SELECTOR) || event.altKey || event.metaKey) return;
  const items = displayItems.value;
  const index = items.findIndex(item => item.key === target.dataset.rowKey);
  if (index < 0) return;
  if (isContextMenuKey(event) || (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey)) {
    event.preventDefault();
    activateRow(items[index], target);
    return;
  }
  let next: number;
  switch (event.key) {
    case 'ArrowUp': next = index - 1; break;
    case 'ArrowDown': next = index + 1; break;
    case 'PageUp': next = index - pageStep(); break;
    case 'PageDown': next = index + pageStep(); break;
    case 'Home': next = 0; break;
    case 'End': next = items.length - 1; break;
    default: return;
  }
  event.preventDefault();
  if (next < 0 && !isAllMessagesLoaded.value) props.loadMoreMessages?.();
  next = Math.max(0, Math.min(items.length - 1, next));
  if (next !== index) focusRowIndex(next);
};

// Interactive content of rows other than the tab stop row leaves the Tab
// sequence: Tab from a row walks that row's controls, then leaves the list.
// The original tabindex is kept in data-roving-muted and restored when the
// row becomes the tab stop or takes focus.
const ROW_INNER_FOCUSABLE = 'a[href], button, input, select, textarea, iframe, audio[controls], video[controls], [contenteditable="true"], [tabindex]';

const muteInactiveRows = () => {
  const list = virtualListRef.value;
  if (!list) return;
  const active = document.activeElement;
  for (const row of Array.from(list.querySelectorAll<HTMLElement>(ROW_SELECTOR))) {
    const live = row.dataset.rowKey === tabStopKey.value || (!!active && row.contains(active));
    for (const el of Array.from(row.querySelectorAll<HTMLElement>(ROW_INNER_FOCUSABLE))) {
      const muted = el.getAttribute('data-roving-muted');
      if (live) {
        if (muted === null) continue;
        el.removeAttribute('data-roving-muted');
        if (muted === '') el.removeAttribute('tabindex');
        else el.setAttribute('tabindex', muted);
      } else if (muted === null) {
        el.setAttribute('data-roving-muted', el.getAttribute('tabindex') ?? '');
        el.setAttribute('tabindex', '-1');
      }
    }
  }
};

let muteFrame = 0;
const scheduleMute = () => {
  if (muteFrame || typeof requestAnimationFrame === 'undefined') return;
  muteFrame = requestAnimationFrame(() => {
    muteFrame = 0;
    muteInactiveRows();
  });
};

let rowMutations: MutationObserver | null = null;
watch(virtualListRef, (el) => {
  rowMutations?.disconnect();
  rowMutations = null;
  if (!el || typeof MutationObserver === 'undefined') return;
  rowMutations = new MutationObserver(scheduleMute);
  rowMutations.observe(el, { childList: true, subtree: true });
  scheduleMute();
});
watch(tabStopKey, scheduleMute);

// --- ANNOUNCEMENTS ---
const newMessageAnnouncer = createNewMessageAnnouncer(t);
// Messages appended this soon after a context opens are the catch-up of what
// arrived while away, not live arrivals.
const ARRIVAL_GRACE_MS = 2500;
let announceArrivalsAfter = Number.POSITIVE_INFINITY;

const announceArrivals = (messages: Message[]) => {
  if (Date.now() < announceArrivalsAfter) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const items = messages
    .filter(message => !message.is_system)
    .map(message => ({
      authorName: getAuthorDisplayName(message).value,
      text: messageSpeechText(getDisplayContent(message), t, { encrypted: !!message.encrypted && !message.decrypted }),
    }));
  newMessageAnnouncer.push(items);
};

const announcedFailures = new Set<string>();
watch(() => props.messages.filter(message => message.failed).map(message => message.id), (ids) => {
  for (const id of ids) {
    if (announcedFailures.has(id)) continue;
    announcedFailures.add(id);
    assertive(t('messageA11y.failed.announce'));
  }
});

// Vue invokes a function ref on every patch of the row. The first measurement
// of a connected row registers it with the virtualizer's ResizeObserver, which
// reports every later size change; measuring again reads offsetHeight, which
// forces a synchronous layout per row on each list re-render.
// A row mounted inside a not yet inserted container is disconnected at its
// first call; the virtualizer skips it then, so it is measured again after
// the patch. A smooth scroll defers measurement of rows outside its target
// window, so rows patched while scrolling stay eligible for the next call.
const measuredRows = new WeakSet<HTMLElement>();
const measureElement = (el: any) => {
  if (!el || !(el instanceof HTMLElement)) return;
  if (measuredRows.has(el)) return;
  if (!el.isConnected) {
    nextTick(() => {
      if (el.isConnected && !measuredRows.has(el)) measureElement(el);
    });
    return;
  }
  if (!rowVirtualizer.value.isScrolling) measuredRows.add(el);
  rowVirtualizer.value.measureElement(el);
};

const remeasureItem = (messageId: string) => {
  const container = messageDisplayContainer.value;
  if (!container) return;
  const el = container.querySelector(`[data-message-id="${messageId}"]`)?.closest('[data-index]') as HTMLElement | null;
  if (el) rowVirtualizer.value.measureElement(el);
};

// --- COMPUTED PROPERTIES ---

const currentServerData = computed(() => {
  const serverId = serverChannelStore.currentServerId;
  if (!serverId) return null;

  const currentServer = serverChannelStore.currentServer as any;
  return {
    id: serverId,
    name: currentServer?.name || 'Unknown Server',
    icon: currentServer?.icon ?? null,
    banner: currentServer?.banner ?? null,
    description: currentServer?.description ?? null,
    member_count: Object.keys(serverUsersStore.userProfiles).length || 0,
  };
});

// --- HELPER FUNCTIONS ---
const getReplyMessage = (replyMessageId: string) => {
  return props.messages.find(msg => msg.id === replyMessageId)
    ?? chatStore.replyMessageCache.get(replyMessageId)
    ?? (props.conversationId ? dmStore.replyMessageCache.get(replyMessageId) : undefined)
    ?? null;
};

const getReplyUserId = (replyMessageId: string) => {
  const message = getReplyMessage(replyMessageId);
  if (!message?.user_id || message.bot_id || message.metadata?.discord_user) return '';
  return message.user_id;
};

// Independent tracking of message count and first ID, because deep watchers on reactive
// arrays receive the same reference for old/new values (in-place .push() mutations).
const lastKnownMessageCount = ref(0);
const lastKnownFirstMessageId = ref<string | null>(null);
const lastKnownLastMessageId = ref<string | null>(null);
const lastKnownDisplayItemCount = ref(0);
// Detached at the previous run of the messages watcher. Realtime rows stay out
// of a detached list, so rows appended to one are a page toward the present.
let lastKnownDetached = false;

// --- WATCHERS ---
let hasInitiallyScrolled = false;
// A context open scrolls to the bottom, but late-arriving messages (the
// stale-while-revalidate catch-up fetch, or a realtime insert) land a beat
// later. During this grace window the view keeps following the bottom so the
// user ends at the true end of the conversation rather than above the
// messages that arrived while away. Suppressed when a NEW divider is shown;
// the view rests at the divider instead.
let openFollowBottomUntil = 0;

// A channel switch served from the message cache swaps `messages` and
// `channelId` in one props update, and the messages watcher runs before the
// context watcher. A reset after it zeroes the counters that watcher just
// recorded; the catch-up append that follows then matches no branch and the
// view stays above it. Idempotent per context: the first watcher to see the
// change resets.
const contextKey = () => (props.conversationId ? `dm:${props.conversationId}` : `ch:${props.channelId ?? ''}:${props.threadId ?? ''}`);
let activeContextKey = contextKey();

const resetForContextChange = () => {
  const key = contextKey();
  if (key === activeContextKey) return;
  activeContextKey = key;
  hasInitiallyScrolled = false;
  hasSetInitialOffset = false;
  announceArrivalsAfter = Number.POSITIVE_INFINITY;
  newMessageAnnouncer.cancel();
  activeRowKey.value = null;
  focusMessageId.value = null;
  setPinned(true);
  pinState.lastScrollTop = messageDisplayContainer.value?.scrollTop ?? 0;
  lastKnownMessageCount.value = 0;
  lastKnownFirstMessageId.value = null;
  lastKnownLastMessageId.value = null;
  lastKnownDisplayItemCount.value = 0;
  lastKnownDetached = false;
  enrichmentRequestedUserIds.clear();
  enrichmentFetchedReactionIds.clear();
  enrichmentFetchedEmbedPostIds.clear();
  // Snapshot the read boundary for the newly-opened context now, before the
  // scroll observer / open-handlers mark it read. Resolved once messages load.
  captureReadBoundary();
};

watch([() => props.channelId, () => props.conversationId, () => props.threadId], resetForContextChange);

// The messages watcher below is `deep` (needed to catch prepends/appends
// wrapped in the same array ref, decrypt flips, etc.), so it re-fires on
// every nested mutation - e.g. each reaction toggle. These sets make the
// enrichment side (profiles, badges, reaction + embed batch fetches) fire
// network work only once per id instead of on every deep re-fire.
const enrichmentRequestedUserIds = new Set<string>();
const enrichmentFetchedReactionIds = new Set<string>();
const enrichmentFetchedEmbedPostIds = new Set<string>();

watch(() => props.messages, (newMessages) => {
  if (!newMessages || !Array.isArray(newMessages)) {
    return;
  }

  resetForContextChange();

  const prevCount = lastKnownMessageCount.value;
  const prevFirstId = lastKnownFirstMessageId.value;
  const prevLastId = lastKnownLastMessageId.value;
  const prevDisplayItemCount = lastKnownDisplayItemCount.value;
  const prevDetached = lastKnownDetached;
  lastKnownMessageCount.value = newMessages.length;
  lastKnownFirstMessageId.value = newMessages[0]?.id ?? null;
  lastKnownLastMessageId.value = newMessages[newMessages.length - 1]?.id ?? null;
  lastKnownDetached = isDetached.value;

  // Appended tail, split by author: front unchanged and the previous last
  // message still at its index.
  // Optimistic own rows (temp- id or sending) are messages sent from this client.
  let appendedOwn = 0;
  let appendedOwnPending = 0;
  let appendedOthers = 0;
  let pageAppend = false;
  const arrivals: Message[] = [];
  if (
    newMessages.length > prevCount &&
    prevFirstId !== null &&
    newMessages[0]?.id === prevFirstId &&
    newMessages[prevCount - 1]?.id === prevLastId
  ) {
    for (let i = prevCount; i < newMessages.length; i++) {
      const m = newMessages[i];
      if (m?.user_id === props.currentUserId) {
        appendedOwn++;
        if (m.id?.startsWith('temp-') || m.sending) appendedOwnPending++;
      } else {
        appendedOthers++;
        if (m && !isOptimisticId(m.id)) arrivals.push(m);
      }
    }
    if (prevDetached && appendedOwnPending === 0) {
      pageAppend = true;
      appendedOwn = 0;
      appendedOthers = 0;
      arrivals.length = 0;
    }
  }
  if (arrivals.length > 0) announceArrivals(arrivals);
  // A send from a detached list returns to the present, as in Discord.
  if (prevDetached && appendedOwnPending > 0) void jumpToPresent();

  // Retires the "New messages" divider as soon as the current user sends a
  // message in this context. Sending implies everything above has been seen,
  // so the divider must not linger.
  if (dividerBeforeMessageId.value && appendedOwn > 0) {
    clearReadDivider();
  }

  // A scroll event trails its scrollTop change by up to a frame. An update
  // landing in that frame applies the scroll first; otherwise a pin the scroll
  // released still holds and re-seats the view at the end. Read before the
  // patch: the prepend correction below moves scrollTop down and hides a
  // scroll up.
  const scroller = messageDisplayContainer.value;
  if (scroller && Math.abs(scroller.scrollTop - pinState.lastScrollTop) > 0.5) applyScroll(scroller);

  const oldScrollHeight = messageDisplayContainer.value?.scrollHeight ?? 0;
  // scrollTop is snapshotted alongside scrollHeight so the prepend handler
  // below can pin the viewport by height-delta (see the "Load older messages
  // (prepend)" branch). Read from the DOM BEFORE Vue patches in the new rows,
  // so it is the exact pre-prepend offset.
  const oldScrollTopForPrepend = messageDisplayContainer.value?.scrollTop ?? 0;

  const newMessageIds = new Set(newMessages.map(m => m.id));
  Object.keys(embedLoaded.value).forEach(messageId => {
    if (!newMessageIds.has(messageId)) {
      delete embedLoaded.value[messageId];
    }
  });

  const userIds = new Set<string>();
  newMessages.forEach(message => {
    if (message?.user_id) userIds.add(message.user_id);
    if (message?.reply_to) {
      const replyUserId = getReplyUserId(message.reply_to);
      if (replyUserId && replyUserId !== 'unknown') userIds.add(replyUserId);
    }
    if (message?.reactions) {
      message.reactions.forEach(reaction => reaction.reactions?.forEach(r => {
        if (r?.user_id) userIds.add(r.user_id);
      }));
    }

    if (Array.isArray(message.content)) {
      message.content.forEach(part => {
        if (part && typeof part === 'object' && 'url' in part && part.url && !(mediaLoadKey(part) in imageLoaded.value)) {
          if ((part.type === 'file' && part.fileType === 'image') || (part.type === 'url' && (part.url.endsWith('.jpg') || part.url.endsWith('.png') || part.url.endsWith('.webp')))) {
            imageLoaded.value[mediaLoadKey(part)] = false;
          }
        }
      });
    }
  });

  const newUserIds = Array.from(userIds).filter(id => !enrichmentRequestedUserIds.has(id));
  if (newUserIds.length > 0) {
    newUserIds.forEach(id => enrichmentRequestedUserIds.add(id));
    setTimeout(() => {
      ensureProfilesAvailable(newUserIds).catch(error => {
        debug.error('Error ensuring user profiles are available:', error);
      });
      // Batch-prefetch supporter badges to avoid N+1 RPC calls
      fundingService.prefetchBadges(newUserIds).catch(() => {});
    }, 0);
  }

  // Batch fetch reactions for all messages (avoid N+1 queries)
  if (newMessages.length > 0) {
    const realMessageIds = newMessages
      .filter(msg => !msg.id.startsWith('temp-') && !msg.sending && !enrichmentFetchedReactionIds.has(msg.id))
      .map(msg => msg.id);

    if (realMessageIds.length > 0) {
      realMessageIds.forEach(id => enrichmentFetchedReactionIds.add(id));
      // Batch fetch reactions for all messages at once
      reactionsStore.fetchMultipleMessageReactions(realMessageIds).catch(error => {
        debug.error('Error batch fetching reactions:', error);
      });
    }

    // Batch pre-fetch post reactions for harmony-post embeds (so MonyPost shows them immediately)
    const embedPostIds = new Set<string>();
    newMessages.forEach(msg => {
      const embeds = msg.metadata?.embeds as Record<string, { provider?: string; harmony?: { postId?: string } }> | undefined;
      if (!embeds) return;
      Object.values(embeds).forEach(embed => {
        const postId = embed?.provider === 'harmony-post' ? embed.harmony?.postId : undefined;
        if (postId && !enrichmentFetchedEmbedPostIds.has(postId)) {
          embedPostIds.add(postId);
        }
      });
    });
    if (embedPostIds.size > 0) {
      embedPostIds.forEach(id => enrichmentFetchedEmbedPostIds.add(id));
      postReactionsStore.fetchMultiplePostReactions(Array.from(embedPostIds)).catch(() => {});
    }
  }

  if (newMessages.length > 0) {
    nextTick(() => {
      if (messageDisplayContainer.value) {
        // If this is the initial load, scroll to bottom
        if (!hasInitiallyScrolled && newMessages.length > 0) {
          hasInitiallyScrolled = true;
          announceArrivalsAfter = Date.now() + ARRIVAL_GRACE_MS;
          // The new context's messages are now on screen; advance the coloring
          // server so author names resolve against this server's roles. Doing it
          // here (rather than on currentServerId change) prevents the previous
          // server's messages from being briefly repainted during the switch.
          coloringServerId.value = serverChannelStore.currentServerId;

          // Marks the first unread message with the "New messages" line. The view
          // opens at the end, as Discord's does; the unread bar jumps to the line.
          resolveDivider(newMessages, props.currentUserId);

          // The floating player's return button navigated here: land on the
          // video's message, where its placeholder docks it.
          const returnMsgId = floatingReturnTarget();
          const returnIndex = returnMsgId
            ? displayItems.value.findIndex(it => it.type === 'message' && it.message.id === returnMsgId)
            : -1;
          const hasAnchor = returnIndex >= 0;

          // Freezes the initial offset for this channel, seeded near the landing
          // so the virtualizer starts close to its final resting place.
          if (!hasSetInitialOffset) {
            hasSetInitialOffset = true;
            frozenInitialOffset.value = (hasAnchor ? returnIndex : displayItems.value.length) * 60;
          }

          // Landing on a floating video's message is not the bottom; size changes
          // must not pull the view down. Scroll events re-pin it if the landing
          // reaches the end.
          setPinned(!hasAnchor);

          // Messages arriving in the next couple of seconds (the cache path's
          // catch-up, realtime) are followed so the view settles on the real end.
          openFollowBottomUntil = hasAnchor ? 0 : Date.now() + 2500;
          
          const imageUrlsInMessages = new Set<string>();
          const embedCountsByMessage = new Map<string, number>();
          
          newMessages.forEach(message => {
            // Count embeds in this message
            let embedCount = 0;
            if (Array.isArray(message.content)) {
              message.content.forEach(part => {
                // Check for image parts
                if (part && typeof part === 'object' && 'url' in part && part.url) {
                  if ((part.type === 'file' && part.fileType === 'image') || 
                      (part.type === 'url' && (part.url.endsWith('.jpg') || part.url.endsWith('.png') || part.url.endsWith('.webp') || part.url.endsWith('.gif')))) {
                    imageUrlsInMessages.add(mediaLoadKey(part));
                  }
                }
                // Check for embed parts
                if (part && typeof part === 'object' && (part.type === 'embed' || (part.type === 'url' && message.metadata?.embeds?.[part.url]))) {
                  embedCount++;
                }
              });
            }
            // Also check metadata.embeds
            if (message.metadata?.embeds) {
              embedCount += Object.keys(message.metadata.embeds).length;
            }
            if (embedCount > 0) {
              embedCountsByMessage.set(message.id, embedCount);
              if (!embedLoaded.value[message.id]) {
                embedLoaded.value[message.id] = 0;
              }
            }
          });
          
          const pendingImages = Array.from(imageUrlsInMessages).filter(url => {
            // Image is pending if it's not in the loaded map or explicitly marked as false
            return url in imageLoaded.value ? imageLoaded.value[url] === false : true;
          });
          
          const totalEmbeds = Array.from(embedCountsByMessage.values()).reduce((sum, count) => sum + count, 0);
          debug.log('Pending images to load:', pendingImages.length, 'out of', imageUrlsInMessages.size);
          debug.log('Total embeds to load:', totalEmbeds);
          
          // A jump to a message or to the present ends these retries.
          const landing = seatGeneration;

          let scrollAttempts = 0;
          const scrollToBottom = () => {
            if (landing !== seatGeneration) return;
            scrollAttempts++;
            const count = displayItems.value.length;
            if (count > 0) {
              rowVirtualizer.value.scrollToIndex(count - 1, { align: 'end' });
            }
            // Raw fallback: also set scrollTop directly in case virtualizer hasn't laid out yet
            if (messageDisplayContainer.value) {
              messageDisplayContainer.value.scrollTop = messageDisplayContainer.value.scrollHeight;
            }
            requestAnimationFrame(() => {
              if (messageDisplayContainer.value) {
                const { scrollTop, scrollHeight, clientHeight } = messageDisplayContainer.value;
                const isAtBottom = scrollTop + clientHeight >= scrollHeight - 5;
                if (!isAtBottom && scrollAttempts < 8) {
                  setTimeout(() => scrollToBottom(), scrollAttempts < 3 ? 50 : 150);
                }
                // else: settled, or retries exhausted. The pin stays: late
                // content (catch-up append, media, embeds) keeps re-seating the
                // view until the user scrolls up.
              }
            });
          };

          // Centres the floating video's placeholder; retries while rows measure.
          let returnScrollAttempts = 0;
          const scrollToReturn = () => {
            if (landing !== seatGeneration) return;
            returnScrollAttempts++;
            const idx = displayItems.value.findIndex(
              it => it.type === 'message' && it.message.id === returnMsgId
            );
            if (idx < 0) {
              scrollToBottom();
              return;
            }
            rowVirtualizer.value.scrollToIndex(idx, { align: 'center' });
            requestAnimationFrame(() => {
              if (landing !== seatGeneration) return;
              const c = messageDisplayContainer.value;
              const placeholder = c?.querySelector('.floating-video-placeholder') as HTMLElement | null;
              if (c && placeholder) {
                const box = styleRect(placeholder);
                const view = styleRect(c);
                c.scrollTop += box.top + box.height / 2 - (view.top + view.height / 2);
              }
              if (returnScrollAttempts < 6) setTimeout(scrollToReturn, returnScrollAttempts < 3 ? 50 : 150);
            });
          };

          const scrollToTarget = () => (returnIndex >= 0 ? scrollToReturn() : scrollToBottom());

          if (pendingImages.length === 0 && totalEmbeds === 0) {
            // Scroll immediately, then retry after virtualizer renders
            nextTick(() => scrollToTarget());
          } else {
            const maxWaitTime = 3000; // Maximum 3 seconds (increased for embeds)
            const startTime = Date.now();
            
            const checkAndScroll = () => {
              const imagesLoadedCount = pendingImages.filter(url => imageLoaded.value[url] === true).length;
              
              // Count loaded embeds
              let embedsLoadedCount = 0;
              embedCountsByMessage.forEach((expectedCount, messageId) => {
                const loadedCount = embedLoaded.value[messageId] || 0;
                embedsLoadedCount += Math.min(loadedCount, expectedCount);
              });
              
              const elapsed = Date.now() - startTime;
              const allImagesLoaded = imagesLoadedCount >= pendingImages.length;
              const allEmbedsLoaded = embedsLoadedCount >= totalEmbeds;
              
              // Scroll if all content loaded or timeout reached
              if ((allImagesLoaded && allEmbedsLoaded) || elapsed >= maxWaitTime) {
                debug.log(`Images loaded: ${imagesLoadedCount}/${pendingImages.length}, Embeds loaded: ${embedsLoadedCount}/${totalEmbeds}, elapsed: ${elapsed}ms`);
                scrollToTarget();
              } else {
                // Check again after a short delay
                setTimeout(checkAndScroll, 100);
              }
            };
            
            // Start checking after initial render
            setTimeout(checkAndScroll, 100);
          }
        }
        // New messages appended at bottom (sent or received)
        else if (prevCount > 0 && newMessages.length > prevCount && oldScrollHeight > 0) {
          const isAppend = prevFirstId != null && newMessages[0]?.id === prevFirstId;
          // The bottom is followed when the view is pinned there, when one of
          // the new messages was just sent from this client, or while the
          // post-open grace window is active (catch-up messages from
          // revalidate / realtime).
          const followBottom = !pageAppend && (pinState.pinned || appendedOwnPending > 0 ||
            Date.now() < openFollowBottomUntil);
          if (isAppend && followBottom) {
            debug.log('New messages - scrolling to bottom (pinned / own / open grace)');
            setPinned(true);
            // The appended rows are in this flush. Later row measurements and
            // resizes re-seat the view again.
            stickToBottom();
            requestAnimationFrame(stickToBottom);
          } else if (isAppend && !pageAppend) {
            unseenCount.value += appendedOthers;
          }
          // Load older messages (prepend): everything added sits above the
          // previous first row, so the scroll-height growth since the snapshot
          // taken before the DOM patch is exactly how far the content in view
          // was pushed down. Rows measured after this write are corrected one
          // by one in adjustForItemResize, relative to the live scrollTop; a
          // second absolute write on the next frame would undo any scrolling
          // done in between. `scrollToIndex` is not used: it issues a new
          // scroll command and re-fires as rows re-measure.
          else if (!isAppend && newMessages.some(m => m.id === prevFirstId)) {
            const container = messageDisplayContainer.value;
            if (container) {
              const next = scrollTopAfterPrepend(oldScrollTopForPrepend, oldScrollHeight, container.scrollHeight);
              if (next !== oldScrollTopForPrepend) container.scrollTop = next;
            }
            // prevDisplayItemCount is unused here because the pin is by
            // height-delta, not by displayItems index. The read keeps the
            // unused-var lint quiet.
            void prevDisplayItemCount;
          }
        }

        // The list was replaced: the newest page reloaded over a gap.
        const replaced = prevFirstId !== null && !newMessages.some(m => m.id === prevFirstId);
        // Rows the open's catch-up or a reload brought can hold the first unread
        // message; the line is placed against the rows now loaded.
        if (replaced || (!dividerBeforeMessageId.value && Date.now() < openFollowBottomUntil)) {
          resolveDivider(newMessages, props.currentUserId);
        }
        if (replaced && pinState.pinned && !isDetached.value) {
          stickToBottom();
          requestAnimationFrame(stickToBottom);
        }
        
        checkScrollable();
        isAtTop.value = messageDisplayContainer.value.scrollTop === 0;
        emit('update:isAtBottom', distanceFromBottom(messageDisplayContainer.value) <= PIN_THRESHOLD_PX);
        measureEnd();
      }
      lastKnownDisplayItemCount.value = displayItems.value.length;
    });
  }
}, { immediate: true, deep: true });

// After older messages finish loading, a still-visible sentinel (content not
// filling the viewport) triggers another batch. IntersectionObserver fires
// only on intersection *changes*, so the re-trigger is manual.
watch(isLoadingOlderMessages, (loading, wasLoading) => {
  if (wasLoading && !loading && !isAllMessagesLoaded.value && props.loadMoreMessages) {
    // Delay to let virtualizer measure new elements before checking overflow
    setTimeout(() => {
      if (!messageDisplayContainer.value) return;
      const { scrollHeight, clientHeight } = messageDisplayContainer.value;
      if (scrollHeight <= clientHeight + 5) {
        debug.log('Still no scrollbar after loading - auto-loading more');
        props.loadMoreMessages?.();
      }
    }, 300);
  }
});

// Getter already tracks reactions-length per message; deep traversal on top
// of it was redundant work on every message mutation.
watch(() => props.messages.map(msg => msg.reactions?.length), () => {
  const hasVisibleReactions = props.messages.some(msg => msg.reactions && msg.reactions.length > 0);
  if (!hasVisibleReactions && tooltip.value.visible) {
    hideTooltip();
  }
});

// IntersectionObserver to clear unread counts when messages are scrolled into view
// Debounced to prevent 45+ API calls per page load. A thread view carries its
// parent's channelId; thread replies do not count toward the channel, so a thread
// view sends no channel reads.
let intersectionObserver: IntersectionObserver | null = null;
const observedMessages = new Set<string>();

const sendsReadMarkers = () => !props.threadId && !!(props.channelId || props.conversationId);

const setupUnreadObserver = () => {
  if (!sendsReadMarkers()) return;
  
  if (intersectionObserver) {
    intersectionObserver.disconnect();
  }
  
  intersectionObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const messageId = entry.target.getAttribute('data-message-id');
        if (!messageId || messageId.startsWith('temp-') || observedMessages.has(messageId)) {
          return;
        }
        observedMessages.add(messageId);
        queueUnreadUpdate(messageId);
      });
    },
    {
      root: messageDisplayContainer.value as unknown as Element | null,
      rootMargin: '0px',
      threshold: 0.1 // Trigger when 10% of message is visible
    }
  );
  
  // Observe all message elements
  nextTick(() => {
    if (messageDisplayContainer.value) {
      const messageElements = messageDisplayContainer.value.querySelectorAll('[data-message-id]');
      messageElements.forEach((el) => {
        const id = el.getAttribute('data-message-id');
        if (id && !id.startsWith('temp-')) {
          intersectionObserver?.observe(el);
        }
      });
    }
  });
};

// Rows of a detached list are history; a read of one would move the channel's
// last read message back.
const queueUnreadUpdate = (messageId: string) => {
  if (!sendsReadMarkers() || isDetached.value) return;
  const message = props.messages.find(m => m.id === messageId);
  if (!message) return;
  const channelId = props.channelId || message.channel_id || null;
  const conversationId = channelId ? null : (props.conversationId || message.conversation_id || null);
  if (!channelId && !conversationId) return;
  readMarkers.queue({
    messageId,
    createdAt: new Date(message.created_at).getTime(),
    channelId,
    conversationId,
  });
};

const clearUnreadCount = async ({ messageId, channelId, conversationId }: QueuedRead) => {
  try {
    const { authContextService } = await import('@/services/AuthContextService');
    const ctx = await authContextService.getCurrentContext();
    if (!ctx.isAuthenticated) return;

    // The read marks the context's notifications read, server and local.
    try {
      if (channelId) await markChannelRead(channelId, messageId);
      else if (conversationId) await markConversationRead(conversationId, messageId);
      debug.log('Cleared unread count for', channelId ? 'channel' : 'conversation', channelId || conversationId);
    } catch (error) {
      debug.error('Failed to clear unread count:', error);
    }
    
    // Notifications that name the message but not its channel or conversation.
    const notificationStore = useNotificationStore();
    const relatedNotifications = notificationStore.notifications.filter(n => 
      (n.data?.message?.id === messageId || n.data?.message_id === messageId) && !n.is_read
    );
    
    // Mark all related notifications in parallel instead of sequentially
    if (relatedNotifications.length > 0) {
      await Promise.all(relatedNotifications.map(n => notificationStore.markAsRead(n.id)));
    }
  } catch (error) {
    debug.error('Error clearing unread count:', error);
  }
};

const readMarkers = createReadMarkerQueue((read) => clearUnreadCount(read));

// A read queued in the channel or conversation being left goes out now. The
// component is reused across contexts; ids observed in the previous one must not
// suppress reads in the next.
watch(() => [props.channelId, props.conversationId, props.threadId], () => {
  void readMarkers.flush();
  observedMessages.clear();
});

// Opening a channel with unread state reads it: its newest messages may have been
// observed on an earlier visit, or its unread state may come from messages this
// view does not render.
let openReadChannelId: string | null = null;
watch(
  [() => props.channelId, () => props.conversationId, () => props.threadId, () => props.messages[props.messages.length - 1]?.id],
  () => {
    const channelId = props.channelId;
    if (!channelId || props.conversationId || props.threadId) {
      openReadChannelId = null;
      return;
    }
    if (openReadChannelId === channelId) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    let newest: Message | undefined;
    for (let i = props.messages.length - 1; i >= 0; i--) {
      const m = props.messages[i];
      if (m.channel_id === channelId && !m.thread_id && !m.id.startsWith('temp-')) { newest = m; break; }
    }
    if (!newest) return;
    openReadChannelId = channelId;
    const unread = getUnreadCount({ channelId });
    const hasUnread = (unread?.unread_messages ?? 0) > 0
      || (unread?.unread_mentions ?? 0) > 0
      || useNotificationStore().unreadChannelMentions(channelId) > 0;
    if (hasUnread) queueUnreadUpdate(newest.id);
  },
  { immediate: true },
);

// Watch for messages changes to setup observer
watch(() => props.messages.length, () => {
  if (props.messages.length > 0) {
    nextTick(() => {
      setupUnreadObserver();
    });
  }
}, { immediate: true });

// Re-observe when virtual scroll renders new message elements
let virtualRowObserverTimeout: ReturnType<typeof setTimeout> | null = null;
watch(virtualRows, () => {
  if (!intersectionObserver) return;
  if (virtualRowObserverTimeout) clearTimeout(virtualRowObserverTimeout);
  virtualRowObserverTimeout = setTimeout(() => {
    nextTick(() => {
      if (!messageDisplayContainer.value || !intersectionObserver) return;
      const messageElements = messageDisplayContainer.value.querySelectorAll('[data-message-id]');
      messageElements.forEach((el) => {
        const id = el.getAttribute('data-message-id');
        if (id && !id.startsWith('temp-') && !observedMessages.has(id)) {
          intersectionObserver?.observe(el);
        }
      });
    });
  }, 100);
});

onUnmounted(() => {
  window.removeEventListener('megolm-key-received', refreshCanDecrypt);
  window.removeEventListener('bot:updated', handleBotUpdated as EventListener);

  if (virtualRowObserverTimeout) {
    clearTimeout(virtualRowObserverTimeout);
    virtualRowObserverTimeout = null;
  }

  readMarkers.flush().catch((err) => {
    console.warn('Failed to flush unread update on unmount:', err);
  });
  
  if (intersectionObserver) {
    intersectionObserver.disconnect();
    intersectionObserver = null;
  }
  if (topSentinelObserver) {
    topSentinelObserver.disconnect();
    topSentinelObserver = null;
  }
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  observedMessages.clear();
  if (tooltipTimer.value) clearTimeout(tooltipTimer.value);
  tooltipTimer.value = null;
  tooltip.value.visible = false;
});


// --- TOP SENTINEL OBSERVER ---
// When the top of the message list is visible (either because user scrolled to top
// or because content doesn't fill the viewport), auto-load older messages.
let topSentinelObserver: IntersectionObserver | null = null;

const setupTopSentinelObserver = () => {
  if (topSentinelObserver) topSentinelObserver.disconnect();
  if (!topSentinelRef.value || !messageDisplayContainer.value) return;

  topSentinelObserver = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (entry?.isIntersecting && hasInitiallyScrolled && !isAllMessagesLoaded.value && !isLoadingOlderMessages.value && props.loadMoreMessages) {
        debug.log('Top sentinel visible (prefetch zone) - auto-loading older messages');
        props.loadMoreMessages?.();
      }
    },
    { root: messageDisplayContainer.value as unknown as Element | null, threshold: 0, rootMargin: '300px 0px 0px 0px' }
  );
  topSentinelObserver.observe(topSentinelRef.value as unknown as Element);
};

// --- RESIZE OBSERVER for stick-to-bottom ---
// The scroll container shrinks under a pinned view when the composer grows
// (multi-line draft, reply bar, attachment previews) or a mobile keyboard
// opens; the list element grows with content. Either leaves the end below the
// viewport until re-seated. Callbacks run before paint.
let resizeObserver: ResizeObserver | null = null;

const setupResizeObserver = () => {
  if (resizeObserver || !messageDisplayContainer.value) return;
  resizeObserver = new ResizeObserver(() => {
    stickToBottom();
    measureEnd();
  });
  resizeObserver.observe(messageDisplayContainer.value);
  if (virtualListRef.value) resizeObserver.observe(virtualListRef.value);
};

watch(virtualListRef, (el, prev) => {
  if (!resizeObserver) return;
  if (prev) resizeObserver.unobserve(prev);
  if (el) resizeObserver.observe(el);
});

// Pins and seats the view at the end. scrollToOffset replaces a scrollToIndex
// reconcile still running from a jump; that loop re-targets its index when
// rows change and would pull the view back to it.
const seatAtEnd = () => {
  const el = messageDisplayContainer.value;
  if (!el) return;
  setPinned(true);
  rowVirtualizer.value.scrollToOffset(bottomScrollTop(el));
  stickToBottom();
};

// A detached list is then replaced by the newest page, as a cold open loads it,
// and the view seats at its end.
const jumpToPresent = async () => {
  const reload = isDetached.value;
  seatGeneration++;
  seatAtEnd();
  if (!reload) return;
  try {
    if (props.conversationId) await dmStore.reloadNewestPage(props.conversationId);
    else if (props.channelId) await chatStore.reloadNewestPage(props.channelId);
  } catch (error) {
    debug.error('Failed to reload the newest messages:', error);
  }
  await nextTick();
  seatAtEnd();
};

// Rows toward the present load while the end of a detached list is within this
// distance of the viewport, as older rows do near the top.
const NEWER_PREFETCH_PX = 400;

const loadNewerMessages = () => {
  if (props.conversationId) void dmStore.fetchNewerMessages(props.conversationId);
  else if (props.channelId) void chatStore.fetchNewerMessages(props.channelId);
};

const maybeLoadNewer = () => {
  const el = messageDisplayContainer.value;
  if (!el || !isDetached.value || isLoadingNewerMessages.value) return;
  if (distanceFromBottom(el) < NEWER_PREFETCH_PX) loadNewerMessages();
};

// A page that leaves the end of the list within reach loads the next one; no
// scroll event follows a page appended below the view.
watch(isLoadingNewerMessages, (loading, wasLoading) => {
  if (wasLoading && !loading) setTimeout(maybeLoadNewer, 300);
});

// The message a jump landed on. Bound in the template, so it survives the row
// leaving the rendered range.
const highlightedRowId = ref<string | null>(null);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
const HIGHLIGHT_MS = 3000;

const highlightRow = (messageId: string) => {
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightedRowId.value = messageId;
  highlightTimer = setTimeout(() => {
    highlightTimer = null;
    if (highlightedRowId.value === messageId) highlightedRowId.value = null;
  }, HIGHLIGHT_MS);
};

// Centres a message row and highlights it. The virtualizer's smooth scroll targets
// estimated offsets and does not follow rows that measure while it runs, so the
// position is re-seated from the row's DOM box while rows above it settle. A row
// taller than the view is aligned by its top instead.
const jumpToMessageRow = (messageId: string): boolean => {
  const indexOf = () => displayItems.value.findIndex(
    item => item.type === 'message' && item.message?.id === messageId
  );
  if (indexOf() < 0) return false;
  setPinned(false);
  openFollowBottomUntil = 0;
  highlightRow(messageId);
  const generation = ++seatGeneration;
  let attempts = 0;
  const seat = () => {
    if (generation !== seatGeneration) return;
    attempts++;
    const idx = indexOf();
    if (idx < 0) return;
    rowVirtualizer.value.scrollToIndex(idx, { align: 'center' });
    requestAnimationFrame(() => {
      if (generation !== seatGeneration) return;
      const c = messageDisplayContainer.value;
      const el = document.getElementById(`message-${messageId}`);
      if (c && el) {
        const box = styleRect(el);
        const view = styleRect(c);
        c.scrollTop += box.height > view.height - CONTEXT_NUDGE_PX
          ? box.top - view.top - CONTEXT_NUDGE_PX
          : box.top + box.height / 2 - (view.top + view.height / 2);
      }
      if (attempts < 6) setTimeout(seat, attempts < 3 ? 50 : 150);
      else maybeLoadNewer();
    });
  };
  seat();
  return true;
};

// --- LIFECYCLE HOOKS ---
onMounted(() => {
  // Snapshot the read boundary for the initially-opened context (the reset
  // watcher only fires on subsequent context changes, not first mount).
  captureReadBoundary();
  if (messageDisplayContainer.value) {
    isAtTop.value = messageDisplayContainer.value.scrollTop === 0;
    checkScrollable();
    measureEnd();
  }
  setupTopSentinelObserver();
  setupResizeObserver();
  window.addEventListener('keydown', onShiftDown);
  window.addEventListener('keyup', onShiftUp);
  document.addEventListener('focusin', onDocumentFocusIn);
  // A thread view shares the channel id but not the channel's list.
  if (!props.threadId) chatStore.highlightMessage = (messageId: string) => { jumpToMessageRow(messageId); };
});

// Watch for DM highlight requests (reply jump in DMs)
watch(() => dmStore.highlightedMessageId, (messageId) => {
  if (!messageId || !props.conversationId) return;
  jumpToMessageRow(messageId);
  dmStore.highlightedMessageId = null;
});

onUnmounted(() => {
  window.removeEventListener('keydown', onShiftDown);
  window.removeEventListener('keyup', onShiftUp);
  document.removeEventListener('focusin', onDocumentFocusIn);
  newMessageAnnouncer.cancel();
  rowMutations?.disconnect();
  if (muteFrame) cancelAnimationFrame(muteFrame);
  if (longPressTimer.value) {
    clearTimeout(longPressTimer.value);
  }
  clearReadDivider();
  if (!props.threadId) chatStore.highlightMessage = (_messageId: string) => {};
  if (highlightTimer) clearTimeout(highlightTimer);
});

// --- METHODS ---

// Tooltip Handling
// Generation counter: a hide during the profile preload drops the pending show.
let tooltipGeneration = 0;

const showTooltip = async (event: MouseEvent, reaction: ReactionGroup) => {
  if (tooltipTimer.value) clearTimeout(tooltipTimer.value);
  const generation = ++tooltipGeneration;
  // currentTarget is null once dispatch ends; the anchor is read before the await.
  const anchor = getReactionTooltipAnchor(event);

  const profileIds = reactionProfileIds(reaction.reactions);
  if (profileIds.length > 0) {
    await ensureProfilesAvailable(profileIds).catch(error =>
      debug.error("Error ensuring profiles for tooltip:", error)
    );
  }
  if (generation !== tooltipGeneration) return;

  const usersDetails = toReactionUsers(reaction.reactions, reactionUserResolvers);
  tooltipTimer.value = setTimeout(() => {
    tooltip.value = { visible: true, content: usersDetails, x: anchor.x, y: anchor.y, emoji: reaction.emoji };
  }, 500);
};

const hideTooltip = () => {
  tooltipGeneration++;
  if (tooltipTimer.value) clearTimeout(tooltipTimer.value);
  tooltipTimer.value = null;
  tooltip.value.visible = false;
};

// Scroll & UI State
const checkScrollable = () => {
  if (messageDisplayContainer.value) {
    hasScrollbar.value = messageDisplayContainer.value.scrollHeight > messageDisplayContainer.value.clientHeight;
  }
};

const handleScrollThrottled = throttle(() => {
  if (!messageDisplayContainer.value) {
    return;
  }
  
  const { scrollTop } = messageDisplayContainer.value;
  
  checkScrollable();
  isAtTop.value = scrollTop === 0;

  // Prefetch when near top (within 400px)
  if (scrollTop < 400 && hasScrollbar.value) {
    if (!isAllMessagesLoaded.value && !isLoadingOlderMessages.value && props.loadMoreMessages) {
      props.loadMoreMessages();
    }
  }
  maybeLoadNewer();

  emit('update:isAtBottom', distanceFromBottom(messageDisplayContainer.value) <= PIN_THRESHOLD_PX);
  if (hoveredMessageId.value || focusMessageId.value) updateActionBarShift();
}, 16);

// Not throttled: a size change in the same frame reads the pin, and a stale
// pin re-seats a view the user has just scrolled away from.
const handleScroll = () => {
  const el = messageDisplayContainer.value;
  if (el) {
    applyScroll(el);
    measureEnd();
  }
  handleScrollThrottled();
};

// Message Display Logic
const shouldShowHeader = (message: Message, index: number): boolean => {
  if (index === 0) return true;
  const prevMessage = props.messages[index - 1];
  if (!prevMessage) return true;

  if (message.is_system || prevMessage.is_system) return true;

  // For bot-puppeted messages (e.g., Discord bridge), compare the puppeted user identity
  // rather than the bot_id, since multiple Discord users are puppeted through the same bot
  if (message.bot_id && prevMessage.bot_id) {
    const currentDiscordUser = message.metadata?.discord_user;
    const prevDiscordUser = prevMessage.metadata?.discord_user;
    
    const currentWebhook = getWebhookAuthor(message);
    const prevWebhook = getWebhookAuthor(prevMessage);
    if (currentWebhook || prevWebhook) {
      // One webhook posts under per-message names and avatars.
      if (currentWebhook?.id !== prevWebhook?.id
          || currentWebhook?.name !== prevWebhook?.name
          || currentWebhook?.avatar_url !== prevWebhook?.avatar_url) return true;
    }
    // If both have discord_user metadata, compare by discord user id or username
    else if (currentDiscordUser && prevDiscordUser) {
      const currentId = currentDiscordUser.id || currentDiscordUser.username;
      const prevId = prevDiscordUser.id || prevDiscordUser.username;
      if (currentId !== prevId) return true;
    } 
    // If one has discord_user and the other doesn't, show header
    else if (currentDiscordUser !== prevDiscordUser) {
      return true;
    }
    // If neither has discord_user, compare bot_ids (same bot = same author)
    else if (message.bot_id !== prevMessage.bot_id) {
      return true;
    }
  } 
  // Standard user message comparison
  // Note: Use nullish coalescing to normalize null/undefined for bot_id comparison
  // This fixes optimistic messages (bot_id: undefined) vs DB messages (bot_id: null)
  else if (prevMessage.user_id !== message.user_id || (prevMessage.bot_id ?? null) !== (message.bot_id ?? null)) {
    return true;
  }
  
  if (message.reply_to) return true;
  const timeDiff = new Date(message.created_at).getTime() - new Date(prevMessage.created_at).getTime();
  return timeDiff > 5 * 60 * 1000;
};

const shouldShowDateSeparator = (message: Message, index: number): boolean => {
  if (index === 0) return false;
  const prevMessage = props.messages[index - 1];
  return !isSameDay(new Date(message.created_at), new Date(prevMessage.created_at));
};

// Formatting
const formatTimestamp = (timestamp: Date) => {
  const date = new Date(timestamp);
  if (!isValid(date)) return '';
  if (isToday(date)) return format(date, 'p');
  if (isYesterday(date)) return `Yesterday at ${format(date, 'p')}`;
  return format(date, 'MMM d, yyyy \'at\' p');
};

const isMessageEdited = (message: Message): boolean => {
  if (!message.updated_at || !message.created_at) return false;
  
  const createdAt = new Date(message.created_at).getTime();
  const updatedAt = new Date(message.updated_at).getTime();
  
  // Consider edited if updated_at is more than 1 second after created_at
  // (allows for small timing differences in the database)
  return updatedAt - createdAt > 1000;
};

const formatTimeOnly = (timestamp: Date) => {
  const date = new Date(timestamp);
  if (!isValid(date)) return '';
  return format(date, 'p');
};

/** Visible lines of a system message's timestamp. */
const systemTimestampLines = (timestamp: Date): string[] => {
  const date = new Date(timestamp);
  if (!isValid(date)) return [];
  if (isToday(date)) return [format(date, 'p')];
  if (isYesterday(date)) return [t('systemEvents.yesterdayAt'), format(date, 'p')];
  return [format(date, 'MMM d, yyyy'), format(date, 'p')];
};

const formatDateSeparator = (timestamp: Date): string => {
  const date = new Date(timestamp);
  if (!isValid(date)) return '';
  if (isToday(date)) return 'Today';
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'MMMM d, yyyy');
};

// Message Actions (Edit, Delete, React)
const canEditMessage = (message: Message) => {
  if (!authStore.session?.user || !message) return false;

  if (message.id.startsWith('temp-')) return false;
  if (message.sending) return false;
  if (message.encrypted && !message.decrypted) return false;
  // A relayed message's author lives on the bridged platform; an edit made
  // here never reaches that copy. Applies to admins and moderators too.
  if (isBridgedAuthorMessage(message)) return false;
  // guard_message_poll_parts refuses edits of a poll.
  if (pollPartOf(message.content)) return false;

  // Only the author edits; owners, staff and Manage Messages may only delete
  // (guard_message_client_write).
  return message.user_id === profileStore.profile?.id;
};

const canEditAttachments = (message: Message) => canEditMessage(message);

const isInstanceStaff = computed(() => profileStore.profile?.is_admin === true || profileStore.profile?.is_moderator === true);
const instanceDomain = getInstanceDomain();
const copyHost = computed(() =>
  remoteServerHost(serverChannelStore.currentServer) || t('serverCopy.banner.unknownHost'));

/** Another member's message in a copy: removing it hides it on this instance only. */
const isInstanceHide = (message: Message | null | undefined): boolean =>
  !!message && !props.conversationId
  && serverChannelStore.currentServer?.is_local_server === false
  && message.user_id !== profileStore.profile?.id;

const deleteActionLabel = (message: Message): string =>
  isInstanceHide(message) ? t('serverCopy.hide.action', { instance: instanceDomain }) : t('message.deleteMessage');

const canDeleteMessage = (message: Message) => {
  if (!authStore.session?.user || !message) return false;

  const currentProfileId = profileStore.profile?.id;
  const messageUserId = message.user_id;
  const isOwnMessage = messageUserId === currentProfileId;

  // In a copy the author deletes their own message; instance staff hide others' on this instance
  // only (messages_update_authorized). System rows are the host's.
  if (serverChannelStore.currentServer?.is_local_server === false) {
    if (isOwnMessage) return true;
    return !message.is_system && isInstanceStaff.value;
  }

  // System rows are removed by MANAGE_MESSAGES holders only; in a conversation the
  // database admits group admins, a role this view does not carry.
  if (message.is_system) {
    return !message.conversation_id && (isCurrentUserServerOwner.value || canManageMessages.value);
  }

  if (isOwnMessage) return true;
  if (isCurrentUserServerOwner.value && !message.conversation_id) return true;
  if (profileStore.profile?.is_admin || profileStore.profile?.is_moderator) return true;
  if (canManageMessages.value) return true;

  return false;
};




// Where focus returns after an edit: the control it started from (the More
// button or row behind a menu item, the composer for ArrowUp), else the row.
let editOrigin: HTMLElement | null = null;

const startEdit = (message: Message) => {
  if (!canEditMessage(message)) return;
  editOrigin = resolveFocusOrigin(currentFocusOrigin());
  editableMessageId.value = message.id;
  // Exclude file parts from the editable text - attachments are shown and
  // managed as a separate, individually-removable media list in edit mode.
  editableMessageContent.value = messagePartsToMarkdown(message.content, { excludeFiles: true });
  hoveredMessageId.value = null;
  nextTick(() => {
    const editInput = document.querySelector(`#edit-input-${message.id}`) as HTMLTextAreaElement;
    if (editInput) {
      editInput.focus();
      const len = editInput.value.length;
      editInput.setSelectionRange(len, len);
    }
  });
};

/**
 * Saves an edit through the list's owner, shown at once (optimisticEdit.ts). Thread replies live
 * in the thread view's own list, which this view renders.
 */
const saveStoredEdit = (messageId: string, content: MessagePart[]): Promise<unknown> => {
  if (props.threadId) {
    const message = props.messages.find((m) => m.id === messageId);
    if (!message) return Promise.resolve();
    return saveEditOptimistically({
      message,
      content,
      // By id: a realtime update replaces the row object in the thread's list.
      patch: (fields) => {
        const shown = props.messages.find((m) => m.id === messageId);
        if (!shown) return;
        Object.assign(shown, fields);
        try { ensureMessageEmbeds(shown); } catch { /* embeds are best-effort */ }
        threadService.updateMessageInCache(props.threadId!, messageId, shown);
      },
      save: () => services.messages.editMessage(messageId, content),
    });
  }
  if (props.channelId) return chatStore.editMessage(messageId, content);
  if (props.conversationId) return dmStore.editMessage(messageId, content);
  return Promise.resolve();
};

const editFailureMessage = (error: any): string => {
  if (isModerationRejectionCode(error?.code) && error?.message) return error.message;
  if (classifySendFailure(error) === 'permission') return permissionRefusalMessage(error);
  return t('message.editNotSaved', { reason: error?.message || '' });
};

const saveEdit = async (messageId: string, newContent?: string, retainedFiles: FileContent[] = []) => {
  if (!editableMessageId.value) return;
  const textContent = newContent ?? editableMessageContent.value;
  // Allow saving a message that has no text as long as at least one attachment
  // remains. Only cancel (delete-via-empty is handled elsewhere) when nothing
  // would be left at all.
  if (!textContent.trim() && retainedFiles.length === 0) {
    cancelEdit();
    return;
  }
  // The editor closes at once; the row shows the edit while it is saved.
  cancelEdit();
  try {
    const [userDataMap, emojiDataMap, roleDataMap] = await Promise.all([
      resolveMentionsUserData(textContent),
      resolveEmojisData(textContent),
      resolveRoleMentionsData(textContent, serverChannelStore.currentServerId || undefined),
    ]);
    const parsedContent = await parseContentToMessageParts(textContent, userDataMap, emojiDataMap, {}, roleDataMap, buildChatParseOptions(!!props.conversationId));
    // Re-append the attachments the user kept, so editing text never drops media.
    await saveStoredEdit(messageId, [...parsedContent, ...retainedFiles]);
  } catch (error: any) {
    debug.error('Error saving message edit:', error);
    // The row is back to what the server holds; the attempted text returns to the editor
    // unless another edit is open.
    const message = props.messages.find((m) => m.id === messageId);
    if (message && !editableMessageId.value) {
      startEdit(message);
      editableMessageContent.value = textContent;
    }
    toast.error(editFailureMessage(error));
  }
};

const cancelEdit = () => {
  const id = editableMessageId.value;
  const row = id ? document.getElementById(`message-${id}`) : null;
  const active = document.activeElement;
  const hadFocus = !!row && !!active && row.contains(active);
  editableMessageId.value = null;
  editableMessageContent.value = '';
  const origin = editOrigin;
  editOrigin = null;
  if (!id || !hadFocus) return;
  nextTick(() => {
    if (origin?.isConnected && !origin.closest('.edit-container') && focusElement(origin)) return;
    const el = document.getElementById(`message-${id}`);
    if (el) focusElement(el);
  });
};

const removeAttachment = async (messageId: string, url: string) => {
  const message = props.messages.find((m) => m.id === messageId);
  if (!message || !canEditAttachments(message)) return;

  const newContent = removeFilePartByUrl(message.content, url);
  if (!hasSubstantiveMessageContent(newContent)) {
    try {
      if (props.channelId) {
        await chatStore.deleteMessage(messageId);
      } else if (props.conversationId) {
        await dmStore.deleteMessage(messageId);
      }
    } catch (error) {
      debug.error('Error deleting message after removing last attachment:', error);
    }
    return;
  }

  try {
    await saveStoredEdit(messageId, newContent);
  } catch (error) {
    debug.error('Error removing attachment:', error);
    toast.error(editFailureMessage(error));
  }
};

const editLastOwnMessage = () => {
  const currentProfileId = profileStore.profile?.id;
  if (!currentProfileId) return;

  for (let i = props.messages.length - 1; i >= 0; i--) {
    const msg = props.messages[i];
    if (msg.user_id === currentProfileId && canEditMessage(msg)) {
      startEdit(msg);
      return;
    }
  }
};

/** The row after the message, else the one before: focus lands there once it is deleted. */
const neighborRowKey = (messageId: string): string | null => {
  const items = displayItems.value;
  const index = items.findIndex(item => item.type !== 'blocked-group' && item.message.id === messageId);
  if (index < 0) return null;
  return items[index + 1]?.key ?? items[index - 1]?.key ?? null;
};

const afterDelete = (focusKey: string | null | undefined) => {
  polite(t('messageA11y.deleted'));
  nextTick(() => focusRowKey(focusKey));
};

const deleteMessage = (messageId: string, event?: MouseEvent) => {
  const bypassConfirm = event?.shiftKey === true;
  hoveredMessageId.value = null;
  // An unsent row has no message to delete: an outbox row is discarded, an
  // optimistic copy is left to its insert.
  if (isOptimisticId(messageId)) {
    if (outbox.has(messageId)) outbox.discard(messageId);
    return;
  }
  const thread = getThreadForMessage(messageId);
  const focusAfter = neighborRowKey(messageId);
  const hide = isInstanceHide(props.messages.find((m) => m.id === messageId));
  
  if (thread) {
    deleteConfirmConfig.value = {
      messageId,
      hasThread: true,
      threadName: thread.name || 'this thread',
      focusAfter,
      hide,
    };
    showDeleteConfirmModal.value = true;
  } else if (bypassConfirm) {
    triggerDestructive();
    const removal = props.channelId
      ? chatStore.deleteMessage(messageId)
      : props.conversationId ? dmStore.deleteMessage(messageId) : null;
    void removal?.then(() => afterDelete(focusAfter), () => {});
  } else {
    deleteConfirmConfig.value = {
      messageId,
      hasThread: false,
      threadName: '',
      focusAfter,
      hide,
    };
    showDeleteConfirmModal.value = true;
  }
};

const confirmDeleteMessage = async () => {
  const { messageId, hasThread, focusAfter } = deleteConfirmConfig.value;
  if (outbox.has(messageId)) {
    outbox.discard(messageId);
    showDeleteConfirmModal.value = false;
    return;
  }
  
  // Haptic feedback for destructive action
  triggerDestructive();
  
  if (props.channelId) {
    await chatStore.deleteMessage(messageId);
  } else if (props.conversationId) {
    await dmStore.deleteMessage(messageId);
  }
  
  if (hasThread) {
    threadsStore.removeByParent(messageId);
  }
  
  showDeleteConfirmModal.value = false;
  afterDelete(focusAfter);
};

const cancelDeleteMessage = () => {
  showDeleteConfirmModal.value = false;
  deleteConfirmConfig.value = {
    messageId: '',
    hasThread: false,
    threadName: '',
  };
};

const openEmojiReactor = (message: Message, event: MouseEvent) => {
  emit('toggleEmojiList', true, message, event.currentTarget as HTMLElement);
};

const shakingMessages = ref<Set<string>>(new Set());

const handleToggleReaction = (messageId: string, emoji: Emoji) => {
  if (tooltip.value.visible) hideTooltip();
  
  const message = props.messages.find(m => m.id === messageId);
  if (message && isMessageFromBlockedUser(message)) {
    shakingMessages.value.add(messageId);
    triggerDestructive(); // Haptic feedback
    
    // Remove shake after animation completes
    setTimeout(() => {
      shakingMessages.value.delete(messageId);
    }, 500);
    
    debug.warn('Cannot react to message from blocked user');
    return;
  }
  
  emit('sendReaction', messageId, emoji);
};

const isMessageShaking = (messageId: string): boolean => {
  return shakingMessages.value.has(messageId);
};

const handleOpenEmojiPicker = (messageId: string, event: MouseEvent) => {
  hideTooltip();
  
  const message = props.messages.find(m => m.id === messageId);
  if (!message) return;
  
  emit('toggleEmojiList', true, message, event.currentTarget as HTMLElement);
};

const handleContextMenuReaction = (emoji: { native?: string; name: string; id?: string }) => {
  if (!contextMenuMessage.value) return;
  
  const emojiForReaction: Emoji = {
    id: emoji.id || emoji.native || emoji.name,
    name: emoji.name,
    url: '', // Native emojis don't have URLs
    content: emoji.native || emoji.name
  };
  
  emit('sendReaction', contextMenuMessage.value.id, emojiForReaction);
};

const handleContextMenuEmojiPicker = (position?: { x: number; y: number }) => {
  if (!contextMenuMessage.value) return;

  let anchor: HTMLElement | undefined;
  if (position) {
    anchor = document.createElement('div');
    anchor.style.cssText = `position:fixed;left:${position.x}px;top:${position.y}px;width:1px;height:1px;pointer-events:none;`;
    document.body.appendChild(anchor);
    setTimeout(() => anchor?.remove(), 500);
  }

  emit('toggleEmojiList', true, contextMenuMessage.value, anchor);
};

const handleReportMessage = (message: Message) => {
  const authorId = message.user_id || (message as any).author_id;
  reportTargetUserId.value = authorId;
  reportTargetMessageId.value = message.id;

  let preview = '';
  if (Array.isArray(message.content)) {
    preview = message.content
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join(' ');
  } else if (typeof message.content === 'string') {
    preview = message.content;
  }
  // Also the reporter's evidence for an encrypted message, whose stored content is ciphertext.
  reportTargetMessagePreview.value = preview.slice(0, 4000) || undefined;

  const profile = getUserProfile(authorId);
  const displayName = getUserDisplayName(authorId);
  const avatarUrl = getUserAvatarUrl(authorId);
  reportTargetUser.value = {
    username: profile?.value?.username || displayName?.value || 'Unknown',
    display_name: displayName?.value || undefined,
    avatar_url: avatarUrl?.value || undefined,
    domain: profile?.value?.domain ?? null,
    is_local: profile?.value?.is_local ?? null,
  };
  const server = props.conversationId ? null : serverChannelStore.currentServer;
  reportTargetServer.value = server?.id
    ? { name: server.name, is_local_server: server.is_local_server ?? null, federation_domain: server.federation_domain ?? null }
    : null;

  showReportModal.value = true;
};

const handleHideReportedContent = (_type: 'message' | 'post', id: string) => {
  reportedMessageIds.value.add(id);
  saveReportedMessages();
};

const unreportMessage = (messageId: string) => {
  reportedMessageIds.value.delete(messageId);
  revealedReportedIds.value.delete(messageId);
  saveReportedMessages();
};

// Reply Logic
const replyTo = (message: Message) => {
  emit('replyingTo', message.id);
  hoveredMessageId.value = null;
};

const handleReplyClick = async (replyMessageId: string) => {
  // A thread view's rows are its own; the channel's list is not on screen.
  if (props.threadId) {
    if (!jumpToMessageRow(replyMessageId)) debug.warn(`Reply target is not in this thread: ${replyMessageId}`);
    return;
  }
  if (props.channelId && chatStore.currentChannelId) {
    const success = await chatStore.jumpToMessage(replyMessageId, chatStore.currentChannelId);
    if (!success) debug.warn(`Could not jump to message: ${replyMessageId}`);
  } else if (props.conversationId) {
    const success = await dmStore.jumpToMessage(replyMessageId);
    if (!success) debug.warn(`Could not jump to DM message: ${replyMessageId}`);
  }
};

// Thread Logic
const createThread = (message: Message) => {
  emit('createThread', message);
  hoveredMessageId.value = null;
};

// Size changes from media, embeds and reactions only need the row measured:
// adjustForItemResize holds the content in view when the row is above it, and
// a pinned view is re-seated by handleVirtualizerChange. A second correction
// here would move the view by the same delta again.

// Lightbox and Media
const handleImageLoaded = (url: string) => {
  imageLoaded.value[url] = true;

  nextTick(() => {
    const container = messageDisplayContainer.value;
    if (!container) return;
    container.querySelectorAll('[data-index]').forEach(el => {
      rowVirtualizer.value.measureElement(el as HTMLElement);
    });
  });
};

const handleReactionsLayoutChange = (messageId: string) => {
  remeasureItem(messageId);
};

const handleEmbedLoaded = (messageId: string) => {
  if (!embedLoaded.value[messageId]) {
    embedLoaded.value[messageId] = 0;
  }
  embedLoaded.value[messageId] = (embedLoaded.value[messageId] || 0) + 1;

  remeasureItem(messageId);
};

const handleDecryptMessage = async (message: Message) => {
  debug.log('Attempting to decrypt message on click:', message.id);
  
  try {
    const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService');
    
    if (!megolmMessageEncryptionService.isUnlocked()) {
      debug.log('Encryption not unlocked - cannot decrypt');
      return;
    }
    
    await megolmMessageEncryptionService.claimPendingSessionShares();
    
    // Preserved original ciphertext (not replaced with glyphs) is used
    // directly, with no DB reload.
    const hasOriginalContent = message.encryption_metadata && 
      Array.isArray(message.content) && 
      message.content[0]?.type === 'text' &&
      message.content[0]?.text &&
      /^[A-Za-z0-9+/=]{20,}$/.test(message.content[0].text); // Looks like base64
    
    let messageToDecrypt = message;
    
    if (!hasOriginalContent) {
      // Legacy path: content was replaced with glyphs, so reload from DB.
      debug.log('Content was replaced with glyphs, reloading from database...');
      const { data: freshMessage } = await supabase
        .from('messages')
        .select('*')
        .eq('id', message.id)
        .single();
      
      if (!freshMessage?.encryption_metadata || !freshMessage.encrypted) {
        debug.log('Message has no encryption metadata in database');
        return;
      }
      
      messageToDecrypt = {
        ...message,
        encryption_metadata: freshMessage.encryption_metadata,
        content: freshMessage.content,
        channel_id: freshMessage.channel_id,
        conversation_id: freshMessage.conversation_id
      } as Message;
    }
    
    const roomId = messageToDecrypt.channel_id || messageToDecrypt.conversation_id || props.channelId || props.conversationId || '';
    debug.log('Decrypting with roomId:', roomId);
    
    const messageForDecryption = {
      content: messageToDecrypt.content,
      channel_id: messageToDecrypt.channel_id || props.channelId || '',
      conversation_id: messageToDecrypt.conversation_id || props.conversationId || '',
      encryption_metadata: messageToDecrypt.encryption_metadata
    };
    
    const decryptResult = await megolmMessageEncryptionService.decryptMessage(messageForDecryption);

    // decryptMessage now returns { content, senderVerified } for v2-aware
    // callers. Support the historical bare-array shape too while migrating.
    const decryptedContent: MessagePart[] = Array.isArray(decryptResult)
      ? decryptResult
      : decryptResult.content;
    const senderVerified: boolean | undefined = Array.isArray(decryptResult)
      ? undefined
      : Boolean(decryptResult.senderVerified);

    if (decryptedContent) {
      // NOTE: `resolveMentionsUserData` returns a
      // Record<string, {userId, isLocal}> lookup map, not MessagePart[], so
      // its result must not be assigned to `content`. The decrypted content
      // is already a parsed `MessagePart[]` from
      // `megolmMessageEncryptionService.decryptMessage` and is used as-is.
      const updatedMessage: Message = {
        ...messageToDecrypt,
        content: decryptedContent,
        encrypted: false,
        decrypted: true,
        sender_verified: senderVerified,
      };
      
      if (props.channelId || messageToDecrypt.channel_id) {
        chatStore.updateMessageInCache(messageToDecrypt.id, updatedMessage);
      } else if (props.conversationId || messageToDecrypt.conversation_id) {
        dmStore.updateMessageInCache(messageToDecrypt.id, updatedMessage);
      }
      
      debug.log('Message decrypted successfully on click');

      // Reprocesses other encrypted messages now that the session key is held.
      window.dispatchEvent(new CustomEvent('megolm-key-received', {
        detail: { roomId: messageToDecrypt.channel_id || messageToDecrypt.conversation_id, sessionId: messageToDecrypt.encryption_metadata?.session_id }
      }));
    }
  } catch (error: any) {
    // Surfaces the real reason, distinguishing the common failure modes
    // (missing session key, locked keys, signature mismatch). Without it,
    // clicking the glyph appears to do nothing.
    const reason = error?.message || String(error);
    debug.error('Could not decrypt message:', error);
    try {
      useNotificationStore().showToast(
        'server_update',
        'Could not decrypt message',
        reason,
        6000,
      );
    } catch { /* toast best-effort */ }
  } finally {
    // Tells the glyph component the attempt settled so its spinner stops.
    // A fixed 5s timeout alone leaves the lock spinning after a fast failure
    // has already shown the error toast.
    window.dispatchEvent(new CustomEvent('harmony-decrypt-finished', {
      detail: { messageId: message.id },
    }));
  }
};

// Context menu handlers. `trigger` is where focus returns when the menu closes
// from the keyboard: the More button, or the row.
const contextMenuTrigger = ref<HTMLElement | null>(null);

const showContextMenu = (message: Message, x: number, y: number, trigger: HTMLElement | null) => {
  // Haptic feedback for context menu
  triggerInteraction();

  // On mobile the (...) button in the floating toolbar opens this menu. The
  // toolbar stays pinned ~48px above the original tap point, where it clashes
  // and z-stacks with the menu. Dismissing it leaves one surface, rooted at
  // the tap.
  if (isMobile.value) {
    hoveredMessageId.value = null;
    mobileActionTapPosition.value = null;
  }

  contextMenuMessage.value = message;
  contextMenuPosition.value = { x, y };
  contextMenuTrigger.value = trigger;
  contextMenuVisible.value = true;
};

const openContextMenu = (message: Message, event: MouseEvent) => {
  event.preventDefault();
  event.stopPropagation();
  // Every menu action acts on the message's id, which an unsent row lacks.
  if (isOptimisticId(message.id)) return;
  const trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  // A keyboard click on the More button carries no pointer position: a click with detail 0.
  // A pointer contextmenu also reports detail 0 in Chromium, with the pointer's coordinates;
  // only a contextmenu at (0, 0) came from the keyboard.
  const fromKeyboard = event.type === 'click'
    ? event.detail === 0
    : event.clientX === 0 && event.clientY === 0;
  if (fromKeyboard && trigger) {
    const box = styleRect(trigger);
    showContextMenu(message, box.left, box.bottom + 4, trigger);
    return;
  }
  const point = stylePoint(event);
  showContextMenu(message, point.x, point.y, trigger);
};

// Native right-click on a message row opens the same context menu as the
// "more" button. The browser's native menu takes over for media (images,
// video, audio) and links so "Save image as", "Copy link address", etc.
// remain available.
const handleMessageContextMenu = (message: Message, event: MouseEvent) => {
  // On mobile the OS fires a synthetic `contextmenu` after a long-press.
  // Long-press is already handled by the touchstart timer, which shows the
  // floating message-actions toolbar, so the full context menu on top of it
  // produces two competing surfaces. The synthetic event is swallowed and
  // only the toolbar shows; the (...) button opens the full menu.
  // Exception: selected text and native media/link targets keep the
  // browser/OS copy menu.
  if (isMobile.value && !shouldAllowNativeContextMenu(event)) {
    event.preventDefault();
    return;
  }
  // The browser's own menu stays available on an unsent row.
  if (shouldAllowNativeContextMenu(event) || isOptimisticId(message.id)) {
    return;
  }
  openContextMenu(message, event);
};

const closeContextMenu = () => {
  contextMenuVisible.value = false;
  contextMenuMessage.value = null;
  contextMenuTrigger.value = null;
};

const reactionUserResolvers: ReactionUserResolvers = {
  displayName: (userId) => getUserDisplayName(userId).value,
  avatarUrl: (userId) => getUserAvatarUrl(userId).value,
  color: resolveChatUserColor,
  handle: (userId) => formatUserHandle(getUser(userId).value),
  bot: (botId) => {
    const bot = botDataCache.value.get(botId);
    if (!bot) return null;
    return {
      displayName: bot.display_name || bot.username,
      avatarUrl: bot.avatar_url || '/default_avatar.webp',
      username: bot.username,
    };
  },
  preload: (actors: ReactionActor[]) => {
    const profileIds = reactionProfileIds(actors);
    if (profileIds.length > 0) {
      ensureProfilesAvailable(profileIds).catch(error =>
        debug.error('Error ensuring profiles for reactions list:', error)
      );
    }
    for (const actor of actors) {
      if (actor.bot_id && !actor.user_id && !actor.metadata?.discord_user) void fetchBotData(actor.bot_id);
    }
  },
};

/** emojiKey is a reactionGroupKey; null opens the first tab. */
const reactionsModal = ref<{ messageId: string; emojiKey: string | null } | null>(null);

const openReactionsModal = (messageId: string, emojiKey: string | null) => {
  if (isOptimisticId(messageId)) return;
  hideTooltip();
  if (isMobile.value) {
    hoveredMessageId.value = null;
    mobileActionTapPosition.value = null;
  }
  reactionsModal.value = { messageId, emojiKey };
};

const closeReactionsModal = () => {
  reactionsModal.value = null;
};

// The list closes first: UserProfileModal is a BaseModal at the same z-index
// whose teleport mounts earlier, so it would paint beneath the list. The
// profile opens after the unmount flush, which resets BaseModal's body overflow.
const handleReactionUserSelect = async (user: ReactionUser) => {
  closeReactionsModal();
  await nextTick();
  if (user.kind === 'discord' && user.discordUser) {
    const meta = user.discordUser;
    const cached = findBridgedUserInCache(props.channelId, meta.id);
    selectedUser.value = bridgedUserToProfileUser(
      cached ?? discordMetadataToBridgedUser({ ...meta, username: meta.username || meta.id }),
    ) as User;
    showProfileModal.value = true;
    return;
  }
  if (user.kind === 'bot') {
    const bot = botDataCache.value.get(user.id);
    selectedBot.value = {
      id: user.id,
      username: bot?.username,
      displayName: user.displayName,
      avatarUrl: bot?.avatar_url || undefined,
    };
    return;
  }
  if (user.id) void showUserProfile(user.id);
};


// Modals (User Profile, Invite)
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const resolveNonUuidProfile = async (userId: string): Promise<any | null> => {
  const unresolvedMatch = userId.match(/^unresolved-([^@]+)@(.+)$/);
  if (unresolvedMatch) {
    const [, username, domain] = unresolvedMatch;
    const { data } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, banner_url, bio, color, status, domain, created_at, is_local')
      .eq('username', username)
      .eq('domain', domain)
      .maybeSingle();
    if (data) {
      await fetchUserProfile(data.id).catch(() => null);
      return getUserProfile(data.id).value || data;
    }
  }
  // Handles plain "@user@domain" / "user@domain" / "@user" from chat
  // mentions. Routes through activityPubService so unseen federated users are
  // fetched from their origin instance.
  const handleMatch = userId.match(/^@?([^@\s]+)(?:@([^\s]+))?$/);
  if (
    handleMatch
    && !userId.startsWith('http')
    && !userId.startsWith('unresolved-')
    && !UUID_PATTERN.test(userId)
  ) {
    try {
      const { activityPubService } = await import('@/services/activityPubService');
      const federated = await activityPubService.getUserByHandle(userId);
      if (federated?.id) {
        await fetchUserProfile(federated.id).catch(() => null);
        return getUserProfile(federated.id).value || federated;
      }
    } catch (e) {
      debug.warn('Failed to resolve federated mention by handle:', userId, e);
    }
  }
  if (userId.startsWith('http')) {
    try {
      const url = new URL(userId);
      const domain = url.hostname;
      const pathParts = url.pathname.split('/').filter(Boolean);
      const username = pathParts[pathParts.length - 1];
      if (username) {
        const { data } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url, banner_url, bio, color, status, domain, created_at, is_local')
          .eq('username', username)
          .eq('domain', domain)
          .maybeSingle();
        if (data) {
          await fetchUserProfile(data.id).catch(() => null);
          return getUserProfile(data.id).value || data;
        }
      }
    } catch { /* invalid URL, ignore */ }
  }
  return null;
};

const handleAuthorClick = (message: Message, event?: MouseEvent) => {
  event?.stopPropagation();
  if (hasDiscordUserMetadata(message) && message.metadata?.discord_user) {
    const meta = message.metadata.discord_user;
    const cached = props.channelId ? findBridgedUserInCache(props.channelId, meta.id) : null;
    selectedUser.value = bridgedUserToProfileUser(
      cached ?? discordMetadataToBridgedUser(meta),
    ) as User;
    showProfileModal.value = true;
    return;
  }
  // A webhook's backing bot has no profile to show.
  if (getWebhookAuthor(message)) return;
  if (message.bot_id) {
    const bot = botDataCache.value.get(message.bot_id);
    selectedBot.value = {
      id: message.bot_id,
      username: bot?.username,
      displayName: bot?.display_name || bot?.username,
      avatarUrl: bot?.avatar_url || undefined,
    };
    return;
  }
  const authorId = getMessageAuthorId(message);
  if (authorId) {
    void showUserProfile(authorId, event);
  }
};

const showUserProfile = async (userId: string | null | undefined, event?: MouseEvent) => {
  event?.stopPropagation();
  if (!userId) return;

  if (userId.startsWith(BRIDGED_DISCORD_USER_ID_PREFIX)) {
    const discordId = userId.slice(BRIDGED_DISCORD_USER_ID_PREFIX.length)
    let cached = findBridgedUserInCache(props.channelId, discordId)
    if (!cached && props.channelId) {
      const result = await fetchBridgedChannelUsers(props.channelId, { force: true })
      cached = result.users.find(u => u.id === discordId) ?? null
    }
    selectedUser.value = bridgedUserToProfileUser(
      cached ?? discordMetadataToBridgedUser({ id: discordId, username: discordId }),
    ) as User
    showProfileModal.value = true
    return
  }

  let user: any = null;
  if (UUID_PATTERN.test(userId)) {
    user = getUserProfile(userId).value || await fetchUserProfile(userId).catch(e => debug.error(e));
  } else {
    user = await resolveNonUuidProfile(userId);
  }
  
  if (user) {
    selectedUser.value = user;
    showProfileModal.value = true;
  } else {
    debug.error("Failed to fetch user profile for ID:", userId);
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

defineExpose({ editLastOwnMessage });
</script>

<style scoped>
/* Modern message display styles */
.message-display {
  flex: 1;
  overflow-y: auto;
  margin-right: 4px;
  padding: 20px 0 10px 0;
  min-height: 0; /* Important for flex child with overflow */
  contain: layout paint;
}

/* Individual message item */
.message-item {
  position: relative;
  padding: 0.125rem 16px;
  transition: background-color 0.1s ease-out;
}

/* Add margin to message-item only if its child .message-group has a header */
.message-item > .message-group.has-header ~ .message-group,
.message-item > .message-group.has-header {
  /* no-op: ensure specificity for selector ordering */
}
.message-item:has(> .message-group.has-header) {
  margin-top: 0.5rem;
}

.message-item.is-sending {
  opacity: 0.6;
  transition: opacity 0.2s ease;
}

.message-item.is-failed {
  opacity: 0.8;
  border-left: 3px solid var(--error);
}

.failed-message-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-danger);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--error) 8%, transparent);
}

.failed-message-bar svg {
  flex-shrink: 0;
}

.failed-message-bar .retry-btn,
.failed-message-bar .discard-btn {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 3px;
  transition: background 0.15s ease;
}

.failed-message-bar .retry-btn {
  color: var(--text-primary);
  background: var(--background-modifier-hover);
}

.failed-message-bar .retry-btn:hover {
  background: var(--background-modifier-active);
}

.failed-message-bar .discard-btn {
  color: var(--text-secondary);
}

.failed-message-bar .discard-btn:hover {
  color: var(--text-danger);
  background: color-mix(in srgb, var(--error) 15%, transparent);
}

.message-item:hover {
  background-color: var(--background-modifier-hover);
}

.message-item:focus {
  outline: none;
}

.message-item:focus-visible,
.blocked-message-group:focus-visible,
.reported-message-group:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
  background-color: var(--background-modifier-hover);
}

/* --mention-highlight: the warning colour unless the theme or a skin sets one. */
.message-item.mentions-me {
  background-color: color-mix(in srgb, var(--mention-highlight, var(--warning)) 10%, transparent);
  box-shadow: inset 2px 0 0 var(--mention-highlight, var(--warning));
}

.message-item.mentions-me:hover {
  background-color: color-mix(in srgb, var(--mention-highlight, var(--warning)) 15%, transparent);
}

/* On the warning tint: the muted timestamp drops to 3.9:1 (midnight) and the brand-blue mention
   pill to 3.6:1. The pill text lightens instead; the brand blue itself is unchanged. Paper paints
   mentions on its yellow marker with ink and keeps its own colour. */
.message-item.mentions-me .timestamp {
  color: var(--text-secondary);
}

:root[data-theme-type="dark"]:not([data-skin="paper"]) .message-item.mentions-me :deep(.mention) {
  color: color-mix(in srgb, var(--harmony-primary) 75%, #fff);
}

/* Message group - contains header and/or content */
.message-group {
  display: flex;
  flex-direction: column;
  position: relative;
}


/* Message header with avatar + username + timestamp */
.message-header {
  display: flex;
  /* align-items: center; */
  gap: 16px;
}

.message-avatar {
  flex-shrink: 0;
  display: flex;
}

.message-main {
  flex: 1;
  min-width: 0;
}

.message-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  line-height: 1.375rem;
}

.username {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  text-align: inherit;
  cursor: pointer;
}

.username:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
  border-radius: 2px;
}

.username-text {
  font-weight: 500;
  font-size: 1rem;
  cursor: pointer;
  transition: text-decoration 0.1s ease;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.username :deep(.bridged-source-icon),
.username :deep(.bridge-source-badge) {
  margin-left: 6px;
  vertical-align: middle;
}
/* 
.username-text .display-name::v-deep(span) {
  transition: color 0.2s ease, border-bottom 0.2s ease;
}

.username-text:hover .display-name::v-deep(span) {
  border-bottom: 1px solid;
} */

.bot-badge {
  display: inline-block;
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
  font-size: 0.625rem;
  font-weight: 600;
  padding: 0.125rem 0.25rem;
  border-radius: 0.1875rem;
  vertical-align: middle;
  margin-left: 0.25rem;
}

/* Discord blurple - official brand color */
.bot-badge.discord {
  background: #5865F2;
  color: #ffffff;
}

.instance-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.15rem;
  font-size: 0.625rem;
  font-weight: 600;
  padding: 0.125rem 0.3rem;
  border-radius: 0.1875rem;
  vertical-align: middle;
  margin-left: 0.25rem;
  text-decoration: none;
  position: relative;
  top: -1px;
}

.instance-badge.admin,
.instance-badge.mod {
  color: color-mix(in srgb, var(--text-secondary) 30%, transparent);
  transition: all 0.2s ease;
}

.instance-badge:hover.admin, 
.instance-badge:hover.mod {
  color: var(--text-primary);
  background:  var(--harmony-secondary);
}

.timestamp {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  font-weight: 400;
}

.edited-indicator {
  font-size: 0.65rem;
  color: var(--text-muted);
  font-style: italic;
  margin-left: 0.25rem;
  opacity: 0.8;
  cursor: help;
  transition: opacity 0.2s;
}

.edited-indicator:hover {
  opacity: 1;
}

/* The edit shows while it is saved. */
.edited-indicator.edit-pending {
  opacity: 0.5;
}

/* Inline variant appears after message content */
.edited-indicator.inline,
.edited-indicator.compact {
  display: inline;
  margin-left: 0.35rem;
  vertical-align: baseline;
  line-height: 1.375;
}

/* Pin indicator */
.pin-indicator {
  margin-left: 0.35rem;
  font-size: 0.75rem;
  opacity: 0.8;
  cursor: help;
}

/* Thread action button */
.thread-btn {
  color: var(--text-link);
}

/* Compact message (no header) */
.message-content-only {
  display: flex;
  align-items: flex-start;
  min-height: 1.375rem;
}

.message-gutter {
  width: 56px; /* 40px avatar + 16px gap = 56px to align with header messages */
  flex-shrink: 0;
  position: relative;
  height: 1.375rem; /* Match line height */
}

/* Compact rows show their time on hover or keyboard focus; screen readers
   read its full text at all times. */
.message-gutter-time {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  line-height: 1.375rem;
  text-align: center;
  font-size: 0.6875rem;
  color: var(--text-muted);
  font-weight: 500;
  opacity: 0;
}

.message-content-only:hover .message-gutter-time,
.message-item:focus-within .message-gutter-time {
  opacity: 1;
}

/* Message actions */
.message-actions {
  position: absolute;
  top: -16px;
  right: 0;
  display: flex;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--background-floating);
  box-shadow: var(--shadow-medium);
  z-index: 1;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--text-secondary);
  transition: all 0.15s ease-out;
  border-radius: 4px;
  margin: 2px;
}

.action-btn:hover {
  background-color: var(--harmony-primary-alpha);
  color: var(--text-primary);
}

.action-btn:active {
  background-color: var(--background-tertiary-alpha);
  transform: scale(0.95);
}

.action-btn:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
}

.action-btn.delete-danger {
  color: var(--text-danger)!important;
  background-color: color-mix(in srgb, var(--error) 50%, transparent)!important;
}

.action-btn.delete-danger:hover {
  background-color: color-mix(in srgb, var(--error-hover) 50%, transparent)!important;
  color: var(--error-hover)!important;
}

/* Date separator */
.date-separator {
  display: flex;
  align-items: center;
  margin: 24px 16px 16px 16px;
  color: var(--text-muted);
  font-size: 0.875rem;
  font-weight: 600;
  /* text-transform: uppercase; */
  letter-spacing: 0.02em;
}

.date-separator-line {
  flex: 1;
  height: 1px;
  /* background-color: var(--background-quinary); */
  background-color: var(--border-color);
}

.date-separator-text {
  padding: 0 16px;
  /* background-color: var(--background-secondary); */
  /* color: var(--text-secondary); */
  color: var(--text-secondary);
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
}

/* "New messages" divider */
.new-messages-divider {
  display: flex;
  align-items: center;
  margin: 8px 16px;
  pointer-events: none;
  user-select: none;
}

.new-messages-label {
  flex-shrink: 0;
  padding: 1px 10px;
  border-radius: 0 8px 8px 0;
  /* White on --harmony-secondary #38bdf8 is 2.1:1; on the brand fill, the accepted 2.77:1. */
  background-color: var(--harmony-primary-fill);
  color: var(--text-on-primary);
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  line-height: 1.6;
}

.new-messages-line {
  flex: 1;
  height: 1px;
  background: var(--harmony-primary-fill);
}

/* Highlighted message */
.highlighted {
  background-color: color-mix(in srgb, var(--harmony-primary) 15%, transparent) !important;
  border-left: 3px solid var(--harmony-primary);
  animation: highlight-fade 3s ease-out;
}

/* Search text highlight */
.search-highlight {
  background-color: var(--warning);
  color: var(--text-inverse);
  padding: 2px 4px;
  border-radius: var(--radius-sm);
  font-weight: 600;
}

@keyframes highlight-fade {
  0% {
    background-color: hsl(34, 100%, 50%, 0.3);
  }
  100% {
    background-color: hsl(34, 100%, 50%, 0.1);
  }
}

/* No messages state */
.no-messages {
  height: 100%;
}

/* Loading skeletons */
.loading-skeleton {
  padding: 16px;
}

.skeleton-message {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
}

.skeleton-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
}

.skeleton-content {
  flex: 1;
}

.skeleton-header {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.skeleton-username {
  width: 80px;
  height: 16px;
  border-radius: 4px;
}

.skeleton-timestamp {
  width: 50px;
  height: 12px;
  border-radius: 4px;
}

.skeleton-text-line {
  height: 14px;
  border-radius: 4px;
  margin-bottom: 6px;
}

.skeleton-avatar,
.skeleton-username,
.skeleton-timestamp,
.skeleton-text-line {
  background-color: var(--background-quaternary);
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.04) 50%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.8s ease-in-out infinite;
}

@keyframes skeleton-shimmer {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: -100% 0;
  }
}

/* Responsive design */
@media (max-width: 768px) {
  /* The composer's typing tab overlaps the list's bottom edge by its height. */
  .message-display {
    padding-bottom: 30px;
  }

  .message-item {
    padding: 0 8px 0 12px;
  }
  
  .message-header {
    gap: 12px;
  }
  
  .message-gutter {
    width: 52px;
  }
  
  .reactions-gutter {
    width: 42px;
  }
  
  .date-separator {
    margin: 20px 12px 12px 12px;
  }
  
  .date-separator-text {
    padding: 0 12px;
  }
  
  .message-meta {
    flex-wrap: nowrap;
    min-width: 0;
  }

  .username {
    min-width: 0;
    overflow: hidden;
  }

  .username-text {
    /* inline-flex ignores text-overflow. */
    display: inline-block;
    vertical-align: bottom;
    max-width: calc(40 * var(--app-vw));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .instance-badge {
    font-size: 0;
    padding: 0.15rem;
    gap: 0;
  }
  .instance-badge svg {
    width: 10px;
    height: 10px;
  }
}

/* System Messages (Join/Leave Announcements) */
.system-message {
  padding: 0 16px 0 0;
}

.system-message-content {
  display: flex;
  align-items: center;
  flex-direction: row;
  margin: 8px 0;
}

.system-content {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background-color: var(--background-quaternary);
  border-left: 4px solid var(--harmony-primary);
  border-radius: 0 4px 4px 0;
  margin-left: 4px;
  font-size: 0.875rem;
  width: 100%;
  color: var(--text-secondary);
}



.system-timestamp {
  font-size: 0.65rem;
  color: var(--text-muted);
  flex-shrink: 0;
}

/* System message responsiveness */
@media (max-width: 768px) {
  .system-content {
    padding: 6px 12px;
    gap: 6px;
    font-size: 0.8125rem;
  }
  
  .system-timestamp {
    font-size: 0.6875rem;
  }
}

/* Sending indicator - inline with message content */
.sending-indicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 6px;
  opacity: 0.5;
  vertical-align: text-bottom;
  line-height: 1;
}

.spinner-icon {
  width: 14px;
  height: 14px;
  color: var(--text-secondary);
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* Loading older messages indicator at top */
.top-sentinel {
  height: 1px;
  width: 100%;
  pointer-events: none;
}

/* Zero-height sticky box, as .jump-present-anchor: the bar adds nothing to
   scrollHeight, so the distance to the end of the list is the rows' alone. */
.history-bar-anchor {
  position: sticky;
  bottom: 0;
  height: 0;
  z-index: 3;
}

.history-bar {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 36px;
  padding: 4px 4px 4px 14px;
  border-radius: var(--radius-md);
  background-color: var(--harmony-secondary);
  color: var(--text-on-primary);
  font-size: 0.8125rem;
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.history-bar-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-bar-jump {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.history-bar-jump:hover {
  background-color: color-mix(in srgb, currentColor 15%, transparent);
}

.history-bar-jump:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

/* 44 px touch target. */
@media (max-width: 768px) {
  .history-bar {
    left: 12px;
    right: 12px;
  }

  .history-bar-jump {
    min-height: 44px;
  }
}

/* Zero-height sticky box at the end of the list: the control floats over the
   bottom edge of the viewport without adding to scrollHeight, so it rides
   above the composer as that grows. */
.jump-present-anchor {
  position: sticky;
  bottom: 0;
  height: 0;
  z-index: 2;
}

.jump-present {
  position: absolute;
  right: 16px;
  bottom: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--background-floating);
  color: var(--text-primary);
  cursor: pointer;
  box-shadow: var(--shadow-medium);
}

.jump-present.has-count {
  width: auto;
  height: 32px;
  padding: 0 14px;
  border: none;
  background-color: var(--harmony-secondary);
  color: var(--text-on-primary);
  font-size: 0.8125rem;
  font-weight: 600;
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.jump-present:hover {
  filter: brightness(1.1);
}

.jump-present:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

/* 44 px touch target, inside the thumb's reach at the right edge. */
@media (max-width: 768px) {
  .jump-present {
    right: 12px;
    width: 44px;
    height: 44px;
  }

  .jump-present.has-count {
    height: 36px;
  }
}

/* Zero-height sticky wrapper, as .loading-older-anchor: toggling it moves no row. */
.unread-bar-anchor {
  position: sticky;
  top: 0;
  height: 0;
  z-index: 3;
}

.unread-bar {
  position: absolute;
  /* The sticky anchor rests below .message-display's 20px top padding; the bar sits on the edge. */
  top: -20px;
  left: 8px;
  right: 8px;
  display: flex;
  align-items: stretch;
  border-radius: 0 0 8px 8px;
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
  font-size: 0.8125rem;
  font-weight: 600;
  overflow: hidden;
}

.unread-bar button {
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  padding: 6px 12px;
}

.unread-bar-jump {
  flex: 1;
  text-align: left;
}

.unread-bar-dismiss {
  flex: none;
  border-left: 1px solid color-mix(in srgb, currentColor 30%, transparent);
}

.unread-bar button:hover {
  background: color-mix(in srgb, currentColor 12%, transparent);
}

.unread-bar button:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: -4px;
}

/* An in-flow row here shifts the list by its height whenever it toggles and
   native scroll anchoring does not compensate. */
.loading-older-anchor {
  position: sticky;
  top: 0;
  height: 0;
  z-index: 2;
}

.loading-older-messages {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 6px 14px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--background-floating);
  box-shadow: var(--shadow-medium);
  white-space: nowrap;
  box-sizing: border-box;
  color: var(--text-secondary);
  font-size: 13px;
  /* Match the spinner's box so the text baseline isn't pulled down by
     line-height descender space inside the flex track. Centering on a
     uniform line-height makes both children share the same visual axis. */
  line-height: 16px;
}

.loading-older-messages > span {
  line-height: 16px;
  display: inline-flex;
  align-items: center;
}

/* Encryption indicators */
.encryption-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  margin-left: 6px;
  vertical-align: middle;
  cursor: help;
  transition: all 0.2s ease;
  position: relative;
  top: -1px;
}

.encryption-dot.decrypted {
  background-color: var(--success);
  opacity: 0.5;
}

.encryption-dot.decrypted:hover {
  opacity: 1;
}

.encryption-indicator.locked {
  display: inline-block;
  font-size: 0.7em;
  margin-left: 4px;
  color: var(--text-danger);
  opacity: 0.7;
  cursor: help;
  transition: opacity 0.2s ease;
  vertical-align: middle;
  position: relative;
  top: -1px;
}

.encryption-indicator.locked:hover {
  opacity: 1;
}

/* Permanently unrecoverable: key predates current identity. Muted; the
   tooltip explains. */
.encryption-indicator.locked.unrecoverable {
  color: var(--text-muted);
  opacity: 0.6;
}

.encryption-indicator.locked.unrecoverable:hover {
  opacity: 0.9;
}

/* Reported message placeholder */
.reported-message-group {
  padding: 8px 16px;
  margin: 4px 0;
}

.reported-group-content {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  color: var(--text-muted);
  font-size: 0.875rem;
}

.reported-icon {
  color: var(--text-danger);
}

.reported-text {
  color: var(--text-muted);
  font-style: italic;
}

.unreport-btn {
  color: var(--text-secondary) !important;
}

.reported-banner {
  border-left-color: var(--error);
}

/* Blocked message styles */
/* Discord-like blocked message group */
.blocked-message-group {
  padding: 8px 16px;
  margin: 4px 0;
}

.blocked-group-content {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  color: var(--text-muted);
  font-size: 0.875rem;
}

.blocked-separator {
  color: var(--text-muted);
  opacity: 0.5;
}

.blocked-message {
  padding: 8px 16px;
  margin: 4px 0;
}

.blocked-message-content {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--background-secondary);
  border-radius: 8px;
  border-left: 3px solid var(--text-muted);
}

/* Revealed blocked messages indicator banner */
.revealed-blocked-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  margin-bottom: 4px;
  background: color-mix(in srgb, var(--error) 10%, transparent);
  border-radius: var(--radius-sm);
  border-left: 3px solid var(--error);
}

.revealed-blocked {
  border-left: 2px solid var(--error);
  background: color-mix(in srgb, var(--error) 5%, transparent);
}

.blocked-icon {
  opacity: 0.6;
}

.blocked-text {
  color: var(--text-muted);
  font-size: 0.875rem;
  font-style: italic;
}

.reveal-btn {
  margin-left: auto;
  padding: 4px 12px;
  font-size: 0.75rem;
  background: transparent;
  border: 1px solid var(--text-muted);
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s ease;
}

.reveal-btn:hover {
  background: var(--background-modifier-hover);
  border-color: var(--text-primary);
  color: var(--text-primary);
}

.revealed-blocked-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 16px;
  margin-bottom: 4px;
}

.blocked-warning {
  font-size: 0.75rem;
  color: var(--warning);
  opacity: 0.8;
}

.hide-btn {
  padding: 2px 8px;
  font-size: 0.7rem;
  background: transparent;
  border: 1px solid var(--text-muted);
  border-radius: 3px;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s ease;
}

.hide-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

/* Shake animation for blocked reaction attempts (like Discord) */
@keyframes shake-reject {
  0%, 100% { transform: translateX(0); }
  10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
  20%, 40%, 60%, 80% { transform: translateX(4px); }
}

.shake-reject {
  background-color: color-mix(in srgb, var(--error) 10%, transparent) !important;
}

@media (prefers-reduced-motion: no-preference) {
  .shake-reject,
  .shake-reject .message-reactions,
  .shake-reject .reaction {
    animation: shake-reject 0.5s ease-in-out;
  }
}
</style>