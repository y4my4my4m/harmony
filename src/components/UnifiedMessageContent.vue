<template>
  <div class="unified-content">
    <!-- Edit mode: RichTextEditor shows role/user mentions as colored pills -->
    <div v-if="editableMessageId === messageId" class="edit-container">
      <RichTextEditor
        ref="editRichEditorRef"
        class="edit-textarea"
        :model-value="localEditableContent"
        placeholder="Edit message"
        :min-height="44"
        :max-height="200"
        :auto-suggest-active="!!autoSuggest?.state.value.isActive"
        :auto-suggest-selected-id="autoSuggest?.state.value.isActive ? 'suggest-' + autoSuggest.state.value.selectedIndex : undefined"
        @update:model-value="handleRichEditorUpdate"
        @cursor-position-changed="handleEditCursorPositionChanged"
        @keydown="handleKeyDown"
      />
      <!-- Existing attachments as removable thumbnails. Removal affects the
           saved message only, not the text input above. -->
      <div v-if="editableFiles.length > 0" class="edit-attachments">
        <div
          v-for="(file, fileIndex) in editableFiles"
          :key="(file.url || '') + fileIndex"
          class="edit-attachment"
          :title="file.fileName || file.url"
        >
          <img
            v-if="isEditFileImage(file)"
            class="edit-attachment-thumb"
            :src="displayMediaUrl(file)"
            :alt="file.fileName || 'attachment'"
          />
          <video
            v-else-if="isEditFileVideo(file)"
            class="edit-attachment-thumb"
            :src="mediaSrc(file)"
            muted
          />
          <div v-else class="edit-attachment-file">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span class="edit-attachment-name">{{ file.fileName || 'file' }}</span>
          </div>
          <button
            type="button"
            class="edit-attachment-remove"
            title="Remove attachment"
            @click.stop="removeEditFile(fileIndex)"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="edit-actions">
        <span class="edit-hint">
          escape to <span class="edit-action" @click="handleCancelEdit">cancel</span> • 
          enter to <span class="edit-action" @click="handleSaveEdit">save</span>
        </span>
      </div>
      <AutoSuggest
        v-if="autoSuggest"
        :isVisible="autoSuggest.state.value.isActive"
        :suggestions="autoSuggest.suggestions.value"
        :position="autoSuggest.state.value.position"
        :selectedIndex="autoSuggest.state.value.selectedIndex"
        :headerText="autoSuggest.headerText.value"
        @select="handleSuggestionSelect"
      />
    </div>
    
    <!-- Display mode -->
    <div v-else class="content-display" :class="{ 'system-message-content': isSystem }">
      <!--
        Unverified-author badge. Shown only for messages that were encrypted,
        decrypted successfully, but whose sender signature could not be
        verified (legacy v1 message, or sender has no signing key on file).
        User-visible signal of Megolm v2 sender binding.
      -->
      <span
        v-if="decrypted && senderVerified === false"
        class="unverified-author-badge"
        title="This message was decrypted but the sender's identity could not be cryptographically verified. The sender may be running an older client, or the message may have been tampered with."
      >Unverified author</span>
      <template v-for="(part, partIndex) in displayContent" :key="partIndex">
        <!-- Grouped image/video mosaic (Discord-style) -->
        <MessageMediaGallery
          v-if="part && typeof part === 'object' && part.type === 'media_gallery'"
          :parts="(part as any).parts"
          :message-id="messageId"
          :image-loaded="imageLoadedState"
          :can-remove="canEditAttachments"
          @open-lightbox="$emit('open-lightbox', $event)"
          @image-loaded="handleImageLoad"
          @remove-attachment="requestRemoveAttachment"
        />
        <!-- Text content with markdown-style formatting and code blocks -->
        <template 
          v-if="part && typeof part === 'object' && part.type === 'text'"
        >
          <!-- Encrypted glyphs -->
          <template v-if="encrypted && !decrypted">
            <!-- Permanently unrecoverable: encrypted with a key that no longer
                 exists. No click-to-decrypt - retrying would never succeed. -->
            <span
              v-if="unrecoverable"
              class="encrypted-no-decrypt encrypted-unrecoverable encrypted-glyphs"
              title="This message was encrypted with a previous key that no longer exists on this account, so it can't be decrypted."
            >
              <Icon name="lock" :size="12" class="unrecoverable-lock" aria-hidden="true" />
              <EncryptedGlyphPreview
                :content="part.text || 'encrypted'"
                :message-id="messageId"
                lost
              />
            </span>
            <!-- Clickable version (user has encryption set up) -->
            <span 
              v-else-if="canDecrypt"
              class="encrypted-click-target encrypted-glyphs"
              @click="handleDecryptClick"
              :title="decrypting ? 'Decrypting...' : 'Click to decrypt'"
            >
              <span v-if="decrypting" class="decrypt-loading">
                <Icon name="spinner" :size="20" class="decrypt-spinner" />
              </span>
              <EncryptedGlyphPreview
                :content="part.text || 'encrypted'"
                :message-id="messageId"
                :decrypting="decrypting"
              />
            </span>
            <!-- Non-clickable version (user doesn't have encryption) -->
            <span v-else class="encrypted-no-decrypt encrypted-glyphs">
              <EncryptedGlyphPreview
                :content="part.text || 'encrypted'"
                :message-id="messageId"
              />
            </span>
          </template>
          <!-- Normal text -->
          <template v-else v-for="(segment, segmentIndex) in renderTextSegments(part.text)" :key="`${partIndex}-${segmentIndex}`">
            <span 
              v-if="segment.type === 'text'" 
              class="text-content"
              v-html="segment.content"
              @click="revealTextSpoiler"
            ></span>
            <CodeBlock 
              v-else-if="segment.type === 'codeblock'"
              :code="segment.code!"
              :language="segment.language!"
            />
          </template>
        </template>
        
        <!-- User mentions (display name with @ prefix) -->
        <span 
          v-else-if="part && typeof part === 'object' && part.type === 'mention'" 
          class="mention" 
          :class="{ 'bridged-mention': isBridgedMention(part), 'discord-mention': part.domain === 'discord.com', 'federated-mention': !!mentionSuffix(part) }"
          @click="handleMentionClick(part, $event)"
          :title="getMentionTooltip(part)"
        >
          <span class="mention-at">@</span>
          <template v-if="part.userId">
            <DisplayName :userId="part.userId" :fallback="part.username" :truncate="false" />
          </template>
          <template v-else>{{ part.username }}</template>
          <span
            v-if="mentionSuffix(part)"
            class="mention-domain"
          >@{{ mentionSuffix(part) }}</span>
        </span>

        <!-- Role mentions -->
        <span
          v-else-if="part && typeof part === 'object' && part.type === 'role_mention'"
          class="mention role-mention"
          :style="part.roleColor ? { color: part.roleColor, backgroundColor: part.roleColor + '1a' } : {}"
        >@{{ (part.roleName || 'Unknown Role').replace(/^@/, '') }}</span>
        
        <!-- Hashtags -->
        <span
          v-else-if="part && typeof part === 'object' && part.type === 'hashtag'"
          class="hashtag"
          @click="handleHashtagClick(part.name, $event)"
          :title="`Used ${part.count || 0} times`"
        >#{{ part.name }}</span>

        <!-- Channel references (server chat, Discord-style) -->
        <span
          v-else-if="part && typeof part === 'object' && part.type === 'channel_mention'"
          class="mention channel-mention"
          :title="`Go to #${part.name}`"
          @click="handleChannelMentionClick(part, $event)"
        >#{{ part.name }}</span>
        
        <!-- Custom emojis -->
        <img 
          v-else-if="part && typeof part === 'object' && part.type === 'emoji'"
          class="emoji-icon"
          :class="{ 'single': isSingleEmoji }"
          :src="getEmojiUrl(part.emoji.url, 96)"
          :alt="`:${part.emoji?.name || '?'}:`"
          :title="`:${part.emoji?.name}:`"
          :data-emoji-token="emojiPartToken(part.emoji)"
          draggable="false"
          @error="handleEmojiLoadError"
        />
        
        <!-- URLs (with special handling for images and videos) -->
        <template v-else-if="part && typeof part === 'object' && part.type === 'url'">
          <!-- Image URLs -->
          <div 
            v-if="isImageUrl(part.url) && showsPreview(part)" 
            class="media-container image-container"
          >
            <div class="media-frame">
              <div v-if="!imageLoadedState[part.url]" class="media-skeleton image-skeleton"></div>
              <img
                :src="displayMediaUrl(part.url)"
                @load="handleImageLoad(part.url)"
                @error="onAttachmentMediaError(part.url)"
                @click="$emit('open-lightbox', part.url)"
                v-show="imageLoadedState[part.url]"
                draggable="false"
                class="content-image"
              />
            </div>
          </div>

          <!-- Video URLs -->
          <div 
            v-else-if="isVideoUrl(part.url) && showsPreview(part)" 
            class="media-container video-container"
            :ref="el => bindVideoContainer(partIndex, el)"
          >
            <div class="media-frame">
              <video
                :src="part.url"
                controls
                class="content-video"
                preload="metadata"
                @play="handleVideoPlay"
                @error="onAttachmentMediaError(part.url)"
              ></video>
              <button
                v-if="floatingVideos.canPopOut(partIndex)"
                type="button"
                class="floating-video-popout"
                :title="t('embeds.popOut')"
                :aria-label="t('embeds.popOut')"
                @click.stop="floatingVideos.popOut(partIndex)"
              >
                <Icon name="picture-in-picture" :size="16" />
              </button>
            </div>
          </div>

          <!-- Audio URLs -->
          <div 
            v-else-if="isAudioUrl(part.url) && showsPreview(part)" 
            class="media-container audio-container"
          >
            <audio
              :src="part.url"
              controls
              preload="metadata"
              class="content-audio"
              @error="onAttachmentMediaError(part.url)"
            ></audio>
          </div>

          <!-- Regular URL links -->
          <!-- sanitizeUrl rejects javascript:/data:/etc. and returns "". When empty,
               render as inert text (no <a>) so dangerous URLs can't execute on click. -->
          <a
            v-else-if="sanitizeUrl(part.url)"
            :href="sanitizeUrl(part.url)"
            target="_blank"
            rel="noopener noreferrer"
            class="url-link"
          >{{ part.url }}</a>
          <span
            v-else
            class="url-link url-link--unsafe"
          >{{ part.url }}</span>
          <!-- Media-only embeds (GIF pages: tenor / giphy / klipy). The
               resolved image is the content; render as a direct image URL,
               without link-preview card chrome. -->
          <div
            v-if="embedMedia(part)?.kind === 'image'"
            class="media-container image-container"
          >
            <div class="media-frame">
              <div v-if="!imageLoadedState[embedMedia(part)!.url]" class="media-skeleton image-skeleton"></div>
              <img
                :src="embedMedia(part)!.url"
                @load="handleImageLoad(embedMedia(part)!.url)"
                @click="$emit('open-lightbox', embedMedia(part)!.url)"
                v-show="imageLoadedState[embedMedia(part)!.url]"
                draggable="false"
                class="content-image"
              />
            </div>
          </div>
          <div
            v-else-if="embedMedia(part)?.kind === 'video'"
            class="media-container video-container"
          >
            <div class="media-frame">
              <video
                :src="embedMedia(part)!.url"
                controls
                loop
                muted
                autoplay
                playsinline
                class="content-video"
                preload="metadata"
              ></video>
            </div>
          </div>
          <ProviderEmbedSwitch
            v-else-if="resolveEmbedPayload(part) && !isImageUrl(part.url) && !isVideoUrl(part.url) && !isAudioUrl(part.url)"
            :payload="resolveEmbedPayload(part)!"
            :message-id="messageId"
            :key="`${messageId}-embed-${part.embedId || part.url}`"
            @embed-loaded="handleEmbedLoad"
            @open-lightbox="$emit('open-lightbox', $event)"
          />
        </template>
        
        <template v-else-if="part && typeof part === 'object' && part.type === 'embed'">
          <ProviderEmbedSwitch
            v-if="resolveEmbedPayload(part)"
            :payload="resolveEmbedPayload(part)!"
            :message-id="messageId"
            :key="`${messageId}-embed-${part.previewId || part.url}`"
            @embed-loaded="handleEmbedLoad"
            @open-lightbox="$emit('open-lightbox', $event)"
          />
        </template>
        
        <!-- Image files -->
        <div 
          v-else-if="part && typeof part === 'object' && part.type === 'file' && part.fileType === 'image'" 
          class="media-container image-container"
          :class="{ 'sticker-container': isStickerMedia(part.url), 'ai-emoji-container': isAiEmojiMedia(part.url) }"
          @mouseenter="hoveredImageUrl = part.url"
          @mouseleave="hoveredImageUrl = null"
        >
          <div class="media-frame" :class="{ 'media-spoiler': isHiddenSpoiler(part) }">
            <AttachmentRemoveButton
              v-if="canEditAttachments && !isAnimatedImage(part.url) && !isStickerMedia(part.url)"
              @click="requestRemoveAttachment(part.url)"
            />
            <div v-if="!imageLoadedState[mediaLoadKey(part)]" class="media-skeleton image-skeleton"></div>
            <img
              :src="displayMediaUrl(part)"
              @load="handleImageLoad(mediaLoadKey(part))"
              @error="onAttachmentMediaError(part.url, part, 'thumbnail')"
              @click="!isStickerMedia(part.url) && $emit('open-lightbox', part.url)"
              v-show="imageLoadedState[mediaLoadKey(part)]"
              draggable="false"
              class="content-image"
              :class="{ 'sticker-image': isStickerMedia(part.url), 'ai-emoji-image': isAiEmojiMedia(part.url) }"
            />
            <button
              v-if="isHiddenSpoiler(part)"
              type="button"
              class="media-spoiler-cover"
              :aria-label="t('message.spoiler.reveal')"
              @click.stop="revealMediaSpoiler(part)"
            >{{ t('message.spoiler.label') }}</button>
            <MediaUploadProgress v-if="hasUpload(part)" :path="part.path!" />
            <!-- GIF/sticker Favorite Button (AI emoji are treated as plain emoji: no favorite) -->
            <button
              type="button"
              v-if="(isAnimatedImage(part.url) || isStickerMedia(part.url)) && !isAiEmojiMedia(part.url) && !isPrivateMediaPart(part)"
              class="gif-favorite-button"
              :class="{ 'favorited': isGifFavorited(part.url), 'visible': hoveredImageUrl === part.url || isGifFavorited(part.url) }"
              @click.stop="toggleGifFavorite(part.url)"
              :title="isGifFavorited(part.url) ? 'Remove from favorites' : 'Add to favorites'"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path v-if="isGifFavorited(part.url)" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
                <path v-else d="M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z"/>
              </svg>
            </button>
            <!-- KLIPY attribution watermark (optional; only on Klipy media, on hover; never on AI emoji) -->
            <a
              v-if="showKlipyWatermark && isKlipyMedia(part.url) && !isAiEmojiMedia(part.url)"
              class="klipy-watermark"
              :class="{ 'visible': hoveredImageUrl === part.url }"
              :href="klipyWatermarkHref(part.url)"
              target="_blank"
              rel="noopener noreferrer nofollow"
              @click.stop
              title="via KLIPY"
            >
              <img
                :src="klipyWatermarkLogoUrl"
                alt="KLIPY"
                class="klipy-watermark-logo"
                width="51"
                height="14"
              />
            </a>
          </div>
        </div>

        <!-- Video files -->
        <div 
          v-else-if="part && typeof part === 'object' && part.type === 'file' && part.fileType === 'video'" 
          class="media-container video-container"
          :ref="el => bindVideoContainer(partIndex, el)"
          @mouseenter="hoveredImageUrl = part.url"
          @mouseleave="hoveredImageUrl = null"
        >
          <div class="media-frame" :class="{ 'media-spoiler': isHiddenSpoiler(part) }">
            <AttachmentRemoveButton
              v-if="canEditAttachments && !isKlipyMedia(part.url)"
              @click="requestRemoveAttachment(part.url)"
            />
            <video
              :src="mediaSrc(part)"
              controls
              class="content-video"
              preload="metadata"
              @play="handleVideoPlay"
              @error="onAttachmentMediaError(part.url, part)"
            ></video>
            <button
              v-if="isHiddenSpoiler(part)"
              type="button"
              class="media-spoiler-cover"
              :aria-label="t('message.spoiler.reveal')"
              @click.stop="revealMediaSpoiler(part)"
            >{{ t('message.spoiler.label') }}</button>
            <button
              v-if="floatingVideos.canPopOut(partIndex)"
              type="button"
              class="floating-video-popout"
              :class="{ 'floating-video-popout--inset': canEditAttachments || isKlipyMedia(part.url) }"
              :title="t('embeds.popOut')"
              :aria-label="t('embeds.popOut')"
              @click.stop="floatingVideos.popOut(partIndex)"
            >
              <Icon name="picture-in-picture" :size="16" />
            </button>
            <MediaUploadProgress v-if="hasUpload(part)" :path="part.path!" />
            <!-- Clip favorite button (Klipy clips only) -->
            <button
              type="button"
              v-if="isKlipyMedia(part.url)"
              class="gif-favorite-button"
              :class="{ 'favorited': isGifFavorited(part.url), 'visible': hoveredImageUrl === part.url || isGifFavorited(part.url) }"
              @click.stop="toggleGifFavorite(part.url)"
              :title="isGifFavorited(part.url) ? 'Remove from favorites' : 'Add to favorites'"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path v-if="isGifFavorited(part.url)" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
                <path v-else d="M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z"/>
              </svg>
            </button>
            <a
              v-if="showKlipyWatermark && isKlipyMedia(part.url)"
              class="klipy-watermark"
              :class="{ 'visible': hoveredImageUrl === part.url }"
              :href="klipyWatermarkHref(part.url)"
              target="_blank"
              rel="noopener noreferrer nofollow"
              @click.stop
              title="via KLIPY"
            >
              <img
                :src="klipyWatermarkLogoUrl"
                alt="KLIPY"
                class="klipy-watermark-logo"
                width="51"
                height="14"
              />
            </a>
          </div>
        </div>
        
        <!-- Audio files (voice messages + regular audio) -->
        <div
          v-else-if="part && typeof part === 'object' && part.type === 'file' && part.fileType === 'audio'"
          class="media-container audio-container"
        >
          <AttachmentRemoveButton
            v-if="canEditAttachments"
            @click="requestRemoveAttachment(part.url)"
          />
          <VoiceMessagePlayer
            v-if="metadata?.voice_message"
            :src="mediaSrc(part)"
            :duration="metadata.voice_message.duration || 0"
            :waveform="metadata.voice_message.waveform || []"
          />
          <template v-else>
            <div v-if="part.fileName" class="audio-filename">
              {{ part.fileName }}
            </div>
            <audio
              :src="mediaSrc(part)"
              controls
              preload="metadata"
              class="content-audio"
            ></audio>
          </template>
          <MediaUploadProgress v-if="hasUpload(part)" :path="part.path!" inline />
        </div>
        
        <!-- Other file attachments -->
        <div 
          v-else-if="part && typeof part === 'object' && part.type === 'file' && !['image', 'video'].includes(part.fileType)"
          class="file-attachment"
        >
          <AttachmentRemoveButton
            v-if="canEditAttachments"
            @click="requestRemoveAttachment(part.url)"
          />
          <Icon name="file" :size="20" class="file-icon" />
          <a
            v-if="sanitizeUrl(mediaSrc(part) || '')"
            :href="sanitizeUrl(mediaSrc(part) || '')"
            target="_blank"
            rel="noopener noreferrer"
            class="file-name"
          >
            {{ mediaPartFileName(part) }}
          </a>
          <span v-else class="file-name file-name--unsafe">
            {{ mediaPartFileName(part) }}
          </span>
          <MediaUploadProgress v-if="hasUpload(part)" :path="part.path!" inline />
        </div>
        
        <!-- System messages (join/leave announcements) -->
        <span 
          v-else-if="part && typeof part === 'object' && part.type === 'system'"
          class="system-message-text"
        >
          <template v-if="part.event_type === 'join'">
            Everyone welcome 
            <span 
              class="system-username" 
              @click="$emit('show-user-profile', part.user.id, $event)"
            ><DisplayName :userId="part.user.id" :fallback="part.user.display_name || part.user.username" /></span>!
            <template v-if="part.initiated_by">
              They were invited by 
              <span 
                class="system-username" 
                @click="$emit('show-user-profile', part.initiated_by.id, $event)"
              ><DisplayName :userId="part.initiated_by.id" :fallback="part.initiated_by.display_name || part.initiated_by.username" /></span>.
            </template>
          </template>
          <template v-else-if="part.event_type === 'leave'">
            <span 
              class="system-username" 
              @click="$emit('show-user-profile', part.user.id, $event)"
            ><DisplayName :userId="part.user.id" :fallback="part.user.display_name || part.user.username" /></span> has left the server.
          </template>
          <template v-else>
            <span 
              class="system-username" 
              @click="$emit('show-user-profile', part.user.id, $event)"
            ><DisplayName :userId="part.user.id" :fallback="part.user.display_name || part.user.username" /></span> {{ part.event_type }}
          </template>
        </span>

        <PollCard
          v-else-if="part && typeof part === 'object' && part.type === 'poll'"
          :poll="part"
          :message-id="messageId"
        />
      </template>
    </div>

    <ConfirmationModal
      v-if="removeAttachmentConfirmMounted"
      :show="showRemoveAttachmentConfirm"
      title="Are you sure?"
      message="This will remove this attachment from this message permanently."
      confirm-button-text="Remove attachment"
      @close="cancelRemoveAttachment"
      @confirm="confirmRemoveAttachment"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, watch, ref, nextTick, reactive, onMounted, onUnmounted, computed, shallowRef, effectScope, type EffectScope } from 'vue';
