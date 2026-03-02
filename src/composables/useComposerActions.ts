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
    if (!richEditor) {
      // Fallback: append to content
      const emojiText = `:${emoji.name}:`;
      options.content.value += emojiText;
      options.onContentUpdate?.(options.content.value);
      return;
    }

    const emojiText = `:${emoji.name}:`;
    const currentContent = options.content.value;
    
    // Insert at cursor or append
    options.content.value = currentContent + emojiText;
    options.onContentUpdate?.(options.content.value);
    
    nextTick(() => {
      richEditor.focus?.();
    });
  };

  /**
   * Insert GIF URL into content
   */
  const insertGif = (gif: any) => {
    const gifUrl = gif.media_formats.gif.url;
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
   * Handle paste events to support image pasting
   */
  const handlePaste = (event: ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file && options.canAddMedia.value) {
          const previewUrl = URL.createObjectURL(file);
          const attachment: MediaAttachment = {
            id: `temp_${Date.now()}_${Math.random()}`,
            type: 'image',
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

      // Create post via store
      debug.log('[DEBUG] submitPost: Calling store.createPost...');
      const post = await activityPubStore.createPost({
        content: parsedContent,
        visibility,
        content_warning: contentWarning || undefined,
        in_reply_to: replyToId,
        media_attachments: options.mediaAttachments.value,
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

  return {
    insertEmoji,
    insertGif,
    handleFileUpload,
    handlePaste,
    submitPost
  };
}

