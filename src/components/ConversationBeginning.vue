<template>
  <div v-if="kind === 'channel'" class="beginning-indicator">
    <h2 class="beginning-title">{{ $t('message.channelWelcome', { name }) }}</h2>
    <p class="beginning-subtitle">{{ $t('message.channelWelcomeSubtitle', { name }) }}</p>
  </div>
  <!-- DM and group: the conversation header shows avatar and name. -->
  <div v-else class="beginning-indicator compact">
    <p v-if="kind === 'group' && !name" class="beginning-subtitle">{{ $t('message.groupBeginningUnnamed') }}</p>
    <i18n-t v-else :keypath="kind === 'group' ? 'message.groupBeginning' : 'message.dmBeginning'" tag="p" class="beginning-subtitle">
      <template #name><DisplayName class="beginning-name" :user-id="userId" :fallback="name" /></template>
    </i18n-t>
  </div>
</template>

<script setup lang="ts">
import DisplayName from '@/components/DisplayName.vue'

defineProps<{
  kind: 'channel' | 'dm' | 'group'
  name: string
  userId?: string
}>()
</script>

<style scoped>
.beginning-indicator {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 40px 20px 20px;
  margin: 0 4px 8px;
  border-bottom: 1px solid var(--border-secondary);
}

.beginning-indicator.compact {
  padding: 24px 20px 12px;
}

.beginning-title {
  font-size: 1.75rem;
  font-weight: 800;
  color: var(--text-primary);
  margin: 0;
  line-height: 1.2;
  letter-spacing: -0.02em;
}

.beginning-subtitle {
  font-size: 0.9rem;
  color: var(--text-tertiary);
  margin: 2px 0 0;
  line-height: 1.45;
  max-width: 640px;
}

.beginning-name {
  font-weight: 600;
  color: var(--text-primary);
}

@media (max-width: 768px) {
  .beginning-indicator {
    padding: 28px 14px 16px;
  }

  .beginning-indicator.compact {
    padding: 18px 14px 10px;
  }

  .beginning-title {
    font-size: 1.4rem;
  }

  .beginning-subtitle {
    font-size: 0.85rem;
  }
}
</style>
