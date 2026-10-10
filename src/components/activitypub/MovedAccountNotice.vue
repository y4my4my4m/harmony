<template>
  <div class="moved-account-notice" role="status" data-testid="moved-account-notice">
    <Icon name="arrow-right" :size="18" class="moved-icon" />
    <div class="moved-body">
      <p class="moved-text">
        <i18n-t keypath="accountMigration.profile.moved" tag="span">
          <template #name><strong>{{ name }}</strong></template>
          <template #target><strong>{{ target.handle }}</strong></template>
        </i18n-t>
      </p>
      <p class="moved-hint">{{ t('accountMigration.profile.hint') }}</p>
    </div>
    <button
      v-if="target.routeHandle"
      type="button"
      class="moved-go"
      data-testid="moved-account-go"
      @click="go"
    >
      {{ t('accountMigration.profile.goToNew') }}
    </button>
    <a
      v-else-if="target.uri"
      :href="safeHref(target.uri)"
      target="_blank"
      rel="noopener noreferrer"
      class="moved-go"
    >
      {{ t('accountMigration.profile.goToNew') }}
    </a>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import Icon from '@/components/common/Icon.vue'
import { safeHref } from '@/utils/sanitize'
import type { AccountRef } from '@/utils/movedAccount'

const props = defineProps<{
  /** Display name of the account that moved. */
  name: string
  target: AccountRef
}>()

const emit = defineEmits<{ navigate: [] }>()

const { t } = useI18n()
const router = useRouter()

function go() {
  if (!props.target.routeHandle) return
  emit('navigate')
  router.push({ name: 'UserProfile', params: { handle: props.target.routeHandle } })
}
</script>

<style scoped>
.moved-account-notice {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border: 1px solid color-mix(in srgb, var(--harmony-primary) 40%, transparent);
  background: color-mix(in srgb, var(--harmony-primary) 8%, transparent);
  border-radius: var(--radius-md);
}

.moved-icon {
  flex-shrink: 0;
  color: var(--harmony-primary);
}

.moved-body {
  flex: 1;
  min-width: 0;
}

.moved-text {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.moved-hint {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.moved-go {
  flex-shrink: 0;
  padding: 6px 14px;
  border-radius: var(--radius-full);
  border: none;
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  text-decoration: none;
  cursor: pointer;
}

.moved-go:hover {
  filter: brightness(1.08);
}
</style>
