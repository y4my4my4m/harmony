<template>
  <div class="reply-reference" @click="emit('open-reply', replyToMessageId)">
    <div class="reply-spine"></div>
    <div class="reply-content">
      <Avatar :src="avatarSrc" size="mini" class="reply-avatar" />
      <div class="reply-username" :style="{ color: usernameColor }">
        <DisplayName :userId="replyUserId" :fallback="replyUserDisplayName" :truncate="true" />
      </div>
      <div class="reply-preview">
        {{ previewText }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import Avatar from '@/components/common/Avatar.vue';
import DisplayName from '@/components/DisplayName.vue';

defineProps<{
  replyToMessageId: string;
  avatarSrc: string;
  replyUserId: string;
  replyUserDisplayName: string;
  usernameColor: string;
  previewText: string;
}>();

const emit = defineEmits<{
  (e: 'open-reply', replyMessageId: string): void;
}>();
</script>

<style scoped>
.reply-reference {
  margin-left: 54px; /* Match the gutter width */
  margin-bottom: 0;
  cursor: pointer;
  position: relative;
}

.reply-spine {
  position: absolute;
  left: -36px;
  bottom: -1px;
  width: 2px;
  height: 12px;
  background-color: #4f545c;
  border-radius: 1px;
}

.reply-spine::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 34px;
  height: 2px;
  background-color: #4f545c;
  border-radius: 1px;
}

.reply-content {
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0.64;
  transition: opacity 0.2s ease;
  min-width: 0; /* allow flex children to shrink/ellipsize instead of overflowing */
}

.reply-content:hover {
  opacity: 1;
}

.reply-avatar {
  flex-shrink: 0;
}

.reply-username {
  font-weight: 500;
  font-size: 0.875rem;
  /* Names contain inline emoji <img>s and badges; without nowrap the username
     can wrap onto a second line on narrow widths, which collides with the
     reply spine. Cap at half the row and ellipsize so the preview still gets
     space next to it. */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 50%;
  flex-shrink: 0;
}

.reply-preview {
  color: var(--text-secondary);
  font-size: 0.875rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 300px;
  min-width: 0;
  flex: 1;
}

@media (max-width: 768px) {
  .reply-reference {
    margin-left: 50px;
  }

  .reply-spine {
    left: -30px;
  }

  .reply-spine::after {
    width: 28px;
  }

  /* On narrow widths give the username a tighter cap so it doesn't push
     the preview off-screen, but keep it on a single line. */
  .reply-username {
    max-width: 40%;
  }

  .reply-preview {
    max-width: none;
  }
}
</style>
