<template>
  <div
    class="message-display"
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
    
    <div class="no-messages" v-else-if="!isLoading && messages.length === 0">
      {{ $t('message.noMessagesHere') }}
    </div>
    <!-- Sentinel for auto-loading older messages when the top is visible -->
    <div ref="topSentinelRef" class="top-sentinel"></div>

    <!-- Loading older messages indicator (v-show to avoid layout shifts) -->
    <div v-show="isLoadingOlderMessages && messages.length > 0" class="loading-older-messages">
      <LoadingSpinner :size="16" />
      <span>{{ $t('message.loadingOlder') }}</span>
    </div>
    
    <!-- Virtual scrolled message list -->
    <div v-if="displayItems.length > 0" :style="{ height: `${totalSize}px`, width: '100%', position: 'relative' }">
      <div
        v-for="virtualRow in virtualRows"
        :key="displayItems[virtualRow.index].key"
        :data-index="virtualRow.index"
        :ref="measureElement"
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
      <div v-if="item.type === 'blocked-group'" class="blocked-message-group">
        <div class="blocked-group-content">
          <span class="blocked-icon">🚫</span>
          <span class="blocked-text">{{ item.count }} blocked message{{ item.count > 1 ? 's' : '' }}</span>
          <span class="blocked-separator">-</span>
          <button class="reveal-btn" @click="revealBlockedGroup(item.groupId)">
            Show message{{ item.count > 1 ? 's' : '' }}
          </button>
        </div>
      </div>
      
      <!-- Reported Message Placeholder -->
      <div v-else-if="item.type === 'reported'" class="reported-message-group">
        <div class="reported-group-content">
          <span class="reported-icon">&#9873;</span>
          <span class="reported-text">You reported this message</span>
          <span class="blocked-separator">-</span>
          <button class="reveal-btn" @click="revealedReportedIds.add(item.message.id)">Show</button>
          <button class="reveal-btn unreport-btn" @click="unreportMessage(item.message.id)">Unhide</button>
        </div>
      </div>

      <!-- Regular Message or Revealed Blocked Message -->
      <template v-else-if="item.type === 'message'">
        <!-- Beginning of conversation indicator (only show when all messages loaded) -->
        <div v-if="item.index === 0 && hasScrollbar && isAllMessagesLoaded" class="beginning-indicator" :style="getIndicatorStyle()">
          <div class="beginning-content">
            <div class="beginning-icon">🌟</div>
            <div class="beginning-text">
              <div class="beginning-title">{{ $t('message.conversationBeginning') }}</div>
              <div class="beginning-subtitle">{{ $t('message.conversationBeginningSubtitle') }}</div>
            </div>
          </div>
        </div>

        <!-- Date separator -->
        <div v-if="shouldShowDateSeparator(item.message, item.index)" class="date-separator">
          <div class="date-separator-line"></div>
          <span class="date-separator-text">{{ formatDateSeparator(item.message.created_at) }}</span>
          <div class="date-separator-line"></div>
        </div>

        <!-- "New messages" divider: pinned above the first unread message on open -->
        <div v-if="item.message.id === dividerBeforeMessageId" class="new-messages-divider">
          <span class="new-messages-label">{{ $t('message.newMessages') }}</span>
          <div class="new-messages-line"></div>
        </div>

        <div 
          :id="`message-${item.message.id}`" 
          :data-message-id="item.message.id"
          class="message-item" 
          :class="{ 
            'shake-reject': isMessageShaking(item.message.id),
            'revealed-blocked': item.isRevealed,
            'is-sending': !item.message.failed && (item.message.sending || (item.message.id?.startsWith('temp-') && !item.message.failed)),
            'is-failed': item.message.failed
          }"
          @mouseover="handleMessageMouseover(item.message.id)" 
          @mouseleave="handleMessageMouseleave"
          @click="clearDividerIfMessageRead(item.message)"
          @dblclick="handleMessageDoubleClick(item.message.id, $event)"
          @touchstart.passive="handleMessageTouchStart(item.message.id, $event)"
          @touchend.passive="handleMessageTouchEnd(item.message.id)"
          @touchmove.passive="handleMessageTouchMove"
          @contextmenu="handleMessageContextMenu(item.message, $event)"
        >
          <!-- Hide button for revealed blocked messages -->
          <div v-if="item.isRevealed && item.isFirstInRevealedGroup" class="revealed-blocked-banner">
            <span class="blocked-warning">⚠️ {{ item.revealedCount ?? 1 }} message{{ (item.revealedCount ?? 1) > 1 ? 's' : '' }} from blocked user</span>
            <button class="hide-btn" @click="item.groupId && hideBlockedGroup(item.groupId)">Hide</button>
          </div>
          <!-- Banner for temporarily revealed reported message -->
          <div v-if="revealedReportedIds.has(item.message?.id)" class="revealed-blocked-banner reported-banner">
            <span class="blocked-warning">Reported message</span>
            <button class="hide-btn" @click="revealedReportedIds.delete(item.message.id)">Hide again</button>
          </div>
          
          <!-- Gap indicator for jumped-to messages -->
          <div v-if="chatStore.messageGaps.has(`gap-before-${item.message.id}`)" class="message-gap">
            <div class="gap-line"></div>
            <div class="gap-text">{{ $t('message.jumpInConversation') }}</div>
            <div class="gap-line"></div>
          </div>

          <!-- System Message (join/leave announcements, thread creation) -->
          <div v-if="item.message.is_system" class="system-message">
            <div class="system-message-content">
              <div class="system-timestamp" v-html="formatSystemTimestamp(item.message.created_at)"></div>
              <div class="system-content">
                <!-- Thread created system message -->
                <template v-if="item.message.metadata?.type === 'thread_created'">
                  <div class="system-icon">🧵</div>
                  <div class="system-text thread-created-text">
                    <span 
                      class="system-user-mention"
                      @click="showUserProfile(item.message.user_id)"
                      :style="{ color: resolveChatUserColor(item.message.user_id) }"
                    ><DisplayName :userId="item.message.user_id" /></span>
                    started a thread: 
                    <span 
                      class="system-thread-link"
                      @click="handleOpenThread(item.message.metadata?.thread_id)"
                    >{{ item.message.metadata?.thread_name || 'Thread' }}</span>. 
                    See 
                    <span 
                      class="system-threads-link"
                      @click="emit('showAllThreads')"
                    >all threads</span>.
                  </div>
                </template>
                <!-- Call system message (started / ended) -->
                <template v-else-if="item.message.metadata?.type === 'call_started' || item.message.metadata?.type === 'call_ended'">
                  <div class="system-icon call-icon-container">
                    <svg viewBox="0 0 24 24" width="18" height="18" class="call-system-icon" :class="{ active: item.message.metadata?.type === 'call_started' }">
                      <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56-.35-.12-.74-.03-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z" fill="currentColor"/>
                    </svg>
                  </div>
                  <div class="system-text call-system-text">
                    <span 
                      class="system-user-mention"
                      @click="showUserProfile(item.message.user_id)"
                      :style="{ color: resolveChatUserColor(item.message.user_id) }"
                    ><DisplayName :userId="item.message.user_id" /></span>
                    <template v-if="item.message.metadata?.type === 'call_ended'">
                      started a {{ item.message.metadata?.call_type || 'voice' }} call that lasted
                      <span class="call-duration">
                        {{ formatCallDuration(item.message.metadata?.duration_seconds || 0) }}
                      </span>
                    </template>
                    <template v-else>
                      started a {{ item.message.metadata?.call_type || 'voice' }} call
                      <button class="call-join-btn" @click="joinCallFromSystemMessage(item.message)">
                        Join Call
                      </button>
                    </template>
                  </div>
                </template>
                <!-- Group created / users added system message (DM) -->
                <template v-else-if="item.message.metadata?.type === 'group_created'">
                  <div class="system-icon">👥</div>
                  <div class="system-text">
                    <UnifiedMessageContent 
                      :content="item.message.content"
                      :message-id="item.message.id"
                      :is-system="true"
                      @show-user-profile="showUserProfile"
                    />
                  </div>
                </template>
                <!-- Member join system message -->
                <template v-else-if="item.message.metadata?.type === 'member_join'">
                  <div class="system-icon">👋</div>
                  <div class="system-text">
                    <span 
                      class="system-user-mention"
                      @click="showUserProfile(item.message.user_id)"
                      :style="{ color: resolveChatUserColor(item.message.user_id) }"
                    ><DisplayName :userId="item.message.user_id" /></span>
                    has joined the server
                  </div>
                </template>
                <!-- Member leave system message -->
                <template v-else-if="item.message.metadata?.type === 'member_leave'">
                  <div class="system-icon">🚪</div>
                  <div class="system-text">
                    <span 
                      class="system-user-mention"
                      @click="showUserProfile(item.message.user_id)"
                      :style="{ color: resolveChatUserColor(item.message.user_id) }"
                    ><DisplayName :userId="item.message.user_id" /></span>
                    has left the server
                  </div>
                </template>
                <!-- Member kick system message -->
                <template v-else-if="item.message.metadata?.type === 'member_kick'">
                  <div class="system-icon">🚪</div>
                  <div class="system-text">
                    <span
                      class="system-user-mention"
                      @click="showUserProfile(item.message.user_id)"
                      :style="{ color: resolveChatUserColor(item.message.user_id) }"
                    >{{ getUserDisplayName(item.message.user_id).value }}</span>
                    was kicked<template v-if="item.message.metadata?.kicked_by"> by
                    <span
                      class="system-user-mention"
                      @click="showUserProfile(item.message.metadata.kicked_by)"
                      :style="{ color: resolveChatUserColor(item.message.metadata.kicked_by) }"
                    ><DisplayName :userId="item.message.metadata.kicked_by" /></span></template><template v-if="item.message.metadata?.reason"> - {{ item.message.metadata.reason }}</template>
                  </div>
                </template>
                <!-- Member ban system message -->
                <template v-else-if="item.message.metadata?.type === 'member_ban'">
                  <div class="system-icon">🔨</div>
                  <div class="system-text">
                    <span
                      class="system-user-mention"
                      @click="showUserProfile(item.message.user_id)"
                      :style="{ color: resolveChatUserColor(item.message.user_id) }"
                    ><DisplayName :userId="item.message.user_id" /></span>
                    was banned<template v-if="item.message.metadata?.banned_by"> by
                    <span
                      class="system-user-mention"
                      @click="showUserProfile(item.message.metadata.banned_by)"
                      :style="{ color: resolveChatUserColor(item.message.metadata.banned_by) }"
                    ><DisplayName :userId="item.message.metadata.banned_by" /></span></template><template v-if="item.message.metadata?.reason"> - {{ item.message.metadata.reason }}</template>
                  </div>
                </template>
                <!-- Default system message -->
                <template v-else>
                  <div class="system-icon">👋</div>
                  <div class="system-text">
                    <UnifiedMessageContent 
                      :content="item.message.content"
                      :message-id="item.message.id"
                      :is-system="true"
                      :embed-payloads="item.message.metadata?.embeds"
                      @show-user-profile="showUserProfile"
                    />
                  </div>
                </template>
              </div>
            </div>
            
            <!-- Message actions for system messages (if hovered); on mobile with tap use floating popup -->
            <div class="message-actions" v-if="hoveredMessageId === item.message.id && !(isMobile && mobileActionTapPosition)">
              <div class="action-btn" @click="openEmojiReactor(item.message, $event)"><ReactionIcon/></div>
              <div class="action-btn" :class="{ 'delete-danger': isShiftHeld }" v-if="canDeleteMessage(item.message)" @click="deleteMessage(item.message.id, $event)"><DeleteIcon/></div>
              <div class="action-btn" @click="openContextMenu(item.message, $event)"><MoreIcon/></div>
            </div>
            
            <!-- Reactions for system messages -->
            <MessageReactions
              :message="item.message"
              @show-reaction-tooltip="showTooltip"
              @hide-reaction-tooltip="hideTooltip"
              @open-emoji-picker="handleOpenEmojiPicker"
              @layout-change="handleReactionsLayoutChange"
            />
          </div>

          <!-- Regular Message Content -->
          <template v-else>
            <!-- Reply reference -->
            <MessageReplyReference
              v-if="item.message.reply_to"
              :reply-to-message-id="item.message.reply_to"
              :channel-id="channelId"
              :conversation-id="conversationId"
              :server-id="coloringServerId"
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
              <span class="username" :style="{color: getAuthorColor(item.message).value}" @click="handleAuthorClick(item.message, $event)">
                <span class="username-text"><DisplayName v-if="item.message.user_id && !item.message.bot_id && !hasDiscordUserMetadata(item.message)" :user-id="item.message.user_id" /><template v-else>{{ getAuthorDisplayName(item.message).value }}</template></span>
                <BridgeSourceBadge v-if="hasDiscordUserMetadata(item.message)" source="discord" />
                <span v-else-if="isMessageFromBot(item.message)" class="bot-badge">BOT</span>
                <span v-if="getInstanceBadge(item.message).value === 'admin'" class="instance-badge admin" title="Instance Admin">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
                  ADMIN
                </span>
                <span v-else-if="getInstanceBadge(item.message).value === 'mod'" class="instance-badge mod" title="Instance Moderator">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
                  MOD
                </span>
                <SupporterBadge v-if="getMessageAuthorId(item.message)" :user-id="getMessageAuthorId(item.message)!" />
              </span>
              <span class="timestamp" :title="formatFullTimestamp(item.message.created_at)">
                {{ formatTimestamp(item.message.created_at) }}
                <!-- Pin indicator -->
                <span 
                  v-if="item.message.is_pinned" 
                  class="pin-indicator"
                  title="Pinned message"
                >📌</span>
                <!-- Encryption indicators -->
                <span
                  v-if="item.message.decrypted"
                  class="encryption-dot decrypted"
                  :title="'End-to-end encrypted'"
                ></span>
                <span
                  v-else-if="item.message.encrypted"
                  class="encryption-indicator locked"
                  :class="{ unrecoverable: item.message.decryption_unrecoverable }"
                  :title="encryptionLockTooltip(item.message)"
                >🔒</span>
              </span>
            </div>
            <UnifiedMessageContent 
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
              @image-loaded="handleImageLoaded"
              @embed-loaded="handleEmbedLoaded(item.message.id)"
              @open-lightbox="handleOpenLightbox"
              @update:message="saveEdit"
              @update:content="editableMessageContent = $event"
              @cancel-edit="cancelEdit"
              @remove-attachment="removeAttachment"
              @show-user-profile="showUserProfile"
              @decrypt-message="handleDecryptMessage(item.message)"
            />
            <!-- Edited indicator for messages with headers -->
            <span 
              v-if="isMessageEdited(item.message)" 
              class="edited-indicator inline"
              :title="item.message.updated_at ? `Edited at ${formatTimestamp(item.message.updated_at)}` : 'Edited'"
            >(edited)</span>
          </div>
        </div>
        
        <!-- Compact message (no header, just content aligned with previous messages) -->
        <div v-else class="message-content-only">
          <div class="message-gutter" :data-timestamp="formatTimeOnly(item.message.created_at)" :title="formatFullTimestamp(item.message.created_at)"></div>
          <div class="message-main">
            <UnifiedMessageContent 
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
              @image-loaded="handleImageLoaded"
              @embed-loaded="handleEmbedLoaded(item.message.id)"
              @open-lightbox="handleOpenLightbox"
              @update:message="saveEdit"
              @update:content="editableMessageContent = $event"
              @cancel-edit="cancelEdit"
              @remove-attachment="removeAttachment"
              @show-user-profile="showUserProfile"
              @decrypt-message="handleDecryptMessage(item.message)"
            />
            <!-- Edited indicator for compact messages -->
            <span 
              v-if="isMessageEdited(item.message)" 
              class="edited-indicator compact"
              :title="item.message.updated_at ? `Edited at ${formatTimestamp(item.message.updated_at)}` : 'Edited'"
            >(edited)</span>
          </div>
        </div>
        
        <!-- Failed message indicator with retry/discard -->
        <div v-if="item.message.failed" class="failed-message-bar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
          <span>Failed to send</span>
          <button class="retry-btn" @click="$emit('retry-message', item.message)">Retry</button>
          <button class="discard-btn" @click="$emit('discard-message', item.message)">Delete</button>
        </div>

        <!-- Message actions; on mobile with tap use floating popup -->
        <div class="message-actions" v-if="!item.message.failed && hoveredMessageId === item.message.id && !(isMobile && mobileActionTapPosition)">
          <div ref="reactionBtn" class="action-btn" data-testid="msg-action-react" @click="openEmojiReactor(item.message, $event)"><ReactionIcon/></div>
          <div class="action-btn" data-testid="msg-action-reply" @click="replyTo(item.message)"><ReplyIcon/></div>
          <div class="action-btn thread-btn" data-testid="msg-action-thread" v-if="!props.hideThreadActions" @click="createThread(item.message)" title="Create Thread"><ThreadIcon/></div>
          <div class="action-btn" data-testid="msg-action-edit" v-if="canEditMessage(item.message)" @click="startEdit(item.message)"><EditIcon/></div>
          <div class="action-btn" data-testid="msg-action-delete" :class="{ 'delete-danger': isShiftHeld }" v-if="canDeleteMessage(item.message)" @click="deleteMessage(item.message.id, $event)"><DeleteIcon/></div>
          <div class="action-btn" data-testid="msg-action-more" @click="openContextMenu(item.message, $event)"><MoreIcon/></div>
        </div>
        
        <!-- Reactions -->
        <MessageReactions
          :message="item.message"
          @show-reaction-tooltip="showTooltip"
          @hide-reaction-tooltip="hideTooltip"
          @open-emoji-picker="handleOpenEmojiPicker"
          @layout-change="handleReactionsLayoutChange"
        />
        
          <!-- Thread Indicator (if this message started a thread) - hidden in thread view -->
          <ThreadIndicator
            v-if="!props.hideThreadActions && getThreadForMessage(item.message.id)"
            :thread="getThreadForMessage(item.message.id)"
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
  </div>
  
  <vue-easy-lightbox
    teleport="body"
    :visible="isLightboxOpen"
    :imgs="activeLightboxImages"
    :index="indexRef"
    @hide="closeLightbox"
  />
  <LightboxDownloadButton
    :visible="isLightboxOpen"
    :url="activeLightboxImages[indexRef] ?? ''"
  />

  <!-- Modern User Profile Modal -->
  <UserProfileModal
    :show="showProfileModal"
    :user="selectedUser"
    @close="closeProfile"
    @invite="openInviteModal"
    @mention="(username: string) => { emit('mentionUser', username); closeProfile(); }"
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

  <!-- Mobile: message-actions floating above tap (thumb reach ~48px) -->
  <MessageFloatingActions
    v-if="isMobile && hoveredMessageId && mobileActionTapPosition && hoveredMessageItem"
    :message="hoveredMessageItem.message"
    :style="floatingActionsStyle"
    :hide-thread-actions="props.hideThreadActions"
    :is-shift-held="isShiftHeld"
    :can-edit="canEditMessage(hoveredMessageItem.message)"
    :can-delete="canDeleteMessage(hoveredMessageItem.message)"
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
    :message="contextMenuMessage"
    :server-id="serverChannelStore.currentServerId ?? undefined"
    :channel-id="props.channelId"
    :thread-id="props.threadId"
    :conversation-id="props.conversationId"
    :current-user-id="props.currentUserId"
    :hide-thread-actions="props.hideThreadActions"
    :can-edit="contextMenuMessage ? canEditMessage(contextMenuMessage) : false"
    :can-delete="contextMenuMessage ? canDeleteMessage(contextMenuMessage) : false"
    @close="closeContextMenu"
    @add-reaction="handleContextMenuReaction"
    @open-emoji-picker="handleContextMenuEmojiPicker"
    @report="handleReportMessage"
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
    @close="showReportModal = false"
    @hide="handleHideReportedContent"
  />

  <!-- Delete Message Confirmation Modal -->
  <ConfirmationModal
    :show="showDeleteConfirmModal"
    title="Delete Message"
    :message="deleteConfirmConfig.hasThread ? `This message has a thread attached: '${deleteConfirmConfig.threadName}'` : 'Are you sure you want to delete this message? This action cannot be undone.'"
    :secondary-message="deleteConfirmConfig.hasThread ? 'Deleting this message will permanently delete the thread and all its replies.' : undefined"
    :confirm-button-text="deleteConfirmConfig.hasThread ? 'Delete Message & Thread' : 'Delete'"
    @close="cancelDeleteMessage"
    @confirm="confirmDeleteMessage"
  />
