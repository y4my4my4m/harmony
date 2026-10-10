<template>
  <TransitionGroup v-if="plays.length > 0" tag="ul" name="sba" class="sba" aria-live="polite">
    <li v-for="play in plays" :key="play.key" class="sba-item">
      <span class="sba-emoji" aria-hidden="true">{{ play.emoji || '🔊' }}</span>
      <i18n-t keypath="soundboard.played" tag="span" class="sba-text">
        <template #user>
          <DisplayName class="sba-user" :user-id="play.userId" :truncate="true" />
        </template>
        <template #sound>
          <strong class="sba-sound">{{ play.builtinKey ? t(`soundboard.defaults.${play.builtinKey}`) : play.name }}</strong>
        </template>
      </i18n-t>
    </li>
  </TransitionGroup>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import DisplayName from '@/components/DisplayName.vue';
import { useSoundboardStore } from '@/stores/soundboard';

const { t } = useI18n();
const soundboard = useSoundboardStore();
const plays = computed(() => soundboard.recentPlays);
</script>

<style scoped>
.sba {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  pointer-events: none;
}

.sba-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--background-floating);
  border: 1px solid var(--border-primary);
  box-shadow: var(--shadow-medium, 0 2px 8px rgba(0, 0, 0, 0.2));
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.sba-emoji {
  font-size: 14px;
  line-height: 1;
}

.sba-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sba-user,
.sba-sound {
  color: var(--text-primary);
  font-weight: 600;
}

.sba-enter-active,
.sba-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.sba-enter-from,
.sba-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

@media (prefers-reduced-motion: reduce) {
  .sba-enter-active,
  .sba-leave-active {
    transition: none;
  }
}
</style>
