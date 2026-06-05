/**
 * useComposerActions - Shared actions for ActivityPub post composer
 * 
 * Handles emoji/GIF insertion, media uploads, content parsing,
 * and submission logic for the composer.
 */

import { nextTick, type Ref } from 'vue';
import type { MediaAttachment, Post } from '@/types';
import { useActivityPubStore } from '@/stores/useActivityPub';
import type RichTextEditor from '@/components/RichTextEditor.vue';
import { debug } from '@/utils/debug'
import { getEmojiShortcodeForInsert } from '@/services/emojiShortcodeResolver'
import { i18n } from '@/i18n'

export interface ComposerActionsOptions {
  content: Ref<string>;
  richEditorRef: Ref<InstanceType<typeof RichTextEditor> | undefined>;
  showEmojiPicker: Ref<boolean>;
  showGiphyPicker: Ref<boolean>;
  mediaAttachments: Ref<MediaAttachment[]>;
  canAddMedia: Ref<boolean>;
  onContentUpdate?: (content: string) => void;
}

export function useComposerActions(options: ComposerActionsOptions) {
  const activityPubStore = useActivityPubStore();

  /**
   * Insert emoji at cursor position or append to content
   */
  const insertEmoji = (emoji: any) => {
    const richEditor = options.richEditorRef.value;
    const emojiText = getEmojiShortcodeForInsert(emoji);

    if (!richEditor) {
      options.content.value += emojiText;
      options.onContentUpdate?.(options.content.value);
      return;
    }

    const cursorPos = richEditor.getCursorPosition?.() ?? options.content.value.length;
    const before = options.content.value.substring(0, cursorPos);
    const after = options.content.value.substring(cursorPos);
    const newContent = before + emojiText + after;
    const newCursorPos = cursorPos + emojiText.length;

    richEditor.skipNextWatch = true;
    options.content.value = newContent;
    options.onContentUpdate?.(newContent);

    nextTick(() => {
      if (richEditor.renderContent) {
        richEditor.renderContent(newContent, true);
      }

      nextTick(() => {
        richEditor.focus?.();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            richEditor.setCursorPosition?.(newCursorPos);
          });
        });
      });
    });
  };

  /**
   * Insert GIF URL into content
   */
  const insertGif = (gif: any) => {
    const gifUrl = gif.media_formats?.gif?.url;
    if (!gifUrl) return;
    const currentContent = options.content.value;
    
    options.content.value = currentContent + (currentContent ? '\n' : '') + gifUrl;
    options.onContentUpdate?.(options.content.value);
    
    nextTick(() => {
      const richEditor = options.richEditorRef.value;
      if (richEditor?.focus) {
        richEditor.focus();
      }
    });
  };

  /**
   * Handle file selection and create media attachments
   */
  const handleFileUpload = async (event: Event) => {
    const files = (event.target as HTMLInputElement).files;
    if (!files) return;

    for (const file of Array.from(files)) {
      if (!options.canAddMedia.value) {
        debug.warn('Maximum media attachments reached');
        break;
      }

      if (file.type.startsWith('image/') || file.type.startsWith('video/')) {
        const previewUrl = URL.createObjectURL(file);
        const attachment: MediaAttachment = {
          id: `temp_${Date.now()}_${Math.random()}`,
          type: file.type.startsWith('image/') ? 'image' : 'video',
          url: previewUrl,
          preview_url: previewUrl,
          filename: file.name,
          size: file.size,
          description: undefined,
          file: file
        };

        options.mediaAttachments.value.push(attachment);
      }
    }

    // Clear the input
    (event.target as HTMLInputElement).value = '';
  };

  /**
   * Handle paste events to support image and video pasting
   */
  const handlePaste = (event: ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) {
      return;
    }

    const isVideoMime = (t: string) => {
      return t.startsWith('video/') || /^video\//i.test(t);
    };
    const isImageMime = (t: string) => {
      return t.startsWith('image/') || /^image\//i.test(t);
    };
    const isVideoByExt = (name: string) => {
      return /\.(mp4|webm|ogg|avi|mov|m4v|mkv|ogv)(\?|$)/i.test(name || '');
    };
    const isImageByExt = (name: string) => {
      return /\.(jpe?g|png|gif|webp|avif|bmp|ico)(\?|$)/i.test(name || '');
    };

    for (const item of Array.from(items)) {
      if (item.kind !== 'file') {
        continue;
      }
      const file = item.getAsFile();
      if (!file || !options.canAddMedia.value) {
        continue;
      }

      const mime = (item.type || file.type || '').toLowerCase();
      const name = file.name || '';
      const asImage = isImageMime(mime) || isImageByExt(name);
      const asVideo = isVideoMime(mime) || isVideoByExt(name);

      if (asImage || asVideo) {
        const previewUrl = URL.createObjectURL(file);
        const attachment: MediaAttachment = {
          id: `temp_${Date.now()}_${Math.random()}`,
          type: asVideo ? 'video' : 'image',
          url: previewUrl,
          preview_url: previewUrl,
          filename: file.name,
          size: file.size,
          description: undefined,
          file: file
        };

        options.mediaAttachments.value.push(attachment);
      }
    }
  };


  /**
   * Parse content and create post
   */
  const submitPost = async (
    visibility: Post['visibility'],
    contentWarning: string,
    isSensitive: boolean,
    replyToId?: string
  ) => {
    try {
      debug.log('[DEBUG] submitPost: Starting...');
      
      // Parse content to MessageParts using unified system
      const { 
        parseContentToMessageParts, 
        resolveMentionsUserData, 
        resolveEmojisData, 
        resolveHashtagsData 
      } = await import('@/utils/unifiedContentProcessing');
      
      debug.log('[DEBUG] submitPost: Content processing imported');
      
      const rawContent = options.content.value.trim();
      debug.log('[DEBUG] submitPost: Raw content:', rawContent.substring(0, 50));
      
      // Resolve all content data in parallel
      debug.log('[DEBUG] submitPost: Resolving content data...');
      const [usernameToUserDataMap, emojiDataMap, hashtagDataMap] = await Promise.all([
        resolveMentionsUserData(rawContent),
        resolveEmojisData(rawContent),
        resolveHashtagsData(rawContent)
      ]);
      debug.log('[DEBUG] submitPost: Content data resolved');
      
      // Parse to MessageParts
      debug.log('[DEBUG] submitPost: Parsing to MessageParts...');
      const parsedContent = await parseContentToMessageParts(
        rawContent, 
        usernameToUserDataMap, 
        emojiDataMap, 
        hashtagDataMap
      );
      debug.log('[DEBUG] submitPost: Parsed content:', parsedContent.length, 'parts');

      // A "direct" post is delivered only to mentioned users. Posting one with
      // zero mentions has no recipients - block it here so we never create an
      // undeliverable post (which previously triggered federation retry churn).
      if (visibility === 'direct') {
        const hasMention = Array.isArray(parsedContent)
          && parsedContent.some((part: any) => part?.type === 'mention');
        if (!hasMention) {
          throw new Error(i18n.global.t('activitypub.directRequiresMention'));
        }
      }

      // Create post via store
      debug.log('[DEBUG] submitPost: Calling store.createPost...');
      const post = await activityPubStore.createPost({
        content: parsedContent,
        visibility,
        content_warning: contentWarning || undefined,
        in_reply_to: replyToId,
        media_attachments: options.mediaAttachments.value as unknown as File[],
        is_sensitive: isSensitive
      });

      debug.log('[DEBUG] submitPost: Post created!');
      debug.log('✅ Post created successfully:', post.id);
      return post;
    } catch (error) {
      debug.error('[DEBUG] submitPost: ERROR:', error);
      debug.error('❌ Failed to create post:', error);
      throw error;
    }
  };

  const updatePost = async (
    postId: string,
    contentWarning: string,
    isSensitive: boolean
  ) => {
    try {
      const {
        parseContentToMessageParts,
        resolveMentionsUserData,
        resolveEmojisData,
        resolveHashtagsData
      } = await import('@/utils/unifiedContentProcessing');

      const rawContent = options.content.value.trim();
      const [usernameToUserDataMap, emojiDataMap, hashtagDataMap] = await Promise.all([
        resolveMentionsUserData(rawContent),
        resolveEmojisData(rawContent),
        resolveHashtagsData(rawContent)
      ]);

      const parsedContent = await parseContentToMessageParts(
        rawContent,
        usernameToUserDataMap,
        emojiDataMap,
        hashtagDataMap
      );

      const post = await activityPubStore.updatePost(postId, {
        content: parsedContent,
        content_warning: contentWarning || undefined,
        is_sensitive: isSensitive,
        media_attachments: options.mediaAttachments.value,
      });

      debug.log('✅ Post updated successfully:', post.id);
      return post;
    } catch (error) {
      debug.error('❌ Failed to update post:', error);
      throw error;
    }
  };

  return {
    insertEmoji,
    insertGif,
    handleFileUpload,
    handlePaste,
    submitPost,
    updatePost
  };
}