</template>

<script setup lang="ts">
defineOptions({ inheritAttrs: false })
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { debug } from '@/utils/debug'
import type { PropType, Ref, ComputedRef } from 'vue';
import type { Message, MessagePart, User, Emoji, Reaction, FileContent } from '@/types';
import { hasSubstantiveMessageContent, removeFilePartByUrl } from '@/utils/messageContentUtils';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useChatStore } from '@/stores/useChat';
import { useDMStore } from '@/stores/useDM';
import { useAuthStore } from '@/stores/auth';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { showInstanceStaffBadge } from '@/utils/instanceBadge';
import { useServerRolesStore } from '@/stores/useServerRoles';
import { useProfileStore } from '@/stores/useProfile';
import { useNotificationStore } from '@/stores/useNotification';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { supabase } from '@/supabase'; 
import { throttle } from '@/utils/throttle';
import { getReactionTooltipAnchor } from '@/utils/reactionTooltipPosition';
import { useServerPermissions } from '@/composables/useServerPermissions';
import { useUserData } from '@/composables/useUserData';
import { useHapticSettings } from '@/composables/useHapticSettings';
import { useQuickReactSettings } from '@/composables/useQuickReactSettings';
import { useLayoutState } from '@/composables/useLayoutState';
import { useUnreadCounts } from '@/composables/useUnreadCounts';
import { useReadDivider } from '@/composables/useReadDivider';
import { format, isToday, isYesterday, isSameDay, isValid } from 'date-fns';
import UserProfileModal from '@/components/UserProfileModal.vue';
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
import ReactionTooltip from '@/components/messages/ReactionTooltip.vue';
import BridgeSourceBadge from '@/components/messages/BridgeSourceBadge.vue';
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
import LightboxDownloadButton from '@/components/common/LightboxDownloadButton.vue';
import { shouldAllowNativeContextMenu } from '@/utils/nativeContextMenu';
import ReportModal from '@/components/moderation/ReportModal.vue';
import SupporterBadge from '@/components/common/SupporterBadge.vue';
import { fundingService } from '@/services/FundingService';
import ThreadIndicator from '@/components/threads/ThreadIndicator.vue';
import ConfirmationModal from '@/components/ConfirmationModal.vue';
import MessageFloatingActions from '@/components/messages/MessageFloatingActions.vue';
import MessageReplyReference from '@/components/messages/MessageReplyReference.vue';
import { threadService } from '@/services/ThreadService';
import type { ThreadWithDetails } from '@/services/ThreadService';
import { messagePartsToMarkdown, isSingleEmojiMessage as checkSingleEmoji, stripLeadingSelfMention } from '@/utils/messageContentUtils';
import { parseContentToMessageParts, resolveMentionsUserData, resolveEmojisData, resolveRoleMentionsData } from '@/utils/unifiedContentProcessing';
import { buildChatParseOptions } from '@/utils/chatParseOptions';
import { useReactionsStore } from '@/stores/useReactions';
import { usePostReactionsStore } from '@/stores/postReactions';
import { useVirtualizer } from '@tanstack/vue-virtual';

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
const serverUsersStore = useServerUsersStore();
const serverChannelStore = useServerChannelStore();
const serverRolesStore = useServerRolesStore();

