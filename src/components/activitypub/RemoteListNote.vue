<template>
  <div class="remote-list-note" role="note" data-testid="remote-list-note">
    <Icon name="info" :size="16" class="remote-list-icon" />
    <p class="remote-list-text">{{ t('activitypub.remoteListNote') }}</p>
    <a
      v-if="profileUrl"
      :href="safeHref(profileUrl)"
      target="_blank"
      rel="noopener noreferrer"
      class="remote-list-link"
      data-testid="remote-list-link"
    >
      {{ t('activitypub.fullListOnDomain', { domain }) }}
      <Icon name="external-link" :size="14" />
    </a>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { safeHref } from '@/utils/sanitize'

defineProps<{
  /** The remote account's domain. */
  domain: string
  /** The account's profile on its own server; the link is omitted without one. */
  profileUrl?: string | null
}>()

const { t } = useI18n()
</script>

<style scoped>
.remote-list-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: var(--background-secondary);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.remote-list-icon {
  flex-shrink: 0;
  color: var(--text-tertiary);
}

.remote-list-text {
  flex: 1 1 12rem;
  min-width: 0;
  margin: 0;
}

.remote-list-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--harmony-primary);
  font-weight: var(--font-weight-semibold);
  text-decoration: none;
  overflow-wrap: anywhere;
}

.remote-list-link:hover {
  text-decoration: underline;
}
</style>
