/**
 * useComposerState - Shared state management for ActivityPub post composer
 * 
 * Manages all reactive state for the composer including content, visibility,
 * media attachments, and validation logic.
 */

import { ref, computed, type Ref } from 'vue';
import type { Post, MediaAttachment } from '@/types';

export interface ComposerStateOptions {
  defaultVisibility?: Post['visibility'];
  characterLimit?: number;
  maxMediaAttachments?: number;
}

export function useComposerState(options: ComposerStateOptions = {}) {
  // Configuration
  const characterLimit = options.characterLimit ?? 500;
  const maxMediaAttachments = options.maxMediaAttachments ?? 4;

  // Content state
  const content = ref<string>('');
  const contentWarning = ref<string>('');
  const visibility = ref<Post['visibility']>(options.defaultVisibility ?? 'public');
  const isSensitive = ref<boolean>(false);
  
  // UI state - explicitly set to false to prevent auto-opening
  const showContentWarning = ref<boolean>(false);
  const showVisibilityMenu = ref<boolean>(false);
  const showEmojiPicker = ref<boolean>(false);
  const showGiphyPicker = ref<boolean>(false);
  const isDraft = ref<boolean>(false);
  
  // Media state
  const mediaAttachments = ref<MediaAttachment[]>([]);
  
  // Computed properties
  const remainingCharacters = computed(() => {
    return characterLimit - content.value.length;
  });

  const characterCounterClass = computed(() => {
    const remaining = remainingCharacters.value;
    if (remaining < 0) return 'over-limit';
    if (remaining < 20) return 'warning';
    return '';
  });

  const canSubmit = computed(() => {
    const hasContent = content.value.trim().length > 0 || mediaAttachments.value.length > 0;
    const withinLimit = content.value.length <= characterLimit;
    return hasContent && withinLimit;
  });

  const canAddMedia = computed(() => {
    return mediaAttachments.value.length < maxMediaAttachments;
  });

  // Visibility options configuration
  const visibilityOptions = [
    {
      value: 'public' as const,
      label: 'Public',
      description: 'Visible to everyone',
      icon: 'globe'
    },
    {
      value: 'unlisted' as const,
      label: 'Unlisted',
      description: 'Not shown in public timelines',
      icon: 'unlock'
    },
    {
      value: 'followers' as const,
      label: 'Followers',
      description: 'Only visible to followers',
      icon: 'users'
    },
    {
      value: 'direct' as const,
      label: 'Direct',
      description: 'Only mentioned users',
      icon: 'mail'
    }
  ];

  // Actions
  const reset = () => {
    content.value = '';
    contentWarning.value = '';
    visibility.value = options.defaultVisibility ?? 'public';
    isSensitive.value = false;
    showContentWarning.value = false;
    showVisibilityMenu.value = false;
    showEmojiPicker.value = false;
    showGiphyPicker.value = false;
    isDraft.value = false;
    
    // Clean up media attachments
    mediaAttachments.value.forEach(media => {
      if (media.url.startsWith('blob:')) {
        URL.revokeObjectURL(media.url);
      }
    });
    mediaAttachments.value = [];
  };

  const setVisibility = (newVisibility: Post['visibility']) => {
    visibility.value = newVisibility;
    showVisibilityMenu.value = false;
  };

  const toggleContentWarning = () => {
    showContentWarning.value = !showContentWarning.value;
    if (!showContentWarning.value) {
      contentWarning.value = '';
    }
  };

  const addMediaAttachment = (attachment: MediaAttachment) => {
    if (mediaAttachments.value.length < maxMediaAttachments) {
      mediaAttachments.value.push(attachment);
    }
  };

  const removeMediaAttachment = (index: number) => {
    const media = mediaAttachments.value[index];
    if (media.url.startsWith('blob:')) {
      URL.revokeObjectURL(media.url);
    }
    mediaAttachments.value.splice(index, 1);
  };

  return {
    // State
    content,
    contentWarning,
    visibility,
    isSensitive,
    showContentWarning,
    showVisibilityMenu,
    showEmojiPicker,
    showGiphyPicker,
    isDraft,
    mediaAttachments,
    
    // Configuration
    characterLimit,
    maxMediaAttachments,
    visibilityOptions,
    
    // Computed
    remainingCharacters,
    characterCounterClass,
    canSubmit,
    canAddMedia,
    
    // Actions
    reset,
    setVisibility,
    toggleContentWarning,
    addMediaAttachment,
    removeMediaAttachment
  };
}