// Server whose role colors are currently applied to the rendered messages.
// This is deliberately decoupled from `serverChannelStore.currentServerId`:
// on a server switch, `currentServerId` flips synchronously while the old
// server's messages are still on screen, which would briefly repaint those
// names with the new server's role lookup (-> usually a fallback to profile
// color = the visible "color flash"). Instead we only advance
// `coloringServerId` once the new channel's messages have actually rendered
// (see the initial-load block in the message watcher), by which point the
// new server's roles have been requested below.
const coloringServerId = ref<string | null>(serverChannelStore.currentServerId);

// Ensure role data is loaded for the current server so message author colors
// reflect their highest colored role (Discord behavior). DMs and contexts
// without a server fall back to user.color via `getUserColor` below.
watch(
  () => serverChannelStore.currentServerId,
  (serverId) => {
    if (serverId) serverRolesStore.ensureServerLoaded(serverId)
  },
  { immediate: true },
);

/**
 * Resolve a chat-author's display color, preferring their highest-position
 * colored role within the server the rendered messages belong to. Falls back
 * to the user's profile color (and ultimately the default in `getUserColor`).
 *
 * `coloringServerId` is null for DMs and ActivityPub contexts, in which case
 * there's no role to look up and we fall through to the profile color.
 */
const resolveChatUserColor = (userId: string | null | undefined): string => {
  if (!userId) return '#ffffff';
  const serverId = coloringServerId.value;
  const roleColor = serverId ? serverRolesStore.getUserRoleColor(serverId, userId) : null;
  return roleColor || getUserColor(userId).value;
};

// "New messages" divider state. The boundary is snapshotted at open (before the
// context is marked read) and resolved once messages render; see useReadDivider.
const { getUnreadCount } = useUnreadCounts();
const { dividerBeforeMessageId, captureBoundary, resolveDivider, clear: clearReadDivider } = useReadDivider();

/**
 * Retire the "New messages" divider when the user clicks a message at or after
 * it - that's an explicit "I've read past this" signal. Scrolling alone never
 * clears it (that would defeat the purpose), and clicking an older message
 * above the divider leaves it in place.
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
  // Divider disabled for this context (e.g. threads) - never capture a boundary
  // so resolveDivider has nothing to place and no "NEW" line can appear.
  if (!props.enableReadDivider) {
    captureBoundary(null);
    return;
  }
  const ctx = currentUnreadContext();
  captureBoundary(ctx ? getUnreadCount(ctx) : null);
};
const chatStore = useChatStore();
const dmStore = useDMStore();
const authStore = useAuthStore();
const profileStore = useProfileStore();
const activityPubStore = useActivityPubStore();
const reactionsStore = useReactionsStore();
const postReactionsStore = usePostReactionsStore();

const isShiftHeld = ref(false);
const onShiftDown = (e: KeyboardEvent) => { if (e.key === 'Shift') isShiftHeld.value = true; };
const onShiftUp = (e: KeyboardEvent) => { if (e.key === 'Shift') isShiftHeld.value = false; };

// Track which blocked message groups the user has chosen to reveal (by first message ID in group)
const revealedBlockedGroups = ref<Set<string>>(new Set());

// Force reactivity counter - increment when blocked users change
// This is updated by watching the store's blockedUsers size
const blockCheckVersion = ref(0);

// Reactive computed that tracks the blocked users count for change detection
const blockedUsersCount = computed(() => activityPubStore.blockedUsers.size);

// Watch for changes to blocked users count and force re-evaluation
watch(blockedUsersCount, (newCount, _oldCount) => {
  blockCheckVersion.value++;
  debug.log('🔄 Blocked users changed, forcing re-render. Count:', newCount);
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
  
  // Use the store getter for reliable reactive access
  const isBlocked = activityPubStore.isBlocked(authorId);
  
  // Debug: log check for first few messages (debug helper short-circuits on
  // its own when debug logging is disabled - no `isEnabled` flag needed).
  if (props.messages.indexOf(message) < 3) {
    debug.log(`🔍 Block check: author=${authorId}, blocked=${isBlocked}, blockedUsers size=${activityPubStore.blockedUsers.size}`);
  }
  
  return isBlocked;
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
  
  // Don't forget the last blocked group
  if (currentBlockedGroup) {
    result.push({
      type: 'blocked-group',
      group: currentBlockedGroup,
      index: result.length
    });
  }
  
  return result;
});

// Check if a blocked group has been revealed
// eslint-disable-next-line unused-imports/no-unused-vars
const isBlockedGroupRevealed = (firstMessageId: string): boolean => {
  return revealedBlockedGroups.value.has(firstMessageId);
};

// Reveal a blocked message group
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

// Get messages in a revealed blocked group
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

const THUMB_REACH_PX = 48;
const floatingActionsStyle = computed((): Record<string, string> => {
  const pos = mobileActionTapPosition.value;
  if (!pos || typeof window === 'undefined') return {};
  const bottomPx = Math.max(8, window.innerHeight - pos.y + THUMB_REACH_PX);
  const popupWidth = 220;
  const leftPx = Math.max(popupWidth / 2, Math.min(pos.x, window.innerWidth - popupWidth / 2));
  return {
    left: `${leftPx}px`,
    bottom: `${bottomPx}px`,
    transform: 'translateX(-50%)',
  };
});
const { isCurrentUserServerOwner, canManageMessages } = useServerPermissions();
const { triggerInteraction, triggerDestructive } = useHapticSettings();
const quickReact = useQuickReactSettings();
const { isMobile } = useLayoutState();
const { 
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

// Thread data cache - map message ID -> thread data
const threadsByMessageId = ref<Map<string, ThreadWithDetails>>(new Map());
const loadingThreads = ref(false);

const loadChannelThreads = async () => {
  if (!props.channelId) {
    threadsByMessageId.value.clear();
    return;
  }
  
  loadingThreads.value = true;
  try {
    const threads = await threadService.getThreadsForChannel(props.channelId);
    threadsByMessageId.value.clear();
    threads.forEach(thread => {
      if (thread.parent_message_id) {
        threadsByMessageId.value.set(thread.parent_message_id, thread);
      }
    });
  } catch (error) {
    debug.error('Failed to load threads:', error);
  } finally {
    loadingThreads.value = false;
  }
};

const getThreadForMessage = (messageId: string): ThreadWithDetails | undefined => {
  return threadsByMessageId.value.get(messageId);
};

// Open a thread (accepts the lighter `ThreadData` shape emitted by
// `<ThreadIndicator>` as well as the full `ThreadWithDetails` from
// `threadService`; we just forward it to the parent via emit).
const openThread = (thread: unknown) => {
  emit('createThread', { thread } as any);
};

const handleOpenThread = async (threadId?: string) => {
  if (!threadId) return;
  
  try {
    const thread = await threadService.getThread(threadId);
    if (thread) {
      emit('createThread', { thread } as any);
    }
  } catch (error) {
    debug.error('Failed to open thread:', error);
  }
};

// Encryption capability check (cached - only updates when service state changes)
const canDecryptMessages = ref(false);

const handleThreadBroadcast = () => {
  loadChannelThreads();
};

// Re-check unlock state whenever the encryption service signals progress.
// The mount-time check races the service's lazy init/auto-unlock: on a
// direct page load into a DM this component mounts BEFORE auto-unlock
// completes, cached `false`, and click-to-decrypt never enabled (while
// navigating chat -> DM happened to work because encryption was already
// unlocked by then). `megolm-key-received` fires on auto-unlock, manual
// unlock, and every received key.
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
  window.addEventListener('server-structure:thread-change', handleThreadBroadcast);
  // Bot owners can change avatar/display_name in settings; UserBotsManagement
  // fires `bot:updated` after a successful save so we can refresh the in-memory
  // cache instead of waiting for a full re-render.
  window.addEventListener('bot:updated', handleBotUpdated as EventListener);
});

watch(() => props.channelId, () => {
  loadChannelThreads();
});

const handleBotUpdated = (event: CustomEvent) => {
  const updated = event.detail as { id: string; display_name?: string | null; avatar_url?: string | null; bio?: string | null } | null
  if (!updated?.id) return
  const existing = botDataCache.value.get(updated.id)
  // Merge so we keep any fields the event doesn't carry (e.g. username).
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

// Helper function to get author ID from message (handles both users and bots)
const getMessageAuthorId = (message: Message): string | null => {
  return message.user_id || message.bot_id || null;
};

// Helper function to check if message is from a bot
const isMessageFromBot = (message: Message): boolean => {
  return !!message.bot_id;
};

// Helper function to check if message is from Discord bridge (has Discord user metadata)
const hasDiscordUserMetadata = (message: Message): boolean => {
  const hasMetadata = !!message.metadata?.discord_user;
  return hasMetadata;
};

// Helper function to get Discord user info from metadata
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
// eslint-disable-next-line unused-imports/no-unused-vars
const getBotDisplayName = (botId: string): ComputedRef<string> => {
  return computed(() => {
    if (!botDataCache.value.has(botId) && !fetchingBots.value.has(botId)) {
      fetchBotData(botId);
    }
    
    const bot = botDataCache.value.get(botId);
    return bot?.display_name || bot?.username || `Bot-${botId.slice(0, 8)}`;
  });
};

// eslint-disable-next-line unused-imports/no-unused-vars
const getBotAvatarUrl = (botId: string): ComputedRef<string> => {
  return computed(() => {
    const bot = botDataCache.value.get(botId);
    return bot?.avatar_url || '/default_avatar.webp';
  });
};

// eslint-disable-next-line unused-imports/no-unused-vars
const getBotColor = (_botId: string): ComputedRef<string> => {
  return computed(() => '#0EA5E9'); // Discord bot color
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
    
    // Regular bot
    if (message.bot_id) {
      return '#0EA5E9';
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

// --- REFS ---
const messageDisplayContainer = ref<HTMLDivElement | null>(null);
const topSentinelRef = ref<HTMLDivElement | null>(null);
const imageLoaded: Ref<Record<string, boolean>> = ref({});
const embedLoaded: Ref<Record<string, number>> = ref({}); // Track embed load count per message
const tooltip = ref({
  visible: false,
  content: [] as {
    id: string
    displayName: string
    avatarUrl: string
    userColor: string
    isBridged?: boolean
    bridgeSource?: string
  }[],
  x: 0,
  y: 0,
  emoji: null as Emoji | null,
});
const tooltipTimer: Ref<NodeJS.Timeout | null> = ref(null);
const editableMessageId = ref<string | null>(null);
const editableMessageContent = ref('');
const hoveredMessageId = ref<string | null>(null);
const longPressTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const LONG_PRESS_DURATION = 500;
/** On mobile: tap position for positioning message-actions above the finger (thumb reach ~48px) */
const mobileActionTapPosition = ref<{ x: number; y: number } | null>(null);

