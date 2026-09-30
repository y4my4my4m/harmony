<template>
  <div class="today-preview" :style="{ '--today-preview-lines': lines }" inert>
    <span v-if="undecrypted" class="today-preview-note">
      <Icon name="lock" :size="12" aria-hidden="true" />
      {{ t('channelEncryption.encryptedMessage') }}
    </span>
    <span v-else-if="contentWarning" class="today-preview-note">
      <Icon name="alert-triangle" :size="12" aria-hidden="true" />
      {{ contentWarning }}
    </span>
    <template v-else>
      <div v-if="preview.parts.length > 0" class="today-preview-text">
        <UnifiedMessageContent :content="preview.parts" :message-id="messageId" />
      </div>
      <span v-if="preview.attachments > 0 || extraAttachments > 0" class="today-preview-note">
        <Icon name="file" :size="12" aria-hidden="true" />
        {{ t('today.attachments', { count: preview.attachments + extraAttachments }, preview.attachments + extraAttachments) }}
      </span>
      <span v-if="preview.parts.length === 0 && preview.attachments + extraAttachments === 0" class="today-preview-note">
        {{ t('today.noText') }}
      </span>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue'
import { isUndecrypted } from '@/utils/channelEncryption'
import { previewParts } from '@/utils/todaySummary'
import type { MessagePart } from '@/types'

const props = withDefaults(defineProps<{
  content: MessagePart[]
  messageId: string
  encrypted?: boolean
  decrypted?: boolean
  contentWarning?: string | null
  /** Attachments stored outside `content`, as posts store media. */
  extraAttachments?: number
  lines?: number
}>(), {
  encrypted: false,
  decrypted: false,
  contentWarning: null,
  extraAttachments: 0,
  lines: 2,
})

const { t } = useI18n()

const undecrypted = computed(() => isUndecrypted({ encrypted: props.encrypted, decrypted: props.decrypted }))
const preview = computed(() => previewParts(undecrypted.value ? [] : props.content))
</script>

<style scoped>
.today-preview {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
}

/* max-height backs up the clamp where markdown blocks escape it. */
.today-preview-text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--today-preview-lines);
  line-clamp: var(--today-preview-lines);
  max-height: calc(var(--today-preview-lines) * 1.5em);
  overflow: hidden;
  overflow-wrap: anywhere;
}

.today-preview-text :deep(*) {
  font-size: inherit;
  margin-top: 0;
  margin-bottom: 0;
}

.today-preview-text :deep(img) {
  max-height: 1.35em;
  vertical-align: -0.25em;
}

.today-preview-note {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-style: italic;
  color: var(--text-muted);
}
</style>
