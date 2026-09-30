<template>
  <div class="public-servers-footer">
    <span class="info-text">{{ $t('server.cantFindLookingFor') }}</span>

    <div class="footer-actions">
      <button type="button" class="btn btn-secondary" @click="$emit('joinByUrl')">
        <Icon name="globe" :size="16" />
        <span>{{ $t('federation.joinByUrl') }}</span>
      </button>

      <button type="button" class="btn btn-primary create-server-btn" @click="$emit('createServer')">
        <Icon name="plus" :size="16" />
        <span class="label-full">{{ $t('server.createYourOwnServer') }}</span>
        <span class="label-short">{{ $t('server.createButton') }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'

interface Emits {
  (e: 'createServer'): void
  (e: 'joinByUrl'): void
}

defineEmits<Emits>()
</script>

<style scoped src="./discoveryButtons.css"></style>

<style scoped>
.public-servers-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-6);
  border-top: 1px solid var(--border-primary);
  background: var(--background-secondary);
}

.info-text {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.footer-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.label-short {
  display: none;
}

@media (max-width: 768px) {
  .label-full {
    display: none;
  }

  .label-short {
    display: inline;
  }

  .public-servers-footer {
    padding: var(--space-3) var(--space-4) calc(var(--space-3) + env(safe-area-inset-bottom, 0px));
  }

  .info-text {
    display: none;
  }

  .footer-actions {
    flex: 1;
  }

  .footer-actions .btn {
    flex: 1;
    min-width: 0;
    padding: 0 var(--space-3);
  }

  .footer-actions .btn span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
</style>