const handleMessageMouseover = (messageId: string) => {
  if (!isMobile.value) {
    hoveredMessageId.value = messageId;
  }
};

const handleMessageMouseleave = () => {
  if (!isMobile.value) {
    hoveredMessageId.value = null;
  }
};

const handleMessageTouchStart = (messageId: string, event: TouchEvent) => {
  const touch = event.touches[0];
  const tapPos = touch ? { x: touch.clientX, y: touch.clientY } : null;
  longPressTimer.value = setTimeout(() => {
    hoveredMessageId.value = messageId;
    mobileActionTapPosition.value = tapPos;
    triggerInteraction();
  }, LONG_PRESS_DURATION);
};

// Double-tap (mobile) detection. Window is shorter than LONG_PRESS_DURATION so
// two quick taps never trigger the long-press action bar.
const DOUBLE_TAP_WINDOW = 300;
const lastTap = ref<{ id: string; time: number } | null>(null);

const handleMessageTouchEnd = (messageId: string) => {
  if (longPressTimer.value) {
    clearTimeout(longPressTimer.value);
    longPressTimer.value = null;
  }
  // Skip double-tap if the long-press action bar is already showing.
  if (hoveredMessageId.value === messageId && mobileActionTapPosition.value) return;

  const now = Date.now();
  if (lastTap.value && lastTap.value.id === messageId && now - lastTap.value.time < DOUBLE_TAP_WINDOW) {
    lastTap.value = null;
    triggerQuickReact(messageId);
    return;
  }
  lastTap.value = { id: messageId, time: now };
};

const handleMessageTouchMove = () => {
  if (longPressTimer.value) {
    clearTimeout(longPressTimer.value);
    longPressTimer.value = null;
  }
};

// Desktop double-click to quick-react. Clears the accidental text selection
// that a double-click would otherwise leave behind.
const handleMessageDoubleClick = (messageId: string, event: MouseEvent) => {
  // Don't hijack double-clicks on interactive content (links, media, code).
  const target = event.target as HTMLElement | null;
  if (target?.closest('a, button, img, video, input, textarea, [contenteditable="true"]')) return;
  window.getSelection?.()?.removeAllRanges();
  triggerQuickReact(messageId);
};

const triggerQuickReact = (messageId: string) => {
  if (!quickReact.enabled.value) return;
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
const bufferDistance = ref(0);
const selectedUser = ref<User | null>(null);
const showProfileModal = ref(false);
const showInviteModal = ref(false);

const showDeleteConfirmModal = ref(false);
const deleteConfirmConfig = ref({
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
const reportTargetUser = ref<{ username: string; display_name?: string; avatar_url?: string } | undefined>();

const isLightboxOpen = ref(false);
const indexRef = ref(0);
const activeLightboxImages = ref<string[]>([]);

// --- CONSTANTS ---
const BUFFER_THRESHOLD = 15; // pixels needed to trigger buffer effect

// --- VIRTUAL SCROLLING ---
// Track the initial offset separately so it doesn't change on prepend
const frozenInitialOffset = ref(0);
let hasSetInitialOffset = false;

const rowVirtualizer = useVirtualizer<HTMLDivElement, Element>(
  computed(() => ({
    count: displayItems.value.length,
    getScrollElement: () => messageDisplayContainer.value,
    estimateSize: () => 60,
    overscan: 15,
    initialOffset: frozenInitialOffset.value,
    // Stable per-item keys. Without this the measurement cache is keyed by
    // INDEX: prepending a history page shifts every row's index, so each row
    // inherits a stale height from the row previously at that index. The
    // cascade of corrective re-measurements as rows re-render is what made
    // the viewport visibly bounce while loading history. With stable keys,
    // existing measurements survive the prepend and only the genuinely new
    // rows measure in (and the virtualizer's built-in scroll adjustment
    // compensates for those above the viewport).
    getItemKey: (index: number) => displayItems.value[index]?.key ?? index,
  })) as any
);

const virtualRows = computed(() => rowVirtualizer.value.getVirtualItems());
const totalSize = computed(() => rowVirtualizer.value.getTotalSize());

const measureElement = (el: any) => {
  if (!el || !(el instanceof HTMLElement)) return;
  rowVirtualizer.value.measureElement(el);
};

const remeasureItem = (messageId: string) => {
  const container = messageDisplayContainer.value;
  if (!container) return;
  const el = container.querySelector(`[data-message-id="${messageId}"]`)?.closest('[data-index]') as HTMLElement | null;
  if (el) rowVirtualizer.value.measureElement(el);
};

// --- COMPUTED PROPERTIES ---
const lightboxImages = computed(() => {
  let urls: Array<string> = [];
  if (!props.messages || !Array.isArray(props.messages)) {
    return urls;
  }
  
  props.messages.forEach(message => {
    if (!message?.content || !Array.isArray(message.content)) {
      return;
    }
    
    message.content.forEach(part => {
      if (!part || typeof part !== 'object') {
        return;
      }
      
      if (part.type === 'file' && part.fileType === 'image' && part.url) {
        urls.push(part.url);
      }
      else if (part.type === 'url' && part.url && (part.url.endsWith('.jpg') || part.url.endsWith('.png') || part.url.endsWith('.webp'))) {
        urls.push(part.url);
      }
    });
  });
  return urls;
});

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

const shouldBeAtBottom = ref(false);

// Track if user was at bottom before last messages update (for scroll-on-new-message)
const userWasAtBottom = ref(true);

// Independent tracking of message count and first ID, because deep watchers on reactive
// arrays receive the same reference for old/new values (in-place .push() mutations).
const lastKnownMessageCount = ref(0);
const lastKnownFirstMessageId = ref<string | null>(null);
const lastKnownDisplayItemCount = ref(0);

// --- WATCHERS ---
let hasInitiallyScrolled = false;
// Just after a context opens we scroll to the bottom, but late-arriving
// messages (the stale-while-revalidate catch-up fetch, or a realtime insert)
// land a beat later. During this grace window we keep following the bottom so
// the user ends up at the true end of the conversation rather than floating
// above the messages that arrived while they were away. Suppressed when a NEW
// divider is shown (then we intentionally rest at the divider instead).
let openFollowBottomUntil = 0;

watch([() => props.channelId, () => props.conversationId], () => {
  hasInitiallyScrolled = false;
  hasSetInitialOffset = false;
  userWasAtBottom.value = true;
  lastKnownMessageCount.value = 0;
  lastKnownFirstMessageId.value = null;
  lastKnownDisplayItemCount.value = 0;
  // Snapshot the read boundary for the newly-opened context now, before the
  // scroll observer / open-handlers mark it read. Resolved once messages load.
  captureReadBoundary();
});

watch(() => props.messages, (newMessages) => {
  if (!newMessages || !Array.isArray(newMessages)) {
    return;
  }

  const prevCount = lastKnownMessageCount.value;
  const prevFirstId = lastKnownFirstMessageId.value;
  const prevDisplayItemCount = lastKnownDisplayItemCount.value;
  lastKnownMessageCount.value = newMessages.length;
  lastKnownFirstMessageId.value = newMessages[0]?.id ?? null;

  // Retire the "New messages" divider as soon as the current user sends a
  // message in this context. This is an append (front unchanged) whose tail
  // contains an own message; sending implies they've seen everything above, so
  // the divider must never linger (the screenshot bug where "NEW" stayed put
  // after the viewer replied).
  if (
    dividerBeforeMessageId.value &&
    newMessages.length > prevCount &&
    prevFirstId !== null &&
    newMessages[0]?.id === prevFirstId
  ) {
    for (let i = prevCount; i < newMessages.length; i++) {
      if (newMessages[i]?.user_id === props.currentUserId) {
        clearReadDivider();
        break;
      }
    }
  }

  const oldScrollHeight = messageDisplayContainer.value?.scrollHeight ?? 0;
  // Snapshot scrollTop alongside scrollHeight so the prepend handler below can
  // pin the viewport by height-delta (see the "Load older messages (prepend)"
  // branch). Reading from the DOM here, BEFORE Vue patches in the new rows,
  // gives us the exact pre-prepend offset.
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
        if (part && typeof part === 'object' && 'url' in part && part.url && !(part.url in imageLoaded.value)) {
          if ((part.type === 'file' && part.fileType === 'image') || (part.type === 'url' && (part.url.endsWith('.jpg') || part.url.endsWith('.png') || part.url.endsWith('.webp')))) {
            imageLoaded.value[part.url] = false;
          }
        }
      });
    }
  });

  if (userIds.size > 0) {
    const userIdArray = Array.from(userIds);
    setTimeout(() => {
      ensureProfilesAvailable(userIdArray).catch(error => {
        debug.error('Error ensuring user profiles are available:', error);
      });
      // Batch-prefetch supporter badges to avoid N+1 RPC calls
      fundingService.prefetchBadges(userIdArray).catch(() => {});
    }, 0);
  }

  // Batch fetch reactions for all messages (avoid N+1 queries)
  if (newMessages.length > 0) {
    const realMessageIds = newMessages
      .filter(msg => !msg.id.startsWith('temp-') && !msg.sending)
      .map(msg => msg.id);
    
    if (realMessageIds.length > 0) {
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
        if (embed?.provider === 'harmony-post' && embed.harmony?.postId) {
          embedPostIds.add(embed.harmony.postId);
        }
      });
    });
    if (embedPostIds.size > 0) {
      postReactionsStore.fetchMultiplePostReactions(Array.from(embedPostIds)).catch(() => {});
    }
  }

  if (newMessages.length > 0) {
    nextTick(() => {
      if (messageDisplayContainer.value) {
        // If this is the initial load, scroll to bottom
        if (!hasInitiallyScrolled && newMessages.length > 0) {
          hasInitiallyScrolled = true;
          // The new context's messages are now on screen; advance the coloring
          // server so author names resolve against this server's roles. Doing it
          // here (rather than on currentServerId change) prevents the previous
          // server's messages from being briefly repainted during the switch.
          coloringServerId.value = serverChannelStore.currentServerId;

          // Resolve the "New messages" divider against the freshly-loaded set.
          const dividerMsgId = resolveDivider(newMessages, props.currentUserId);
          const dividerIndex = dividerMsgId
            ? displayItems.value.findIndex(it => it.type === 'message' && it.message.id === dividerMsgId)
            : -1;
          const hasDivider = dividerIndex >= 0;

          // Freeze the initial offset for this channel. When there's a divider we
          // seed the offset near it (instead of the bottom) so the virtualizer
          // starts close to its final resting place - minimal visible motion.
          if (!hasSetInitialOffset) {
            hasSetInitialOffset = true;
            frozenInitialOffset.value = (hasDivider ? dividerIndex : displayItems.value.length) * 60;
          }
          debug.log(hasDivider ? '📜 Initial load - scrolling to NEW divider' : '📜 Initial load - scrolling to bottom');

          // When landing on a divider we are NOT at the bottom; don't let the
          // image-load handler yank the view down.
          shouldBeAtBottom.value = !hasDivider;

          // No divider => we're heading to the bottom. Keep following any
          // messages that arrive in the next couple seconds (revalidate
          // catch-up / realtime) so we settle on the real end of the channel.
          openFollowBottomUntil = hasDivider ? 0 : Date.now() + 2500;
          
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
                    imageUrlsInMessages.add(part.url);
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
          debug.log('📜 Pending images to load:', pendingImages.length, 'out of', imageUrlsInMessages.size);
          debug.log('📜 Total embeds to load:', totalEmbeds);
          
          let scrollAttempts = 0;
          const scrollToBottom = () => {
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
                // else: settled (or gave up retrying). Intentionally KEEP
                // `shouldBeAtBottom` true. Late content grows the list AFTER
                // this initial scroll - the stale-while-revalidate catch-up
                // append and image/embed loads - and the ResizeObserver only
                // re-pins to the bottom while `shouldBeAtBottom` is true.
                // Releasing it here (the old 500ms timeout) is exactly what
                // left the user scrolled up when messages arrived during a
                // channel switch. The scroll handler flips it false the moment
                // the user scrolls up themselves.
              }
            });
          };

          // Scroll so the "New messages" divider sits near the top with a little
          // context above it (Discord behaviour). Retries while the virtualizer
          // measures real row heights so it settles on the right spot.
          let dividerScrollAttempts = 0;
          const CONTEXT_NUDGE_PX = 72;
          const scrollToDivider = () => {
            dividerScrollAttempts++;
            const idx = displayItems.value.findIndex(
              it => it.type === 'message' && it.message.id === dividerMsgId
            );
            if (idx < 0) {
              // Divider message no longer present (shouldn't happen) - fall back.
              scrollToBottom();
              return;
            }
            // Bring the divider row into the render window first.
            rowVirtualizer.value.scrollToIndex(idx, { align: 'start' });
            requestAnimationFrame(() => {
              const c = messageDisplayContainer.value;
              if (!c) return;
              // Position using the divider's REAL rendered position rather than the
              // virtualizer's height estimate (which lands us above it when rows are
              // taller than estimated). Measuring the DOM node keeps it reliably in
              // view with a little read context above the line.
              const dividerEl = c.querySelector('.new-messages-divider') as HTMLElement | null;
              if (dividerEl) {
                const delta = dividerEl.getBoundingClientRect().top - c.getBoundingClientRect().top - CONTEXT_NUDGE_PX;
                c.scrollTop = Math.max(0, c.scrollTop + delta);
              } else {
                c.scrollTop = Math.max(0, c.scrollTop - CONTEXT_NUDGE_PX);
              }
              if (dividerScrollAttempts < 6) {
                setTimeout(scrollToDivider, dividerScrollAttempts < 3 ? 50 : 150);
              } else {
                setTimeout(() => { shouldBeAtBottom.value = false; }, 500);
              }
            });
          };

          const scrollToTarget = () => (hasDivider ? scrollToDivider() : scrollToBottom());

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
                debug.log(`📜 Images loaded: ${imagesLoadedCount}/${pendingImages.length}, Embeds loaded: ${embedsLoadedCount}/${totalEmbeds}, elapsed: ${elapsed}ms`);
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
        // New messages appended at bottom (sent or received) - scroll if user was at bottom
        else if (prevCount > 0 && newMessages.length > prevCount && oldScrollHeight > 0) {
          const isAppend = prevFirstId != null && newMessages[0]?.id === prevFirstId;
          // Follow the bottom if the user was already there, OR we're still in
          // the post-open grace window (catch-up messages from revalidate /
          // realtime) and no divider is anchoring the view.
          const followBottom = userWasAtBottom.value ||
            (Date.now() < openFollowBottomUntil && !dividerBeforeMessageId.value);
          if (isAppend && followBottom) {
            debug.log('📜 New messages - scrolling to bottom (at bottom / open grace)');
            shouldBeAtBottom.value = true;
            const scrollNewToBottom = (attempt = 0) => {
              const count = displayItems.value.length;
              if (count > 0) {
                rowVirtualizer.value.scrollToIndex(count - 1, { align: 'end' });
              }
              if (messageDisplayContainer.value) {
                messageDisplayContainer.value.scrollTop = messageDisplayContainer.value.scrollHeight;
              }
              if (attempt < 3) {
                requestAnimationFrame(() => scrollNewToBottom(attempt + 1));
              }
            };
            requestAnimationFrame(() => scrollNewToBottom());
          } else if (isAppend && !userWasAtBottom.value) {
            shouldBeAtBottom.value = false;
          }
          // Load older messages (prepend) - pin viewport by scroll-height delta.
          //
          // The previous approach called `scrollToIndex(targetIndex, 'start')`
          // + a sub-item offset correction on each of 5 RAFs. That visibly jumped
          // because `scrollToIndex` issues a *new* scroll command instead of just
          // adjusting `scrollTop`, and each retry re-fired it as the virtualizer
          // re-measured. Standard chat-scroll pattern is cleaner: snapshot
          // `scrollHeight` + `scrollTop` BEFORE prepend, then after prepend set
          // `scrollTop = newScrollHeight - oldScrollHeight + oldScrollTop`. The
          // virtualizer's `totalSize` reflects newly added items, so the delta
          // is exactly how much we need to push down to keep the same content
          // under the user's eye. No jumps, no scrollToIndex thrash.
          else if (!isAppend) {
            shouldBeAtBottom.value = false;
            // Re-read the ref locally with a null guard - match the defensive
            // style used throughout this watcher (lines 1435, 1440, 1646, 1680).
            // The outer `if (messageDisplayContainer.value)` at the top of the
            // nextTick is enough at runtime today, but binding `container` once
            // here keeps the property accesses below from depending on TS
            // narrowing flowing across nested branches.
            const container = messageDisplayContainer.value;
            if (container) {
              const newHeight = container.scrollHeight;
              const heightDelta = newHeight - oldScrollHeight;
              if (heightDelta > 0) {
                // Apply once synchronously to suppress the flash, then again on
                // the next frame in case the virtualizer measured during the
                // same tick and grew `scrollHeight` after the initial write.
                container.scrollTop = oldScrollTopForPrepend + heightDelta;
                requestAnimationFrame(() => {
                  const c = messageDisplayContainer.value;
                  if (!c) return;
                  const finalDelta = c.scrollHeight - oldScrollHeight;
                  if (finalDelta > 0) {
                    c.scrollTop = oldScrollTopForPrepend + finalDelta;
                  }
                });
              }
            }
            // Note: prevDisplayItemCount is no longer needed here since we
            // pin by height-delta instead of by displayItems index. Leaving
            // the variable read in scope is harmless; the unused-var lint is
            // fine because the watcher above still uses it.
            void prevDisplayItemCount;
          }
        }
        
        checkScrollable();
        isAtTop.value = messageDisplayContainer.value.scrollTop === 0;
        const { scrollTop, scrollHeight, clientHeight } = messageDisplayContainer.value;
        emit('update:isAtBottom', scrollTop + clientHeight >= scrollHeight - 5);

      }
      lastKnownDisplayItemCount.value = displayItems.value.length;
    });
  }
}, { immediate: true, deep: true });

