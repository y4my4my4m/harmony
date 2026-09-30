<template>
  <div class="public-servers-header">
    <div class="header-content">
      <div class="icon-container">
        <img
          src="/img/app_icon_badge.png"
          alt=""
          class="discover-portal-bear"
          width="26"
          height="26"
        />
      </div>
      <div class="header-text">
        <h1 id="public-servers-title" class="modal-title">{{ $t('server.discoverCommunities') }}</h1>
        <p class="modal-subtitle">{{ $t('server.findNextFavoriteServer') }}</p>
      </div>
    </div>

    <button type="button" class="close-button" :aria-label="$t('common.close')" @click="$emit('close')">
      <Icon name="x" :size="20" />
    </button>
  </div>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'

interface Emits {
  (e: 'close'): void
}

defineEmits<Emits>()
</script>

<style scoped>
.public-servers-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-5) var(--space-6);
  border-bottom: 1px solid var(--border-primary);
}

.header-content {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.icon-container {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  background: var(--harmony-primary);
  border-radius: var(--radius-lg);
  display: flex;
  align-items: center;
  justify-content: center;
}

.discover-portal-bear {
  width: 26px;
  height: 26px;
  object-fit: contain;
  display: block;
}

.header-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.modal-title {
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-bold);
  color: var(--text-primary);
  margin: 0;
  line-height: 1.2;
}

.modal-subtitle {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.4;
}

.close-button {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.close-button:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.close-button:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

@media (max-width: 768px) {
  .public-servers-header {
    padding: var(--space-4);
  }

  .modal-title {
    font-size: var(--font-size-lg);
  }

  .modal-subtitle {
    font-size: 13px;
  }
}
</style>
