<template>
  <div
    v-if="host !== null"
    class="server-copy-banner"
    :class="{ compact }"
    role="note"
    :aria-labelledby="titleId"
    data-testid="server-copy-banner"
  >
    <Icon name="globe" :size="compact ? 16 : 20" class="copy-icon" aria-hidden="true" />
    <div class="copy-text">
      <strong :id="titleId">{{ t('serverCopy.banner.title', { host: host || t('serverCopy.banner.unknownHost') }) }}</strong>
      <span data-testid="server-copy-banner-body">{{ t(instanceTools ? 'serverCopy.banner.bodyHost' : 'serverCopy.banner.body') }}</span>
    </div>
    <div v-if="$slots.default" class="copy-actions">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { remoteServerHost } from '@/utils/serverUtils'
import type { Server } from '@/types'

/** A copy of a server hosted on another instance: names the host and what settings here change. */
const props = withDefaults(defineProps<{
  server: Pick<Server, 'is_local_server' | 'federation_domain' | 'federation_inbox_url'> | null | undefined
  compact?: boolean
  /**
   * Above the instance staff's tools, which change things for everyone on this instance: the
   * line saying settings only change what the viewer sees is left out.
   */
  instanceTools?: boolean
}>(), { compact: false, instanceTools: false })

const { t } = useI18n()
const titleId = `server-copy-${useId()}`

// null on a server hosted here; '' when the copy names no host.
const host = computed(() => remoteServerHost(props.server))
</script>

<style scoped>
.server-copy-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  margin-bottom: 16px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--harmony-primary) 45%, transparent);
  background: color-mix(in srgb, var(--harmony-primary) 12%, var(--background-secondary));
}

.server-copy-banner.compact {
  align-items: flex-start;
  gap: 8px;
  padding: 10px;
  margin: 0;
  border-width: 0 0 1px;
  border-radius: var(--radius-base) var(--radius-base) 0 0;
}

.copy-icon {
  flex-shrink: 0;
  color: var(--text-link);
}

.compact .copy-icon {
  margin-top: 2px;
}

.copy-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 14px;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.copy-text span {
  font-size: 13px;
  color: var(--text-secondary);
}

.compact .copy-text {
  font-size: 13px;
}

.compact .copy-text span {
  font-size: 12px;
}

.copy-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

@media (max-width: 640px) {
  .server-copy-banner:not(.compact) {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