// After loading older messages finishes, if the sentinel is still visible (content
// still doesn't fill the viewport), load another batch. IntersectionObserver only
// fires on intersection *changes*, so we need to re-trigger manually.
watch(isLoadingOlderMessages, (loading, wasLoading) => {
  if (wasLoading && !loading && !isAllMessagesLoaded.value && props.loadMoreMessages) {
    // Delay to let virtualizer measure new elements before checking overflow
    setTimeout(() => {
      if (!messageDisplayContainer.value) return;
      const { scrollHeight, clientHeight } = messageDisplayContainer.value;
      if (scrollHeight <= clientHeight + 5) {
        debug.log('📜 Still no scrollbar after loading - auto-loading more');
        props.loadMoreMessages?.();
      }
    }, 300);
  }
});

watch(() => props.messages.map(msg => msg.reactions?.length), () => {
  const hasVisibleReactions = props.messages.some(msg => msg.reactions && msg.reactions.length > 0);
  if (!hasVisibleReactions && tooltip.value.visible) {
    hideTooltip();
  }
}, { deep: true });

// IntersectionObserver to clear unread counts when messages are scrolled into view
// Debounced to prevent 45+ API calls per page load
let intersectionObserver: IntersectionObserver | null = null;
const observedMessages = new Set<string>();
let pendingUnreadUpdate: { messageId: string; timestamp: Date } | null = null;
let unreadUpdateTimeout: ReturnType<typeof setTimeout> | null = null;
let hasUnreadUpdatePending = false;