import type { PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import type { EmbedPayload, MessagePart, FileContent } from '@/types';
import { coalesceInlineContentForMarkdown, extractFileParts } from '@/utils/messageContentUtils';
import AutoSuggest from '@/components/AutoSuggest.vue';
import DisplayName from '@/components/DisplayName.vue';
import CodeBlock from '@/components/common/CodeBlock.vue';
import RichTextEditor from '@/components/RichTextEditor.vue';
import VoiceMessagePlayer from '@/components/VoiceMessagePlayer.vue';
import type { SuggestionItem } from '@/components/AutoSuggest.vue';
import { useAutoSuggest } from '@/composables/useAutoSuggest';
import { useFloatingVideo, useFloatingVideoRefs } from '@/composables/useFloatingVideo';
import { userDataService } from '@/services/userDataService';
import { useUserData } from '@/composables/useUserData';
import { mentionDisplayDomain } from '@/utils/mentionGrammar';
import { getEmojiUrl } from '@/utils/emojiUtils';
import { discordEmojiPartText } from '@/utils/discordEmoji';
import EncryptedGlyphPreview from '@/components/encryption/EncryptedGlyphPreview.vue';
import ProviderEmbedSwitch from '@/components/embeds/ProviderEmbedSwitch.vue';
import MessageMediaGallery from '@/components/common/MessageMediaGallery.vue';
import AttachmentRemoveButton from '@/components/common/AttachmentRemoveButton.vue';
import MediaUploadProgress from '@/components/common/MediaUploadProgress.vue';
import Icon from '@/components/common/Icon.vue';
import ConfirmationModal from '@/components/ConfirmationModal.vue';
import PollCard from '@/components/polls/PollCard.vue';
import { groupMediaGalleryParts } from '@/utils/mediaGalleryUtils';
import { undecryptedDisplayParts } from '@/utils/channelEncryption';
import { getAttachmentThumbnailUrl } from '@/utils/storageImageUtils';
import { isPrivateMediaPart, mediaLoadKey, mediaPartFileName, mediaPartSource, reportMediaPartError } from '@/services/privateMedia';
import { messageMediaUploadState } from '@/services/messageMediaUpload';
import {
  isDiscordCdnUrl,
  hasExpiredBridgedAttachment,
  requestAttachmentRefresh,
} from '@/services/attachmentRefresh';
import { parseEmbedUrl, isHarmonyInviteUrl } from '@/utils/embedDetection';
import { useUnifiedEmoji } from '@/services/unifiedEmojiService';
import { gifService } from '@/services/GifService';
import { debug } from '@/utils/debug';
import { sanitizeUrl } from '@/utils/sanitize';
import { isSpoilerFileName } from '@/utils/spoiler';
import { pollPartOf } from '@/utils/messagePoll';
import { renderChatMessageText } from '@/utils/chatMessageTextRenderer';
import { useVisualTheme } from '@/composables/useVisualTheme';
import { BRIDGED_DISCORD_USER_ID_PREFIX } from '@/services/bridgedChannelUsersService';
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings';
import {
  defaultKlipyHomeUrl,
  KLIPY_WATERMARK_LOGO_URL,
  parseKlipyItemPageUrl,
  stripKlipyAttributionFragment,
  isStickerMessageUrl,
  isAiEmojiMessageUrl,
  parseKlipyKind,
} from '@/utils/klipyAttribution';
import { runtimeConfig } from '@/services/runtimeConfig';

export default defineComponent({
  name: 'UnifiedMessageContent',
  components: {
    AutoSuggest,
    DisplayName,
    CodeBlock,
    ProviderEmbedSwitch,
    RichTextEditor,
    VoiceMessagePlayer,
    MessageMediaGallery,
    AttachmentRemoveButton,
    MediaUploadProgress,
    ConfirmationModal,
    EncryptedGlyphPreview,
    Icon,
    PollCard,
  },
  props: {
    content: {
      type: Array as PropType<MessagePart[]>,
      required: true
    },
    editableMessageId: {
      type: String as PropType<string | null>,
      default: null
    },
    messageId: {
      type: String,
      required: true
    },
    imageLoaded: {
      type: Object as PropType<Record<string, boolean>>,
      default: () => ({})
    },
    isSingleEmoji: {
      type: Boolean,
      default: false
    },
    editableContent: {
      type: String,
      default: ''
    },
    isSystem: {
      type: Boolean,
      default: false
    },
    embedPayloads: {
      type: Object as PropType<Record<string, EmbedPayload> | null>,
      default: null
    },
    encrypted: {
      type: Boolean,
      default: false
    },
    decrypted: {
      type: Boolean,
      default: false
    },
    canDecrypt: {
      type: Boolean,
      default: false
    },
    /**
     * Message encrypted with a key that no longer exists; it predates the
     * current encryption identity. Decryption can never succeed, so the UI
     * must not offer a click-to-decrypt retry.
     */
    unrecoverable: {
      type: Boolean,
      default: false
    },
    /**
     * Megolm v2 sender-binding verification result.
     *  - `true`      → signature verified
     *  - `false`     → decrypted, sender not cryptographically verified
     *                  (legacy v1 message, or sender has no signing key)
     *  - `undefined` → not applicable (plaintext / never went through decrypt)
     */
    senderVerified: {
      type: Boolean as PropType<boolean | undefined>,
      default: undefined,
    },
    metadata: {
      type: Object as PropType<Record<string, any> | null>,
      default: null
    },
    canEditAttachments: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:message', 'update:content', 'cancel-edit', 'image-loaded', 'embed-loaded', 'open-lightbox', 'show-user-profile', 'hashtag-click', 'decrypt-message', 'remove-attachment'],
  setup(props, { emit }) {
    const localEditableContent = ref(props.editableContent);
    // Attachments retained while editing. Seeded from the message's file parts
    // when edit mode opens, removable individually, merged back on save.
    const editableFiles = ref<FileContent[]>([]);
    const editRichEditorRef = ref<InstanceType<typeof RichTextEditor> | null>(null);
    const { t } = useI18n();
    const visualTheme = useVisualTheme();
    const decrypting = ref(false);
    const instanceSettings = useInstanceSettingsStore();
    const showKlipyWatermark = computed(
      () => instanceSettings.settings.gifKlipyWatermarkEnabled,
    );

    // Inline attachments render downscaled (local jpg/png only); animated,
    // remote and sticker URLs pass through untouched. The lightbox opens the
    // original. Parts with a `path` resolve through privateMedia.
    const displayMediaUrl = (part: string | { url?: string; path?: string }) =>
      typeof part === 'string'
        ? getAttachmentThumbnailUrl(stripKlipyAttributionFragment(part))
        : mediaPartSource(part, 'thumbnail');
    const mediaSrc = (part: { url?: string; path?: string }) => mediaPartSource(part);
    // A part whose object this client is uploading.
    const hasUpload = (part: { url?: string; path?: string }) =>
      isPrivateMediaPart(part) && !!messageMediaUploadState(part.path);
    const klipyWatermarkHref = (url: string) =>
      sanitizeUrl(parseKlipyItemPageUrl(url)) || defaultKlipyHomeUrl();
    const klipyWatermarkLogoUrl = KLIPY_WATERMARK_LOGO_URL;
    // Stickers render small and inline, with no lightbox or zoom.
    const isStickerMedia = (url: string) => isStickerMessageUrl(url);
    // Klipy AI emoji render as plain emoji: no watermark, no favorite, no lightbox.
    const isAiEmojiMedia = (url: string) => isAiEmojiMessageUrl(url);
    
    // Spoilers: `||text||` spans reveal on click; a file named SPOILER_* (Discord's
    // convention, kept by the bridge) stays covered until clicked.
    const revealedMediaSpoilers = reactive(new Set<string>());
    const isHiddenSpoiler = (part: { fileName?: string; url?: string; path?: string }) =>
      isSpoilerFileName(part.fileName) && !revealedMediaSpoilers.has(part.path || part.url || '');
    const revealMediaSpoiler = (part: { url?: string; path?: string }) => {
      revealedMediaSpoilers.add(part.path || part.url || '');
    };
    const revealTextSpoiler = (event: MouseEvent) => {
      const spoiler = (event.target as HTMLElement | null)?.closest('.md-spoiler');
      if (!spoiler || spoiler.classList.contains('revealed')) return;
      spoiler.classList.add('revealed');
      event.stopPropagation();
    };

    // GIF favorites state
    const hoveredImageUrl = ref<string | null>(null);
    const favoriteGifUrls = ref<Set<string>>(new Set());
    
    const { resolveEmoji, isNativePack, isLoaded: emojiServiceLoaded } = useUnifiedEmoji();

    // Lazy bridged-attachment refresh: when a message carries an expired Discord
    // CDN URL, ask the gateway to re-sign it (only acts when the instance is in
    // 'refresh' mode; coalesced per message). Proactive on render + on load error.
    const maybeRefreshExpiredAttachments = () => {
      if (hasExpiredBridgedAttachment(props.content)) {
        requestAttachmentRefresh(props.messageId);
      }
    };
    const onAttachmentMediaError = (
      url: string,
      part?: { url?: string; path?: string },
      variant: 'original' | 'thumbnail' = 'original',
    ) => {
      if (isDiscordCdnUrl(url)) requestAttachmentRefresh(props.messageId);
      reportMediaPartError(part, variant);
    };
    onMounted(maybeRefreshExpiredAttachments);
    watch(() => props.content, maybeRefreshExpiredAttachments);

    // Mounted on first use: an always-mounted modal costs four component
    // instances per message row.
    const removeAttachmentConfirmMounted = ref(false);
    const showRemoveAttachmentConfirm = ref(false);
    const pendingRemoveAttachmentUrl = ref<string | null>(null);

    const requestRemoveAttachment = async (url: string) => {
      if (!props.canEditAttachments) return;
      pendingRemoveAttachmentUrl.value = url;
      if (!removeAttachmentConfirmMounted.value) {
        // Mounts closed first so the enter transition runs.
        removeAttachmentConfirmMounted.value = true;
        await nextTick();
      }
      showRemoveAttachmentConfirm.value = true;
    };

    const cancelRemoveAttachment = () => {
      showRemoveAttachmentConfirm.value = false;
      pendingRemoveAttachmentUrl.value = null;
    };

    const confirmRemoveAttachment = () => {
      if (!pendingRemoveAttachmentUrl.value) return;
      emit('remove-attachment', props.messageId, pendingRemoveAttachmentUrl.value);
      cancelRemoveAttachment();
    };
    
    // Seeded from the prop, then kept merged by the watcher below.
    const imageLoadedState = reactive<Record<string, boolean>>({ ...props.imageLoaded });

    const { notifyPlaybackStarted } = useFloatingVideo();
    const floatingVideos = useFloatingVideoRefs();
    const bindVideoContainer = (partIndex: number, el: unknown) => {
      floatingVideos.bind(partIndex, el, { type: 'video', messageId: props.messageId });
    };
    
    watch(() => props.imageLoaded, (newValue) => {
      Object.assign(imageLoadedState, newValue);
    }, { deep: true });
    
    const handleImageLoad = (url: string) => {
      imageLoadedState[url] = true;
      emit('image-loaded', url);
    };

    const handleEmojiLoadError = (e: Event) => {
      const img = e.target as HTMLImageElement;
      if (!img) return;
      img.onerror = null;
      img.style.display = 'none';
      const fallback = document.createElement('span');
      fallback.className = 'emoji-icon emoji-fallback';
      fallback.title = img.alt || 'Broken emoji';
      fallback.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="2" y1="2" x2="22" y2="22"/><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/><path d="M21 15V5a2 2 0 0 0-2-2H9"/><path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"/></svg>';
      img.parentNode?.insertBefore(fallback, img);
    };
    
    const handleEmbedLoad = () => {
      emit('embed-loaded');
    };
    
    const handleVideoPlay = (event: Event) => {
      notifyPlaybackStarted(event.target as HTMLElement);
    };
    
    // GIF favorites helpers
    const isAnimatedImage = (url: string): boolean => {
      if (!url) return false;
      const lowerUrl = url.toLowerCase();
      // Extension and known GIF hosts only; animated webp/apng are not detected.
      return lowerUrl.includes('.gif') || 
             lowerUrl.includes('tenor.com') || 
             lowerUrl.includes('giphy.com') ||
             lowerUrl.includes('klipy.com') ||
             lowerUrl.includes('/gif') ||
             false;
    };

    // True for GIFs sourced from Klipy (host-based). Drives the KLIPY
    // attribution watermark, which must only appear on Klipy content.
    const isKlipyMedia = (url: string): boolean => {
      if (!url) return false;
      if (parseKlipyItemPageUrl(url) || isStickerMessageUrl(url)) return true;
      return url.toLowerCase().includes('klipy.com');
    };
    
    const isGifFavorited = (url: string): boolean => {
      return favoriteGifUrls.value.has(stripKlipyAttributionFragment(url));
    };
    
    const toggleGifFavorite = async (url: string) => {
      const mediaUrl = stripKlipyAttributionFragment(url);
      // Route the favorite into its matching media tab (gif/sticker/clip/meme/ai-emoji).
      const mediaType = parseKlipyKind(url);
      const result = await gifService.toggleFavoriteByUrl(mediaUrl, mediaUrl, null, mediaType);
      if (!result.error) {
        if (result.isFavorite) {
          favoriteGifUrls.value.add(mediaUrl);
        } else {
          favoriteGifUrls.value.delete(mediaUrl);
        }
        favoriteGifUrls.value = new Set(favoriteGifUrls.value);
      }
    };
    
    const loadGifFavorites = async () => {
      const favorites = await gifService.getFavorites();
      favoriteGifUrls.value = new Set(favorites.map(f => f.gif_url));
    };
    
    onMounted(() => {
      loadGifFavorites();
    });
    
    const getCurrentText = () => editRichEditorRef.value?.getPlainText?.() ?? localEditableContent.value;
    const updateText = (newText: string, cursorPosition?: number) => {
      localEditableContent.value = newText;
      emit('update:content', newText);
      nextTick(() => {
        const r = editRichEditorRef.value;
        if (r) {
          r.skipNextWatch = true;
          r.renderContent(newText, true);
          nextTick(() => {
            if (r.focus) r.focus();
            if (cursorPosition != null && r.setCursorPosition) r.setCursorPosition(cursorPosition);
          });
        }
      });
    };
    // Edit mode only. An instance carries a useServerPermissions instance and
    // window listeners, so a row creates it on its first edit rather than on
    // mount.
    let autoSuggestScope: EffectScope | null = null;
    const autoSuggest = shallowRef<ReturnType<typeof useAutoSuggest> | null>(null);
    const ensureAutoSuggest = (): ReturnType<typeof useAutoSuggest> => {
      if (!autoSuggest.value) {
        autoSuggestScope = effectScope();
        autoSuggest.value = autoSuggestScope.run(() => useAutoSuggest(editRichEditorRef, getCurrentText, updateText, { mode: 'chat', enableCommands: false }))!;
      }
      return autoSuggest.value;
    };
    // Pre-flush: the instance exists before the edit block renders.
    watch(() => props.editableMessageId === props.messageId, (editing) => {
      if (editing) ensureAutoSuggest();
    }, { immediate: true });
    onUnmounted(() => {
      autoSuggestScope?.stop();
    });

    // Composer text of an emoji part; the document copy handler
    // (utils/emojiClipboard) writes it for the image.
    const emojiPartToken = (emoji: unknown): string | undefined => {
      const discord = discordEmojiPartText(emoji);
      if (discord) return discord;
      const name = (emoji as { name?: unknown } | null)?.name;
      return typeof name === 'string' && name ? `:${name}:` : undefined;
    };

    const isImageUrl = (url: string): boolean => {
      if (!url) return false;
      return /\.(jpg|jpeg|png|gif|webp|bmp|svg)(?:[?#].*)?$/i.test(url);
    };

    const isVideoUrl = (url: string): boolean => {
      if (!url) return false;
      return /\.(mp4|webm|ogg|avi|mov|wmv|flv|m4v)(?:[?#].*)?$/i.test(url);
    };

    // metadata.suppress_embeds (set_message_embeds_suppressed) hides every preview and inline
    // media of the message; its links render as <url> parts do.
    const embedsSuppressed = computed(() => props.metadata?.suppress_embeds === true);
    const showsPreview = (part: MessagePart): boolean => {
      const preview = (part as { preview?: unknown }).preview;
      return preview !== false && preview !== 'false';
    };

    // An undecrypted message renders its ciphertext part alone: the mention
    // parts stored beside it are server metadata, not message content. A poll
    // renders its card alone: the text part beside it spells the poll out for
    // text-only readers.
    const displayContent = computed(() =>
      props.encrypted && !props.decrypted
        ? undecryptedDisplayParts(props.content)
        : pollPartOf(props.content)
        ? props.content.filter((part) => part && typeof part === 'object' && part.type === 'poll')
        : groupMediaGalleryParts(
            coalesceInlineContentForMarkdown(
              embedsSuppressed.value
                ? props.content.map((part) =>
                    part && typeof part === 'object' && part.type === 'url' ? { ...part, preview: false } : part)
                : props.content,
              (url) => isImageUrl(url) || isVideoUrl(url),
            ),
          ),
    );

    const isAudioUrl = (url: string): boolean => {
      if (!url) return false;
      return /\.(mp3|wav|ogg|flac|aac|m4a|opus|webm)(?:[?#].*)?$/i.test(url);
    };

    const formatFileSize = (bytes: number): string => {
      if (bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const resolveEmbedPayload = (part: MessagePart): EmbedPayload | null => {
      if (embedsSuppressed.value) return null;
      if (part && typeof part === 'object' && part.type === 'url' && !showsPreview(part)) {
        return null;
      }

      const embeds = props.embedPayloads;

      if (embeds && part && typeof part === 'object') {
        if (part.type === 'embed' && part.previewId) {
          const found = embeds[part.previewId];
          if (found) return found;
        }

        if (part.type === 'url' && part.embedId) {
          const found = embeds[part.embedId];
          if (found) return found;
        }
      }

      if (part && typeof part === 'object' && 'url' in part && part.url) {
        const parsed = parseEmbedUrl(part.url);
        if (parsed && isHarmonyInviteUrl(parsed)) {
          return {
            cacheKey: `invite-${part.url}`,
            url: part.url,
            normalizedUrl: part.url,
            provider: 'harmony-invite',
            fetchedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          };
        }
      }

      return null;
    };

    /**
     * Renders an embed as media instead of a link card when the resolved media
     * is the content (GIF pages: klipy / tenor / giphy).
     *
     * Decided from the media file extension, not only the backend's mediaOnly
     * flag: embeds persist in message metadata and are cached 24h server-side,
     * so already-stored payloads and hosts unknown to the backend heuristic
     * still upgrade to media rendering.
     */
    const embedMedia = (part: MessagePart): { kind: 'image' | 'video'; url: string } | null => {
      const payload = resolveEmbedPayload(part);
      const media = payload?.image;
      if (!media) return null;

      if (/\.(mp4|webm|mov)(\?|#|$)/i.test(media)) return { kind: 'video', url: media };
      if (payload.mediaOnly || /\.gif(\?|#|$)/i.test(media)) return { kind: 'image', url: media };
      return null;
    };

    const formatMentionDisplay = (mentionPart: any): string => {
      try {
        if (mentionPart.isLocal) {
          return `@${mentionPart.username}`;
        } else if (mentionPart.domain === 'discord.com' || mentionPart.isBridged) {
          // Bridged Discord users show @username; the platform icon comes from CSS.
          return `@${mentionPart.username}`;
        } else {
          return `@${mentionPart.username}@${mentionPart.domain}`;
        }
      } catch (error) {
        debug.error('Error formatting mention display:', error, { mentionPart });
        if (mentionPart.mention) {
          return formatLegacyMentionDisplay(mentionPart.mention, mentionPart.userId);
        }
        return '@unknown';
      }
    };

    // storedMention format: @uuid@domain. Displayed as @username for local
    // users, @username@domain for remote.
    const formatLegacyMentionDisplay = (storedMention: string, userId: string): string => {
      
      try {
        const mentionMatch = storedMention.match(/^@([^@]+)@(.+)$/);
        if (!mentionMatch) {
          return storedMention;
        }
        
        const [, , domain] = mentionMatch;
        
        const userProfile = userDataService.getUserProfile(userId);
        
        if (userProfile) {
          if (userProfile.isLocal) {
            return `@${userProfile.username}`;
          } else {
            return `@${userProfile.username}@${userProfile.domain || domain}`;
          }
        } else {
          // Profile not cached: fall back to the stored form.
          return storedMention;
        }
      } catch (error) {
        debug.error('Error formatting legacy mention display:', error, { storedMention, userId });
        return storedMention;
      }
    };

    // Wrapper around the pure renderer in `chatMessageTextRenderer.ts`.
    // XSS-relevant logic lives there so it can be tested in isolation;
    // this supplies the component's reactive emoji and theme state.
    const renderTextContent = (text: string) =>
      renderChatMessageText(text, {
        isNativePack: isNativePack.value,
        emojiServiceLoaded: emojiServiceLoaded.value,
        resolveEmoji,
        isSingleEmoji: props.isSingleEmoji,
        greentextEnabled: visualTheme.currentSettings.value.greentextEnabled !== false,
        convertEmoticons: visualTheme.currentSettings.value.renderEmoticonsAsEmoji !== false,
      });

    // Splits rendered text on code-block placeholders, interleaving CodeBlock segments.
    const renderTextSegments = (text: string) => {
      const { renderedText, codeBlocks } = renderTextContent(text);
      const segments: Array<{type: 'text' | 'codeblock'; content?: string; code?: string; language?: string}> = [];
      
      if (codeBlocks.length === 0) {
        segments.push({ type: 'text', content: renderedText });
        return segments;
      }
      
      let remainingText = renderedText;
      
      codeBlocks.forEach((codeBlock) => {
        const placeholder = codeBlock.id;
        const placeholderIndex = remainingText.indexOf(placeholder);
        
        if (placeholderIndex !== -1) {
          const beforeText = remainingText.substring(0, placeholderIndex);
          if (beforeText) {
            segments.push({ type: 'text', content: beforeText });
          }
          
          segments.push({ 
            type: 'codeblock', 
            code: codeBlock.code, 
            language: codeBlock.language 
          });
          
          remainingText = remainingText.substring(placeholderIndex + placeholder.length);
        }
      });
      
      if (remainingText) {
        segments.push({ type: 'text', content: remainingText });
      }
      
      return segments;
    };

    watch(() => props.editableContent, (newVal) => {
      // Guard against a write-back loop through the editor.
      if (newVal !== localEditableContent.value) {
        localEditableContent.value = newVal;
      }
      nextTick(() => {
        if (editRichEditorRef.value && props.editableMessageId === props.messageId) {
          autoResizeEditArea();
        }
      });
    });

    // Cursor goes to end of text when edit mode opens. setTimeout(0) runs
    // after all microtasks (Vue nextTicks, RichTextEditor's onMounted
    // renderContent, its internal nextTick cursor restore), so this
    // setCursorPosition applies last.
    watch(() => props.editableMessageId, (newVal) => {
      if (newVal === props.messageId) {
        // Snapshot the message's current attachments into the editable list.
        editableFiles.value = extractFileParts(props.content);
        setTimeout(() => {
          const r = editRichEditorRef.value;
          if (r) {
            autoResizeEditArea();
            if (r.focus) r.focus();
            const len = localEditableContent.value.length;
            if (r.setCursorPosition) r.setCursorPosition(len);
          }
        }, 0);
      } else {
        editableFiles.value = [];
      }
    });

    const removeEditFile = (index: number) => {
      editableFiles.value = editableFiles.value.filter((_, i) => i !== index);
    };

    const isEditFileImage = (file: FileContent): boolean => {
      return file.fileType === 'image' || /\.(jpg|jpeg|png|gif|webp|bmp|svg)(?:[?#].*)?$/i.test(file.url || '');
    };

    const isEditFileVideo = (file: FileContent): boolean => {
      return file.fileType === 'video' || /\.(mp4|webm|mov|m4v)(?:[?#].*)?$/i.test(file.url || '');
    };

    const autoResizeEditArea = () => {
      // RichTextEditor handles its own height; no-op for edit mode
    };

    const handleRichEditorUpdate = (value: string) => {
      localEditableContent.value = value;
      emit('update:content', value);
    };

    // Mirrors MessageInput.handleCursorPositionChanged. The editor emits the
    // caret offset before it re-renders formatted text; a caret read after
    // that re-render sees the rebuilt DOM without a selection.
    const handleEditCursorPositionChanged = (position: number) => {
      const text = editRichEditorRef.value?.getPlainText?.() ?? localEditableContent.value;
      ensureAutoSuggest().handleInput(text, position);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const suggest = ensureAutoSuggest();
      // Auto-suggest claims keys first. Escape with the popup open closes the
      // popup only; the edit stays open.
      if (suggest.handleKeyDown(event)) {
        if (event.key === 'Escape') event.stopPropagation();
        return;
      }
      
      if (event.key === 'Enter' && !event.shiftKey) {
        if (!suggest.state.value.isActive) {
          event.preventDefault();
          handleSaveEdit();
        }
        return;
      }
      
      if (event.key === 'Escape') {
        event.preventDefault();
        handleCancelEdit();
        return;
      }
    };

    const handleSuggestionSelect = (suggestion: SuggestionItem) => {
      if (!editRichEditorRef.value) return;
      const suggest = ensureAutoSuggest();
      const newValue = suggest.selectSuggestion(suggestion);
      if (newValue !== localEditableContent.value) {
        const cursorPosition = suggest.state.value.triggerPosition + (suggestion.insertText?.length ?? 0);
        updateText(newValue, cursorPosition);
      }
    };

    const handleSaveEdit = () => {
      autoSuggest.value?.closeSuggestions();
      
      const content = localEditableContent.value.trim();

      // File-only messages are valid. Cancel only when nothing would remain.
      if (!content && editableFiles.value.length === 0) {
        handleCancelEdit();
        return;
      }
      
      try {
        emit('update:message', props.messageId, content, [...editableFiles.value]);
      } catch (e) {
        debug.error('Error in handleSaveEdit:', e);
      }
    };

    const handleCancelEdit = () => {
      autoSuggest.value?.closeSuggestions();
      emit('cancel-edit');
    };

    const handleHashtagClick = (hashtag: string, event: MouseEvent) => {
      event.stopPropagation();
      debug.log('Hashtag clicked:', hashtag);
      emit('hashtag-click', hashtag);
    };

    const handleChannelMentionClick = async (part: any, event: MouseEvent) => {
      event.stopPropagation();
      if (!part?.channelId || !part?.serverId) return;
      const { default: router } = await import('@/router');
      router.push({
        name: 'ChatChannel',
        params: { serverId: part.serverId, channelId: part.channelId },
        // Share-link references jump to the exact message (ChatView watches
        // the messageId query param).
        query: part.messageId ? { messageId: part.messageId } : undefined,
      });
    };
    
    const isBridgedMention = (part: any): boolean => {
      return part?.isBridged || part?.domain === 'discord.com';
    };
    
    const { getUser } = useUserData();
    const mentionSuffix = (part: any): string | null => {
      const user = part?.userId ? getUser(part.userId).value : null;
      return mentionDisplayDomain(
        part,
        user ? { domain: user.domain, isLocal: user.isLocal } : null,
        runtimeConfig.domain as string,
      );
    };

    const getMentionTooltip = (part: any): string => {
      if (part?.domain === 'discord.com') {
        return `Discord user: ${part.username}`;
      }
      const suffix = mentionSuffix(part);
      if (suffix) {
        return `@${part.username}@${suffix}`;
      }
      return part?.username || '';
    };
    
    const handleMentionClick = (part: any, event: MouseEvent) => {
      event.stopPropagation();

      if (isBridgedMention(part)) {
        emit('show-user-profile', `${BRIDGED_DISCORD_USER_ID_PREFIX}${part.userId}`, event);
        return;
      }

      // Local profile already cached: pass UUID.
      if (part.userId) {
        emit('show-user-profile', part.userId, event);
        return;
      }

      // Federated user we don't know yet: pass the handle so MessageDisplay
      // can resolve it via activityPubService.getUserByHandle.
      if (part.username) {
        const handle = part.domain
          ? `${part.username}@${part.domain}`
          : part.username;
        emit('show-user-profile', handle, event);
      }
    };

    // Stops the spinner once the parent's decrypt attempt settles, success or
    // failure. The 5s timeout below covers paths that never fire the event.
    const handleDecryptFinished = (event: Event) => {
      const detail = (event as CustomEvent).detail as { messageId?: string } | undefined;
      if (detail?.messageId === props.messageId) {
        decrypting.value = false;
      }
    };
    onMounted(() => {
      window.addEventListener('harmony-decrypt-finished', handleDecryptFinished);
    });
    onUnmounted(() => {
      window.removeEventListener('harmony-decrypt-finished', handleDecryptFinished);
    });

    const handleDecryptClick = (event: MouseEvent) => {
      event.stopPropagation();
      if (decrypting.value) return;

      debug.log('Click to decrypt message:', props.messageId);
      decrypting.value = true;

      emit('decrypt-message', props.messageId);

      // Fallback reset (in case the finished event never fires)
      setTimeout(() => {
        decrypting.value = false;
      }, 5000);
    };

    return {
      isHiddenSpoiler,
      revealMediaSpoiler,
      revealTextSpoiler,
      displayContent,
      onAttachmentMediaError,
      getEmojiUrl,
      localEditableContent,
      editableFiles,
      removeEditFile,
      isEditFileImage,
      isEditFileVideo,
      editRichEditorRef,
      t,
      floatingVideos,
      bindVideoContainer,
      handleSaveEdit,
      handleCancelEdit,
      handleKeyDown,
      handleRichEditorUpdate,
      handleEditCursorPositionChanged,
      emojiPartToken,
      autoResizeEditArea,
      autoSuggest,
      handleSuggestionSelect,
      imageLoadedState,
      handleImageLoad,
      handleEmojiLoadError,
      handleEmbedLoad,
      handleVideoPlay,
      isImageUrl,
      isVideoUrl,
      showsPreview,
      isAudioUrl,
      sanitizeUrl,
      formatFileSize,
      formatMentionDisplay,
      renderTextContent,
      renderTextSegments,
      handleHashtagClick,
      handleChannelMentionClick,
      handleMentionClick,
      isBridgedMention,
      mentionSuffix,
      getMentionTooltip,
      resolveEmbedPayload,
      embedMedia,
      decrypting,
      handleDecryptClick,
      // GIF favorites
      hoveredImageUrl,
      isAnimatedImage,
      isKlipyMedia,
      showKlipyWatermark,
      displayMediaUrl,
      mediaSrc,
      mediaLoadKey,
      hasUpload,
      mediaPartFileName,
      isPrivateMediaPart,
      klipyWatermarkHref,
      klipyWatermarkLogoUrl,
      isStickerMedia,
      isAiEmojiMedia,
      isGifFavorited,
      toggleGifFavorite,
      requestRemoveAttachment,
      showRemoveAttachmentConfirm,
      removeAttachmentConfirmMounted,
      cancelRemoveAttachment,
      confirmRemoveAttachment,
    };
  }
});
</script>

<style scoped>
.unified-content {
  line-height: 1.375;
  word-wrap: break-word;
  overflow-wrap: break-word;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
  display: inline;
}

/* Display mode container */
.content-display {
  display: inline;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

/* Unverified-author badge: shown when a decrypted message lacks a verifiable
 * sender signature (Megolm v2 sender binding). Inline, so it sits beside the
 * message content without disrupting layout. */
.unverified-author-badge {
  display: inline-block;
  margin-right: 6px;
  padding: 0 6px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border: 1px dashed color-mix(in srgb, var(--warning) 55%, transparent);
  border-radius: 3px;
  cursor: help;
  vertical-align: 1px;
}

/* Text content styling */
.text-content {
  color: var(--text-primary);
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

.text-content :deep(.md-bold) {
  font-weight: bold;
  color: var(--text-primary);
}

.text-content :deep(.md-italic) {
  font-style: italic;
}

.text-content :deep(.md-strikethrough) {
  text-decoration: line-through;
  opacity: 0.6;
}

.text-content :deep(.md-underline) {
  text-decoration: underline;
}

/* Covered until clicked; text and inline emoji stay invisible. */
.text-content :deep(.md-spoiler) {
  background: var(--text-primary);
  color: transparent;
  border-radius: 3px;
  padding: 0 2px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}

.text-content :deep(.md-spoiler:not(.revealed) img),
.text-content :deep(.md-spoiler:not(.revealed) .md-code) {
  visibility: hidden;
}

.text-content :deep(.md-spoiler.revealed) {
  background: var(--background-modifier-hover, rgba(127, 127, 127, 0.18));
  color: inherit;
  cursor: text;
}

.text-content :deep(.md-code) {
  background-color: var(--background-tertiary);
  border-radius: 3px;
  padding: 2px 4px;
  font-family: 'Monaco', 'Consolas', 'Courier New', monospace;
  font-size: 0.85em;
}

.text-content :deep(.md-blockquote) {
  border-left: 4px solid var(--text-muted);
  padding: 2px 0 2px 12px;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
  margin: 2px 0;
  color: var(--text-secondary);
}

.text-content :deep(.md-blockquote + .md-blockquote),
.text-content :deep(.md-blockquote br + .md-blockquote) {
  margin-top: 0;
}

.text-content :deep(.md-greentext) {
  color: #789922;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

/* Code blocks are handled by the CodeBlock component */

/* URL links */
.url-link {
  color: var(--harmony-primary);
  text-decoration: none;
  overflow-wrap: anywhere;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

.url-link:hover {
  text-decoration: underline;
}

/* User mentions */
.mention {
  background-color: var(--harmony-primary-alpha);
  border-radius: 3px;
  padding: 0 2px;
  font-weight: 500;
  cursor: pointer;
  color: var(--harmony-primary);
  display: inline-block;
  transition: background-color 0.2s ease;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

.mention:hover {
  background-color: var(--harmony-primary);
  color: var(--text-on-primary);
}

.role-mention {
  font-weight: 600;
  cursor: default;
}

.role-mention:hover {
  filter: brightness(1.15);
  background-color: unset;
}

/* Hashtag styling */
.hashtag {
  background-color: var(--harmony-primary-alpha);
  border-radius: 3px;
  padding: 0 2px;
  cursor: pointer;
  font-weight: 500;
  color: var(--harmony-primary);
  display: inline-block;
  transition: background-color 0.2s ease;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

.hashtag:hover {
  background-color: var(--harmony-primary);
  color: var(--text-on-primary);
}

/* Emoji styling */
.emoji-icon,
:deep(.inline-emoji) {
  width: auto;
  max-width: 120px;
  height: 24px;
  vertical-align: middle;
  margin: 0 1px;
}

.emoji-icon.single,
:deep(.inline-emoji.single) {
  height: 64px;
  max-width: 64px;
}

.emoji-fallback,
:deep(.emoji-fallback) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  vertical-align: middle;
  color: var(--text-muted);
  opacity: 0.5;
}

.emoji-fallback svg,
:deep(.emoji-fallback svg) {
  width: 100%;
  height: 100%;
}

:deep(.native-emoji.single) {
  font-size: 3em;
  line-height: 3.5rem;
}

/* Media containers: block line-break in inline message flow; inner frame shrink-wraps for overlays */
.media-container {
  display: block;
  margin: 4px 0;
  max-width: 100%;
}

.media-frame {
  display: inline-block;
  position: relative;
  max-width: min(400px, 100%);
  vertical-align: top;
}

.media-frame.media-spoiler {
  overflow: hidden;
  border-radius: 8px;
}

.media-frame.media-spoiler img,
.media-frame.media-spoiler video {
  filter: blur(44px);
  pointer-events: none;
}

.media-spoiler-cover {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: rgba(0, 0, 0, 0.35);
  color: #fff;
  font-weight: 700;
  font-size: 0.8rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
}

.image-container {
  max-width: 100%;
}

.content-image {
  display: block;
  width: auto;
  max-width: min(400px, 100%);
  height: auto;
  max-height: 300px;
  border-radius: 8px;
  cursor: pointer;
}

/* Stickers render small and inline with no lightbox affordance or hover zoom. */
.sticker-container .media-frame {
  max-width: 160px;
}

.sticker-image {
  max-width: 160px;
  max-height: 160px;
  border-radius: 0;
  cursor: default;
}

/* Klipy AI emoji render at jumbo-emoji size, like a single custom emoji. */
.ai-emoji-container .media-frame {
  max-width: 64px;
}

.ai-emoji-image {
  max-width: 64px;
  max-height: 64px;
  border-radius: 0;
  cursor: default;
}

/* GIF Favorite Button */
.gif-favorite-button {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 28px;
  height: 28px;
  box-sizing: border-box;
  background: rgba(0, 0, 0, 0.5);
  border: none;
  padding: 0;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
  transition: all 0.15s ease;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  z-index: 10;
  pointer-events: none;
}

.gif-favorite-button.visible {
  opacity: 1;
  pointer-events: auto;
}

.gif-favorite-button:hover {
  background: rgba(0, 0, 0, 0.9);
}

.gif-favorite-button.favorited {
  color: var(--warning);
}

/* KLIPY attribution watermark - official logo, fades in on hover */
.klipy-watermark {
  position: absolute;
  bottom: 8px;
  left: 8px;
  display: block;
  line-height: 0;
  text-decoration: none;
  opacity: 0;
  transition: opacity 0.15s ease;
  pointer-events: none;
  z-index: 10;
  user-select: none;
}

.klipy-watermark-logo {
  display: block;
  height: 14px;
  width: auto;
}

.klipy-watermark.visible {
  opacity: 0.85;
  pointer-events: auto;
}

.klipy-watermark:hover {
  opacity: 1;
}

.video-container {
  max-width: 100%;
}

.content-video {
  display: block;
  width: auto;
  max-width: min(400px, 100%);
  height: auto;
  max-height: 300px;
  border-radius: 8px;
  background-color: #000;
}

/* Media skeletons */
.media-skeleton {
  border-radius: 8px;
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

.image-skeleton {
  display: block;
  width: 200px;
  height: 150px;
}

@keyframes skeleton-shimmer {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: -100% 0;
  }
}

/* File attachments */
.file-attachment {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background-color: var(--background-tertiary);
  border-radius: 8px;
  margin: 4px 0;
  max-width: 400px;
}

.audio-container {
  position: relative;
}

.file-icon {
  flex-shrink: 0;
  color: var(--text-secondary);
}

.file-name {
  color: var(--harmony-primary);
  text-decoration: none;
  font-weight: 500;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

.file-name:hover {
  text-decoration: underline;
}

.file-size {
  color: var(--text-secondary);
  font-size: 0.875rem;
  white-space: nowrap;
}

/* Edit interface styles */
.edit-container {
  width: 100%;
}

.edit-textarea {
  width: 100%;
  min-height: 40px;
  max-height: 200px;
  padding: 8px 12px;
  border: 1px solid var(--border-color);  
  border-radius: 8px;
  background-color: var(--background-secondary-alpha);
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.375;
  resize: none;
  outline: none;
  box-sizing: border-box;
  overflow-y: auto;
  transition: border-color 0.15s ease-in-out;
}

.edit-textarea:focus {
  border-color: var(--harmony-primary);
  background-color: var(--background-tertiary-alpha);
}

.edit-textarea::placeholder {
  color: var(--text-secondary);
}

.edit-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.edit-attachment {
  position: relative;
  width: 72px;
  height: 72px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border-color);
  background-color: var(--background-tertiary);
  flex-shrink: 0;
}

.edit-attachment-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.edit-attachment-file {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 4px;
  color: var(--text-secondary);
}

.edit-attachment-name {
  font-size: 10px;
  line-height: 1.2;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.edit-attachment-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background-color: rgba(0, 0, 0, 0.65);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease, background-color 0.12s ease;
}

.edit-attachment:hover .edit-attachment-remove {
  opacity: 1;
}

.edit-attachment-remove:hover {
  background-color: var(--error);
}

/* Touch devices: remove button is always visible (no hover). */
@media (hover: none) {
  .edit-attachment-remove {
    opacity: 1;
  }
}

.edit-actions {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.edit-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.edit-action {
  color: var(--harmony-primary);
  cursor: pointer;
  font-weight: 500;
}

.edit-action:hover {
  text-decoration: underline;
}

@media (max-width: 768px) {
  .media-frame {
    max-width: 100%;
  }

  .content-image,
  .content-video {
    max-width: 100%;
  }
}

/* System message specific styling */
.system-message-text {
  color: var(--text-secondary);
  font-style: italic;
  font-size: 14px;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

.system-message-content .system-message-text {
  color: inherit;
}

.system-username {
  font-weight: bold;
  color: var(--text-primary);
  cursor: pointer;
  transition: color 0.2s ease;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

.system-username:hover {
  color: var(--harmony-primary);
  text-decoration: underline;
}

/* Mention styling */
.mention {
  color: var(--harmony-primary);
  background-color: var(--harmony-primary-alpha);
  border-radius: 3px;
  padding: 0 2px;
  cursor: pointer;
  font-weight: 500;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
  transition: background-color 0.2s ease;
}

.mention:hover {
  background-color: var(--harmony-primary-alpha-strong);
  text-decoration: underline;
}

.mention .mention-domain {
  opacity: 0.7;
  margin-left: 1px;
}

/* Discord bridged mentions - Discord blurple #5865F2 */
.mention.discord-mention {
  background-color: rgba(88, 101, 242, 0.2);
  padding: 0 4px;
}

.mention.federated-mention::after {
  content: '';
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-left: 3px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%2310b981' d='M17.9%2C17.39C17.64%2C16.59 16.89%2C16 16%2C16H15V13A1%2C1 0 0%2C0 14%2C12H8V10H10A1%2C1 0 0%2C0 11%2C9V7H13A2%2C2 0 0%2C0 15%2C5V4.59C17.93%2C5.77 20%2C8.64 20%2C12C20%2C14.08 19.2%2C15.97 17.9%2C17.39M11%2C19.93C7.05%2C19.44 4%2C16.08 4%2C12C4%2C11.38 4.08%2C10.79 4.21%2C10.21L9%2C15V16A2%2C2 0 0%2C0 11%2C18M12%2C2A10%2C10 0 0%2C0 2%2C12A10%2C10 0 0%2C0 12%2C22A10%2C10 0 0%2C0 22%2C12A10%2C10 0 0%2C0 12%2C2Z'/%3E%3C/svg%3E");
  background-size: contain;
  background-repeat: no-repeat;
  vertical-align: middle;
}

.mention.discord-mention::after {
  content: '';
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-left: 3px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 127.14 96.36'%3E%3Cpath fill='%235865f2' d='M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z'/%3E%3C/svg%3E");
  background-size: contain;
  background-repeat: no-repeat;
  vertical-align: middle;
}

.mention.bridged-mention:not(.discord-mention) {
  background-color: rgba(150, 100, 200, 0.2);
  border-left: 2px solid #9664c8;
  padding-left: 4px;
}

/* Encrypted glyph styles live in design-system.css */

.audio-filename {
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin-bottom: 6px;
  font-weight: 500;
}

/* Permanently unrecoverable message: encrypted with a key that no longer
   exists. Muted, lock-prefixed, and not clickable - retrying can never
   succeed. */
.encrypted-unrecoverable {
  cursor: not-allowed;
  opacity: 0.55;
}

.encrypted-unrecoverable .unrecoverable-lock {
  margin-right: 4px;
  opacity: 0.8;
}
</style>
