<!-- MonyContent - Render ActivityPub post content with rich formatting -->
<template>
  <UnifiedContentRenderer
    :content="displayContent"
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
import { computed } from 'vue';
import UnifiedContentRenderer from '@/components/UnifiedContentRenderer.vue';
import { withoutStrayMentionAt } from '@/utils/postReblog';

interface Props {
  content: string | any[] | any; // Can be string, JSONB array, or other format
  isPreview?: boolean; // For reply previews - truncate but preserve mentions
  previewLength?: number; // Maximum length for previews
}

const props = defineProps<Props>();

const displayContent = computed(() => withoutStrayMentionAt(props.content));

const emit = defineEmits<{
  'user-mention-click': [handle: string];
  'hashtag-click': [tag: string];
  'image-click': [url: string];
}>();

// Event handlers
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
