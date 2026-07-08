<!-- MonyContent - Render ActivityPub post content with rich formatting -->
<template>
  <UnifiedContentRenderer
    :content="props.content"
    :mode="props.isPreview ? 'preview' : 'display'"
    :max-preview-length="props.previewLength || 500"
    render-mode="html"
    :enable-markdown="true"
    @user-mention-click="handleMentionClick"
    @hashtag-click="handleHashtagClick"
    @image-click="handleImageClick"
  />
</template>

<script setup lang="ts">
import UnifiedContentRenderer from '@/components/UnifiedContentRenderer.vue';

interface Props {
  content: string | any[] | any; // Can be string, JSONB array, or other format
  isPreview?: boolean; // For reply previews - truncate but preserve mentions
  previewLength?: number; // Maximum length for previews
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'user-mention-click': [handle: string];
  'hashtag-click': [tag: string];
  'image-click': [url: string];
}>();

const handleMentionClick = (userId: string, event: Event) => {
  // Extract handle from the mention element for backwards compatibility
  const target = event.target as HTMLElement;
  const handle = target.getAttribute('data-handle') || `@${userId}`;
  emit('user-mention-click', handle);
};

const handleHashtagClick = (tag: string) => {
  emit('hashtag-click', tag);
};

const handleImageClick = (url: string) => {
  emit('image-click', url);
};
</script>

<style scoped>
/* Styles are now handled by UnifiedContentRenderer */
</style>