const setupUnreadObserver = () => {
  if (!props.channelId && !props.conversationId) return;
  
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
        // Queue the message for unread update instead of calling API immediately
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

// Queue unread updates and debounce - only track the most recent message
const queueUnreadUpdate = (messageId: string) => {
  const message = props.messages.find(m => m.id === messageId);
  if (!message) return;
  
  const messageTimestamp = message.created_at;
  
  // Only update if this message is newer than the pending one
  if (!pendingUnreadUpdate || messageTimestamp > pendingUnreadUpdate.timestamp) {
    pendingUnreadUpdate = { messageId, timestamp: messageTimestamp };
  }
  
  // Debounce the actual API call
  if (unreadUpdateTimeout) {
    clearTimeout(unreadUpdateTimeout);
  }
  
  if (!hasUnreadUpdatePending) {
    hasUnreadUpdatePending = true;
  }
  
  unreadUpdateTimeout = setTimeout(async () => {
    if (pendingUnreadUpdate) {
      await flushUnreadUpdate();
    }
  }, 500); // 500ms debounce
};

// Flush the pending unread update to the server
const flushUnreadUpdate = async () => {
  if (!pendingUnreadUpdate || !hasUnreadUpdatePending) return;
  
  const { messageId } = pendingUnreadUpdate;
  hasUnreadUpdatePending = false;
  pendingUnreadUpdate = null;
  
  await clearUnreadCount(messageId);
};

const clearUnreadCount = async (messageId: string) => {
  if (!props.channelId && !props.conversationId) return;

  try {
    // unread_counts.user_id is a profile id (not an auth user id). Using the
    // wrong identity here silently no-ops the UPDATE, which used to leave the
    // sidebar badge "stuck" until the next fetch.
    const { authContextService } = await import('@/services/AuthContextService');
    const ctx = await authContextService.getCurrentContext();
    if (!ctx.isAuthenticated) return;
    const profileId = ctx.profileId;

    const message = props.messages.find(m => m.id === messageId);
    if (!message) return;
    
    const channelId = props.channelId || message.channel_id;
    const conversationId = props.conversationId || message.conversation_id;
    
    if (!channelId && !conversationId) return;
    
    const { error } = await supabase
      .from('unread_counts')
      .update({
        unread_messages: 0,
        unread_mentions: 0,
        last_read_message_id: messageId,
        last_read_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('user_id', profileId)
      .eq(channelId ? 'channel_id' : 'conversation_id', channelId || conversationId);
    
    if (error) {
      debug.error('Failed to clear unread count:', error);
    } else {
      debug.log('✅ Cleared unread count for', channelId ? 'channel' : 'conversation', channelId || conversationId);
    }
    
    // Batch mark related notifications as read
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
  window.removeEventListener('server-structure:thread-change', handleThreadBroadcast);
  window.removeEventListener('bot:updated', handleBotUpdated as EventListener);

  if (virtualRowObserverTimeout) {
    clearTimeout(virtualRowObserverTimeout);
    virtualRowObserverTimeout = null;
  }

  // Clear the debounce timeout first to prevent it from firing after unmount
  if (unreadUpdateTimeout) {
    clearTimeout(unreadUpdateTimeout);
    unreadUpdateTimeout = null;
  }
  
  // Flush any pending unread update before unmounting
  // Note: We can't truly await in onUnmounted, but we capture the data and let it complete
  // The flushUnreadUpdate function captures pendingUnreadUpdate at the start, so it will
  // complete even after we clear the local state
  if (pendingUnreadUpdate && hasUnreadUpdatePending) {
    // Fire and forget with error handling - the function already captures the data it needs
    flushUnreadUpdate().catch((err) => {
      console.warn('Failed to flush unread update on unmount:', err);
    });
  }
  
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
  if (resizeScrollRafId) {
    cancelAnimationFrame(resizeScrollRafId);
    resizeScrollRafId = null;
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
        debug.log('📜 Top sentinel visible (prefetch zone) - auto-loading older messages');
        props.loadMoreMessages?.();
      }
    },
    { root: messageDisplayContainer.value as unknown as Element | null, threshold: 0, rootMargin: '300px 0px 0px 0px' }
  );
  topSentinelObserver.observe(topSentinelRef.value as unknown as Element);
};

// --- RESIZE OBSERVER for scroll-to-bottom ---
let resizeObserver: ResizeObserver | null = null;
let resizeScrollRafId: number | null = null;

const setupResizeObserver = () => {
  if (resizeObserver || !messageDisplayContainer.value) return;
  const firstChild = messageDisplayContainer.value.firstElementChild as HTMLElement | null;
  if (!firstChild) return;

  resizeObserver = new ResizeObserver(() => {
    if (!shouldBeAtBottom.value || !messageDisplayContainer.value) return;
    if (resizeScrollRafId) cancelAnimationFrame(resizeScrollRafId);
    resizeScrollRafId = requestAnimationFrame(() => {
      if (!messageDisplayContainer.value || !shouldBeAtBottom.value) return;
      messageDisplayContainer.value.scrollTop = messageDisplayContainer.value.scrollHeight;
    });
  });
  resizeObserver.observe(firstChild);
};

// --- LIFECYCLE HOOKS ---
onMounted(() => {
  // Snapshot the read boundary for the initially-opened context (the reset
  // watcher only fires on subsequent context changes, not first mount).
  captureReadBoundary();
  if (messageDisplayContainer.value) {
    isAtTop.value = messageDisplayContainer.value.scrollTop === 0;
    checkScrollable();
    messageDisplayContainer.value.addEventListener('wheel', handleWheel, { passive: false });
  }
  setupTopSentinelObserver();
  setupResizeObserver();
  window.addEventListener('keydown', onShiftDown);
  window.addEventListener('keyup', onShiftUp);
  chatStore.highlightMessage = (messageId: string) => {
    const idx = displayItems.value.findIndex(
      item => item.type === 'message' && item.message?.id === messageId
    );
    if (idx < 0) return;
    rowVirtualizer.value.scrollToIndex(idx, { align: 'center', behavior: 'smooth' });
    setTimeout(() => {
      nextTick(() => {
        const messageElement = document.getElementById(`message-${messageId}`);
        if (messageElement) {
          messageElement.classList.add('highlighted');
          setTimeout(() => messageElement.classList.remove('highlighted'), 3000);
        }
      });
    }, 100);
  };
});

// Watch for DM highlight requests (reply jump in DMs)
watch(() => dmStore.highlightedMessageId, (messageId) => {
  if (!messageId) return;
  const idx = displayItems.value.findIndex(
    item => item.type === 'message' && item.message?.id === messageId
  );
  if (idx < 0) return;
  rowVirtualizer.value.scrollToIndex(idx, { align: 'center', behavior: 'smooth' });
  setTimeout(() => {
    nextTick(() => {
      const messageElement = document.getElementById(`message-${messageId}`);
      if (messageElement) {
        messageElement.classList.add('highlighted');
        setTimeout(() => messageElement.classList.remove('highlighted'), 3000);
      }
    });
  }, 100);
  dmStore.highlightedMessageId = null;
});

onUnmounted(() => {
  window.removeEventListener('keydown', onShiftDown);
  window.removeEventListener('keyup', onShiftUp);
  if (messageDisplayContainer.value) {
    messageDisplayContainer.value.removeEventListener('wheel', handleWheel);
  }
  if (longPressTimer.value) {
    clearTimeout(longPressTimer.value);
  }
  clearReadDivider();
  chatStore.highlightMessage = (_messageId: string) => {};
});

// --- METHODS ---

// Tooltip Handling
const showTooltip = async (event: MouseEvent, reaction: Reaction) => {
  if (tooltipTimer.value) clearTimeout(tooltipTimer.value);
  
  const harmonyUserIds = reaction.reactions
    .filter(r => r.user_id)
    .map(r => r.user_id);
  
  if (harmonyUserIds.length > 0) {
    await ensureProfilesAvailable(harmonyUserIds).catch(error => 
      debug.error("Error ensuring profiles for tooltip:", error)
    );
  }

  const usersDetails = reaction.reactions.map(r => {
    // Check if this is a bridged Discord reaction (has metadata.discord_user)
    if (r.metadata?.discord_user) {
      const discordUser = r.metadata.discord_user;
      return {
        id: discordUser.id,
        displayName: discordUser.display_name || discordUser.username || 'Discord User',
        avatarUrl: discordUser.avatar_url || '',
        userColor: '#0EA5E9', // Discord brand color
        isBridged: true,
        bridgeSource: 'discord'
      };
    }
    
    // Regular Harmony user - use role color where available, like the
    // username in the message header. Keeps the reaction tooltip consistent
    // with the rest of the chat.
    return {
      id: r.user_id,
      displayName: getUserDisplayName(r.user_id).value,
      avatarUrl: getUserAvatarUrl(r.user_id).value,
      userColor: resolveChatUserColor(r.user_id),
      isBridged: false
    };
  });
  
  const anchor = getReactionTooltipAnchor(event);
  tooltipTimer.value = setTimeout(() => {
    tooltip.value = { visible: true, content: usersDetails, x: anchor.x, y: anchor.y, emoji: reaction.emoji };
  }, 500);
};

const hideTooltip = () => {
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

const handleScroll = throttle(() => {
  if (!messageDisplayContainer.value) {
    return;
  }
  
  const { scrollTop, scrollHeight, clientHeight } = messageDisplayContainer.value;
  
  checkScrollable();
  isAtTop.value = scrollTop === 0;
  
  if (!isAtTop.value || !hasScrollbar.value) bufferDistance.value = 0;
  
  // Prefetch when near top (within 400px)
  if (scrollTop < 400 && hasScrollbar.value) {
    if (!isAllMessagesLoaded.value && !isLoadingOlderMessages.value && props.loadMoreMessages) {
      props.loadMoreMessages();
    }
  }

  const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
  const isAtBottom = distanceFromBottom <= 5;
  userWasAtBottom.value = isAtBottom;
  if (!isAtBottom) {
    // A comfortable margin so transient content growth (images/embeds
    // measuring, the revalidate catch-up append) isn't mistaken for the user
    // deliberately scrolling up.
    const intentionalScrollUp = distanceFromBottom > 200;
    // During the post-open settling window we keep the bottom pin even if late
    // content briefly puts us a little above the bottom; only a real scroll-up
    // releases it. This is what keeps a channel switch (with messages arriving)
    // settled at the true bottom instead of floating just above them.
    if (intentionalScrollUp || Date.now() >= openFollowBottomUntil) {
      shouldBeAtBottom.value = false;
    }
    if (intentionalScrollUp) {
      openFollowBottomUntil = 0;
    }
  } else {
    shouldBeAtBottom.value = true; // User scrolled back to bottom
  }

  emit('update:isAtBottom', isAtBottom);
}, 16);

const handleWheel = (event: WheelEvent) => {
  if (messageDisplayContainer.value && hasScrollbar.value && isAtTop.value && event.deltaY < 0) {
    event.preventDefault();
    bufferDistance.value = Math.min(bufferDistance.value + Math.abs(event.deltaY) * 0.5, BUFFER_THRESHOLD * 2);
  } else if (event.deltaY > 0) {
    bufferDistance.value = 0;
  }
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
    
    // If both have discord_user metadata, compare by discord user id or username
    if (currentDiscordUser && prevDiscordUser) {
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

const getIndicatorStyle = () => {
  if (!hasScrollbar.value || bufferDistance.value <= 0) {
    return { opacity: 0, transform: 'translateY(-20px)', pointerEvents: 'none' as const };
  }
  const progress = Math.min(bufferDistance.value / BUFFER_THRESHOLD, 1);
  return {
    opacity: progress,
    transform: `translateY(${-20 + progress * 20}px)`,
    pointerEvents: progress > 0.5 ? ('auto' as const) : ('none' as const),
    transition: 'opacity 0.2s ease-out, transform 0.2s ease-out'
  };
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

/** Full datetime for title/tooltip (e.g. "March 9, 2025 at 3:45 PM") */
const formatFullTimestamp = (timestamp: Date) => {
  const date = new Date(timestamp);
  if (!isValid(date)) return '';
  return format(date, "MMMM d, yyyy 'at' p");
};

const formatSystemTimestamp = (timestamp: Date) => {
  const date = new Date(timestamp);
  if (!isValid(date)) return '';
  if (isToday(date)) return format(date, 'p');
  if (isYesterday(date)) return `Yesterday at<br/>${format(date, 'p')}`;
  return `${format(date, 'MMM d, yyyy')}<br/>${format(date, 'p')}`;
};

const formatCallDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
};

const joinCallFromSystemMessage = async (message: any) => {
  const conversationId = message.conversation_id || props.conversationId;
  if (!conversationId) return;
  
  try {
    const { useUnifiedVoiceChannelStore } = await import('@/stores/unifiedVoiceChannel');
    const { dmCallSignaling } = await import('@/services/DMCallSignaling');
    const { authContextService } = await import('@/services/AuthContextService');
    const voiceStore = useUnifiedVoiceChannelStore();
    
    if (voiceStore.isConnected) {
      debug.log('Already in a call');
      return;
    }
    
    const profileId = await authContextService.getCurrentProfileId();
    const dmChannelId = `dm-${conversationId}`;
    
    await dmCallSignaling.joinCall(conversationId, profileId);
    const success = await voiceStore.joinVoiceChannel(dmChannelId, 'dm');
    if (success) {
      voiceStore.isOverlayVisible = true;
    }
  } catch (error) {
    debug.error('Failed to join call from system message:', error);
  }
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

  const currentProfileId = profileStore.profile?.id;
  const messageUserId = message.user_id;
  const isOwnMessage = messageUserId === currentProfileId;

  // On non-local (federated mirror) servers, only allow editing own messages
  if (serverChannelStore.currentServer?.is_local_server === false) {
    return isOwnMessage;
  }

  // DMs: own messages only (matches messages_update RLS when channel_id is null)
  if (props.conversationId && !props.channelId) {
    return isOwnMessage;
  }

  return (
    isOwnMessage
    || isCurrentUserServerOwner.value
    || profileStore.profile?.is_admin
    || profileStore.profile?.is_moderator
    || canManageMessages.value
  );
};

const canEditAttachments = (message: Message) => canEditMessage(message);

const canDeleteMessage = (message: Message) => {
  if (!authStore.session?.user || !message) return false;

  const currentProfileId = profileStore.profile?.id;
  const messageUserId = message.user_id;
  const isOwnMessage = messageUserId === currentProfileId;

  // On non-local (federated mirror) servers, only allow deleting own messages
  if (serverChannelStore.currentServer?.is_local_server === false) {
    return isOwnMessage;
  }

  if (isOwnMessage) return true;
  if (isCurrentUserServerOwner.value) return true;
  if (profileStore.profile?.is_admin || profileStore.profile?.is_moderator) return true;
  if (canManageMessages.value) return true;

  return false;
};




    const startEdit = (message: Message) => {
    if (!canEditMessage(message)) return;
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
  try {
    const userDataMap = await resolveMentionsUserData(textContent);
    const emojiDataMap = await resolveEmojisData(textContent);
    const roleDataMap = await resolveRoleMentionsData(textContent, serverChannelStore.currentServerId || undefined);
    const parsedContent = await parseContentToMessageParts(textContent, userDataMap, emojiDataMap, {}, roleDataMap, buildChatParseOptions(!!props.conversationId));
    // Re-append the attachments the user kept, so editing text never drops media.
    const finalContent = [...parsedContent, ...retainedFiles];

    if (props.channelId) {
      await chatStore.editMessage(messageId, finalContent);
    } else if (props.conversationId) {
      await dmStore.editMessage(messageId, finalContent);
    }
    cancelEdit();
  } catch (error) {
    debug.error('Error saving message edit:', error);
  }
};

const cancelEdit = () => {
  editableMessageId.value = null;
  editableMessageContent.value = '';
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
    if (props.channelId) {
      await chatStore.editMessage(messageId, newContent);
    } else if (props.conversationId) {
      await dmStore.editMessage(messageId, newContent);
    }
  } catch (error) {
    debug.error('Error removing attachment:', error);
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

const deleteMessage = (messageId: string, event?: MouseEvent) => {
  const bypassConfirm = event?.shiftKey === true;
  hoveredMessageId.value = null;
  const thread = getThreadForMessage(messageId);
  
  if (thread) {
    deleteConfirmConfig.value = {
      messageId,
      hasThread: true,
      threadName: thread.name || 'this thread',
    };
    showDeleteConfirmModal.value = true;
  } else if (bypassConfirm) {
    triggerDestructive();
    if (props.channelId) {
      chatStore.deleteMessage(messageId);
    } else if (props.conversationId) {
      dmStore.deleteMessage(messageId);
    }
  } else {
    deleteConfirmConfig.value = {
      messageId,
      hasThread: false,
      threadName: '',
    };
    showDeleteConfirmModal.value = true;
  }
};

const confirmDeleteMessage = async () => {
  const { messageId, hasThread } = deleteConfirmConfig.value;
  
  // Haptic feedback for destructive action
  triggerDestructive();
  
  if (props.channelId) {
    await chatStore.deleteMessage(messageId);
  } else if (props.conversationId) {
    await dmStore.deleteMessage(messageId);
  }
  
  if (hasThread) {
    threadsByMessageId.value.delete(messageId);
  }
  
  showDeleteConfirmModal.value = false;
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
  reportTargetMessagePreview.value = preview.slice(0, 200) || undefined;

  const profile = getUserProfile(authorId);
  const displayName = getUserDisplayName(authorId);
  const avatarUrl = getUserAvatarUrl(authorId);
  reportTargetUser.value = {
    username: profile?.value?.username || displayName?.value || 'Unknown',
    display_name: displayName?.value || undefined,
    avatar_url: avatarUrl?.value || undefined,
  };

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

// Correct scroll position when an item above the viewport resizes.
// Uses an anchor-based approach: track the item at the viewport top before
// the resize, then after re-measurement adjust scrollTop by only the change
// in that anchor item's start offset (which reflects above-viewport growth).
const scrollToBottomIfPinned = () => {
  nextTick(() => {
    requestAnimationFrame(() => {
      if (!messageDisplayContainer.value) return;
      const count = displayItems.value.length;
      if (count > 0) rowVirtualizer.value.scrollToIndex(count - 1, { align: 'end' });
    });
  });
};

const correctScrollAfterResize = (callback: () => void) => {
  const container = messageDisplayContainer.value;
  if (!container) { callback(); return; }
  
  // Pinned to bottom: remeasure first, then re-seat so totalSize includes
  // the new height (reactions, embeds, images) before we scroll.
  if (shouldBeAtBottom.value || userWasAtBottom.value) {
    callback();
    scrollToBottomIfPinned();
    return;
  }
  
  const scrollTopBefore = container.scrollTop;
  const totalSizeBefore = rowVirtualizer.value.getTotalSize();

  // Find anchor: the first item overlapping the viewport top
  const items = rowVirtualizer.value.getVirtualItems();
  let anchorItem = items.find(item => item.start + item.size > scrollTopBefore);
  if (!anchorItem && items.length) anchorItem = items[items.length - 1];
  const anchorIdx = anchorItem?.index;
  const anchorStartBefore = anchorItem?.start;
  
  callback();
  
  nextTick(() => {
    requestAnimationFrame(() => {
      if (!container || shouldBeAtBottom.value) return;

      let delta = 0;

      if (anchorIdx != null && anchorStartBefore != null) {
        // Precise: only count the shift in the anchor's start position,
        // which reflects size changes of items *above* the viewport.
        const updatedItems = rowVirtualizer.value.getVirtualItems();
        const updatedAnchor = updatedItems.find(item => item.index === anchorIdx);
        if (updatedAnchor) {
          delta = updatedAnchor.start - anchorStartBefore;
        } else {
          // Anchor no longer in virtual items - fall back to total size delta
          delta = rowVirtualizer.value.getTotalSize() - totalSizeBefore;
        }
      } else {
        delta = rowVirtualizer.value.getTotalSize() - totalSizeBefore;
      }

      if (Math.abs(delta) > 1) {
        // Apply the correction RELATIVE to the live scroll position rather than
        // re-seating from the (now stale) `scrollTopBefore`. If the user kept
        // scrolling while an image/embed finished loading, seating from the
        // stale value would yank the viewport - the "scroll skips around when
        // new elements load" bug. A relative nudge cancels the size change
        // above the viewport without fighting the user's own scrolling.
        container.scrollTop += delta;
      }
    });
  });
};

// Lightbox and Media
const handleImageLoaded = (url: string) => {
  imageLoaded.value[url] = true;

  correctScrollAfterResize(() => {
    nextTick(() => {
      const container = messageDisplayContainer.value;
      if (!container) return;
      container.querySelectorAll('[data-index]').forEach(el => {
        rowVirtualizer.value.measureElement(el as HTMLElement);
      });
    });
  });
};

const handleReactionsLayoutChange = (messageId: string) => {
  correctScrollAfterResize(() => {
    remeasureItem(messageId);
  });
};

const handleEmbedLoaded = (messageId: string) => {
  if (!embedLoaded.value[messageId]) {
    embedLoaded.value[messageId] = 0;
  }
  embedLoaded.value[messageId] = (embedLoaded.value[messageId] || 0) + 1;

  correctScrollAfterResize(() => {
    remeasureItem(messageId);
  });
};

const handleDecryptMessage = async (message: Message) => {
  debug.log('🔓 Attempting to decrypt message on click:', message.id);
  
  try {
    // Dynamically import the encryption service
    const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService');
    
    if (!megolmMessageEncryptionService.isUnlocked()) {
      debug.log('🔒 Encryption not unlocked - cannot decrypt');
      return;
    }
    
    // First, try to claim any pending session shares
    await megolmMessageEncryptionService.claimPendingSessionShares();
    
    // Check if we have the original encrypted content (not replaced with glyphs)
    // If content is preserved, use it directly - no DB reload needed
    const hasOriginalContent = message.encryption_metadata && 
      Array.isArray(message.content) && 
      message.content[0]?.type === 'text' &&
      message.content[0]?.text &&
      /^[A-Za-z0-9+/=]{20,}$/.test(message.content[0].text); // Looks like base64
    
    let messageToDecrypt = message;
    
    if (!hasOriginalContent) {
      // Content was replaced with glyphs (legacy) - reload from DB
      debug.log('🔐 Content was replaced with glyphs, reloading from database...');
      const { data: freshMessage } = await supabase
        .from('messages')
        .select('*')
        .eq('id', message.id)
        .single();
      
      if (!freshMessage?.encryption_metadata || !freshMessage.encrypted) {
        debug.log('❌ Message has no encryption metadata in database');
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
    debug.log('🔐 Decrypting with roomId:', roomId);
    
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
      // NOTE: previous code called `resolveMentionsUserData(decryptedContent)`
      // and assigned its return value to `content`, but-
      // `resolveMentionsUserData` returns a Record<string, {userId, isLocal}>
      // lookup map (not MessagePart[]). That was a latent bug - assigning the
      // lookup map to `content` would render nothing. The decrypted content
      // is already a parsed `MessagePart[]` from
      // `megolmMessageEncryptionService.decryptMessage`, so we use it directly.
      // Create updated message object
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
      
      debug.log('✅ Message decrypted successfully on click');

      // Trigger reprocessing of other encrypted messages (we may now have the session key)
      window.dispatchEvent(new CustomEvent('megolm-key-received', {
        detail: { roomId: messageToDecrypt.channel_id || messageToDecrypt.conversation_id, sessionId: messageToDecrypt.encryption_metadata?.session_id }
      }));
    }
  } catch (error: any) {
    // Surface the real reason. This used to be a silent debug.log, which made
    // "click the glyph -> nothing happens" impossible to diagnose. The message
    // distinguishes the common failure modes (missing session key, locked keys,
    // signature mismatch) so it's actionable.
    const reason = error?.message || String(error);
    debug.error('❌ Could not decrypt message:', error);
    try {
      useNotificationStore().showToast(
        'server_update',
        'Could not decrypt message',
        reason,
        6000,
      );
    } catch { /* toast best-effort */ }
  } finally {
    // Tell the glyph component the attempt settled so its spinner stops NOW.
    // It previously relied only on a fixed 5s timeout, so a fast failure
    // showed the error toast while the lock kept spinning for seconds.
    window.dispatchEvent(new CustomEvent('harmony-decrypt-finished', {
      detail: { messageId: message.id },
    }));
  }
};

const handleOpenLightbox = (url: string) => {
  const index = lightboxImages.value.indexOf(url);
  if (index !== -1) {
    indexRef.value = index;
    activeLightboxImages.value = lightboxImages.value;
  } else {
    // Image from an embed not in the pre-computed list - show standalone
    activeLightboxImages.value = [url];
    indexRef.value = 0;
  }
  isLightboxOpen.value = true;
};

const closeLightbox = () => {
  isLightboxOpen.value = false;
};

// Context menu handlers
const openContextMenu = (message: Message, event: MouseEvent) => {
  event.preventDefault();
  event.stopPropagation();
  
  // Haptic feedback for context menu
  triggerInteraction();

  // On mobile the (...) button in the floating toolbar opens this menu.
  // The toolbar itself remains pinned ~48px above the original tap point,
  // which visually clashes (and z-stacks) with the menu we're about to
  // render. Dismiss the toolbar so the user sees exactly one surface -
  // the menu - rooted at the tap.
  if (isMobile.value) {
    hoveredMessageId.value = null;
    mobileActionTapPosition.value = null;
  }

  contextMenuMessage.value = message;
  contextMenuPosition.value = {
    x: event.clientX,
    y: event.clientY
  };
  contextMenuVisible.value = true;
};

// Native right-click on a message row opens the same context menu the
// "more" button does. We deliberately let the browser's native menu
// take over for media (images, video, audio) and links so users can
// still "Save image as", "Copy link address", etc. - that matches
// Discord/Slack behaviour.
const handleMessageContextMenu = (message: Message, event: MouseEvent) => {
  // On mobile the OS fires a synthetic `contextmenu` event after a
  // long-press. We already handle long-press explicitly via the
  // touchstart timer (which shows the floating message-actions toolbar),
  // so opening the full context menu on top of it produces two competing
  // surfaces. Swallow the synthetic event so only the toolbar shows;
  // the user can then tap the (...) button to get the full menu.
  // Exception: selected text or native media/link targets should keep
  // the browser/OS copy menu.
  if (isMobile.value && !shouldAllowNativeContextMenu(event)) {
    event.preventDefault();
    return;
  }
  if (shouldAllowNativeContextMenu(event)) {
    return;
  }
  openContextMenu(message, event);
};

const closeContextMenu = () => {
  contextMenuVisible.value = false;
  contextMenuMessage.value = null;
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
  // Handle plain "@user@domain" / "user@domain" / "@user" handles from
  // chat mentions. Routes through activityPubService so federated users we
  // haven't seen yet get fetched from their origin instance.
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
  border-left: 3px solid var(--error, #f04747);
}

.failed-message-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--error, #f04747);
  border-radius: 4px;
  background: rgba(240, 71, 71, 0.08);
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
  background: rgba(255, 255, 255, 0.1);
}

.failed-message-bar .retry-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

.failed-message-bar .discard-btn {
  color: var(--text-secondary);
}

.failed-message-bar .discard-btn:hover {
  color: var(--error, #f04747);
  background: rgba(240, 71, 71, 0.15);
}

.message-item:hover {
  background-color: rgba(4, 4, 5, 0.07);
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
  background: var(--harmony-primary);
  color: var(--text-primary);
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
  font-size: 0.75rem;
  color: #a3a6aa;
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
  color: var(--harmony-primary);
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

/* Show timestamp on hover for compact messages */
.message-content-only:hover .message-gutter::before {
  content: attr(data-timestamp);
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  line-height: 1.375rem;
  text-align: center;
  font-size: 0.6875rem;
  color: var(--text-muted);
  font-weight: 500;
}

/* Message actions */
.message-actions {
  position: absolute;
  top: -16px;
  right: 0;
  display: flex;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  backdrop-filter: blur(8px);
  z-index: 1;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
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

.action-btn.delete-danger {
  color: var(--error)!important;
  background-color: color-mix(in srgb, var(--error) 50%, transparent)!important;
}

.action-btn.delete-danger:hover {
  background-color: color-mix(in srgb, var(--error-hover) 50%, transparent)!important;
  color: var(--error-hover)!important;
}

/* Gap indicator */
.message-gap {
  display: flex;
  align-items: center;
  margin: 24px 16px;
  color: var(--text-muted);
  font-size: 0.875rem;
  font-weight: 600;
}

.gap-line {
  flex: 1;
  height: 1px;
  background-color: var(--background-quinary);
}

.gap-text {
  padding: 0 16px;
  background-color: var(--background-secondary);
  position: relative;
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

/* "New messages" divider - secondary-themed pill with a cool fading line */
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
  background-color: var(--harmony-secondary);
  color: #fff;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  line-height: 1.6;
  box-shadow: 0 0 10px color-mix(in srgb, var(--harmony-secondary) 45%, transparent);
}

.new-messages-line {
  flex: 1;
  height: 1px;
  background: linear-gradient(
    90deg,
    var(--harmony-secondary) 0%,
    color-mix(in srgb, var(--harmony-secondary) 35%, transparent) 60%,
    transparent 100%
  );
}

/* Beginning of conversation indicator */
.beginning-indicator {
  display: flex;
  justify-content: center;
  padding: 32px 16px 24px;
  margin-bottom: 8px;
  /* Remove default transitions since we handle them programmatically */
  transition: none;
}

.beginning-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  max-width: 480px;
  padding: 24px;
  background: linear-gradient(135deg, rgba(14, 165, 233, 0.1) 0%, rgba(14, 165, 233, 0.05) 100%);
  border-radius: 16px;
  border: 1px solid rgba(14, 165, 233, 0.2);
  transition: all 0.3s ease-in-out;
}

.beginning-content:hover {
  background: linear-gradient(135deg, rgba(14, 165, 233, 0.15) 0%, rgba(14, 165, 233, 0.08) 100%);
  border-color: rgba(14, 165, 233, 0.3);
}

.beginning-icon {
  font-size: 2rem;
  margin-bottom: 12px;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2));
}

.beginning-title {
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
  line-height: 1.4;
}

.beginning-subtitle {
  font-size: 0.875rem;
  color: var(--text-secondary);
  line-height: 1.4;
  opacity: 0.8;
}

/* Highlighted message */
.highlighted {
  background-color: rgba(14, 165, 233, 0.15) !important;
  border-left: 3px solid #0EA5E9;
  animation: highlight-fade 3s ease-out;
}

/* Search text highlight */
.search-highlight {
  background-color: #fbbf24;
  color: #1f2937;
  padding: 2px 4px;
  border-radius: 3px;
  font-weight: 600;
}

@keyframes highlight-fade {
  0% {
    background-color: hsl(34, 100%, 50%, 0.3) !important;
  }
  100% {
    background-color: hsl(34, 100%, 50%, 0.1) !important;
  }
}

/* No messages state */
.no-messages {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  height: 100%;
  color: var(--text-muted);
  font-size: 1rem;
}

/* Tooltip */
.tooltip {
  position: fixed;
  background-color: var(--tooltip-bg, #18191c);
  color: var(--tooltip-text, var(--text-primary));
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 0.875rem;
  font-weight: 500;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  z-index: 1000;
  pointer-events: none;
  max-width: 300px;
  transform: translateX(-50%);
}

.tooltip-avatar {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  margin-right: 8px;
}

.tooltip-user {
  display: flex;
  align-items: center;
  gap: 4px;
}

.bridged-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 2px;
}

.tooltip-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0 8px 0;
  margin-bottom: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--background-quinary) 30%, transparent);
}
.tooltip-emoji {
  width: 48px;
  height: 48px;
  margin-right: 4px;
}
.tooltip-emoji-name {
  font-size: 0.875rem;
  color: var(--tooltip-text, var(--text-secondary));
  opacity: 0.9;
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
  background-color: var(--background-quaternary, #2b2d31);
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
  
  .beginning-indicator {
    padding: 24px 12px 16px;
  }
  
  .beginning-content {
    padding: 20px 16px;
    max-width: 100%;
  }
  
  .beginning-title {
    font-size: 1rem;
  }
  
  .beginning-subtitle {
    font-size: 0.8125rem;
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
    max-width: 40vw;
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

/* Dark theme adjustments */
:root[data-theme-type="dark"] .message-item:hover {
  background-color: rgba(79, 84, 92, 0.16);
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


.system-icon {
  font-size: 1rem;
  flex-shrink: 0;
}

.system-text {
  flex: 1;
  color: var(--text-secondary);
}

.system-text :deep(.system-message-content) {
  color: inherit !important;
}

/* Thread created system message */
.thread-created-text {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px;
}

.system-user-mention {
  font-weight: 600;
  cursor: pointer;
}

.system-user-mention:hover {
  text-decoration: underline;
}

.system-thread-link,
.system-threads-link {
  color: var(--text-link, #00aff4);
  font-weight: 600;
  cursor: pointer;
}

.system-thread-link:hover,
.system-threads-link:hover {
  text-decoration: underline;
}

/* Call system messages */
.call-icon-container {
  display: flex;
  align-items: center;
  justify-content: center;
}

.call-system-icon {
  color: var(--text-secondary);
}

.call-system-icon.active {
  color: #57f287;
}

.call-system-text {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.call-duration {
  color: var(--text-muted, var(--text-muted));
  font-size: 0.8rem;
}

.call-join-btn {
  background: #57f287;
  color: #000;
  border: none;
  border-radius: 4px;
  padding: 2px 12px;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  margin-left: 4px;
  transition: opacity 0.15s;
}

.call-join-btn:hover {
  opacity: 0.85;
}

.system-timestamp {
  font-size: 0.65rem;
  color: var(--text-muted);
  opacity: 0.7;
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

.loading-older-messages {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 12px;
  height: 44px;
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
  background-color: #3ba55d;
  opacity: 0.5;
  box-shadow: 0 0 3px rgba(59, 165, 93, 0.4);
}

.encryption-dot.decrypted:hover {
  opacity: 1;
  box-shadow: 0 0 6px rgba(59, 165, 93, 0.8);
  transform: scale(1.2);
}

.encryption-indicator.locked {
  display: inline-block;
  font-size: 0.7em;
  margin-left: 4px;
  opacity: 0.6;
  animation: lockPulse 3s ease-in-out infinite;
  filter: drop-shadow(0 0 3px rgba(237, 66, 69, 0.4));
  cursor: help;
  transition: all 0.2s ease;
  vertical-align: middle;
  position: relative;
  top: -1px;
}

.encryption-indicator.locked:hover {
  opacity: 1;
  filter: drop-shadow(0 0 6px rgba(237, 66, 69, 0.8));
  transform: scale(1.1);
}

/* Permanently unrecoverable: key predates current identity. Muted and
   static (no pulse) - there is nothing actionable, the tooltip explains. */
.encryption-indicator.locked.unrecoverable {
  animation: none;
  opacity: 0.45;
  filter: grayscale(1) drop-shadow(0 0 2px rgba(128, 128, 128, 0.4));
}

.encryption-indicator.locked.unrecoverable:hover {
  opacity: 0.8;
  filter: grayscale(1) drop-shadow(0 0 4px rgba(128, 128, 128, 0.6));
  transform: scale(1.1);
}

@keyframes lockPulse {
  0%, 100% {
    opacity: 0.6;
  }
  50% {
    opacity: 0.9;
  }
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
  font-size: 14px;
  color: #ed4245;
}

.reported-text {
  color: var(--text-muted);
  font-style: italic;
}

.unreport-btn {
  color: var(--text-secondary) !important;
}

.reported-banner {
  border-left-color: #ed4245;
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
  background: rgba(237, 66, 69, 0.1);
  border-radius: 4px;
  border-left: 3px solid var(--status-danger, #ed4245);
}

.revealed-blocked {
  border-left: 2px solid var(--status-danger, #ed4245);
  background: rgba(237, 66, 69, 0.05);
}

.blocked-icon {
  font-size: 1rem;
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
  border-color: var(--text-normal);
  color: var(--text-normal);
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
  color: var(--text-warning, #f0b232);
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
  color: var(--text-normal);
}

/* Shake animation for blocked reaction attempts (like Discord) */
@keyframes shake-reject {
  0%, 100% { transform: translateX(0); }
  10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
  20%, 40%, 60%, 80% { transform: translateX(4px); }
}

.shake-reject {
  animation: shake-reject 0.5s ease-in-out;
  background-color: rgba(237, 66, 69, 0.1) !important;
}

.shake-reject .message-reactions,
.shake-reject .reaction {
  animation: shake-reject 0.5s ease-in-out;
}
</style>