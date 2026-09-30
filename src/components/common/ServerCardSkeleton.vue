<template>
  <div class="skeleton-grid" aria-hidden="true">
    <div
      v-for="n in count"
      :key="n"
      class="skeleton-server-card"
    >
      <div class="skeleton-icon"></div>

      <div class="skeleton-content">
        <div class="skeleton-name"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-line short"></div>
        <div class="skeleton-stats">
          <div class="skeleton-stat"></div>
          <div class="skeleton-stat"></div>
        </div>
      </div>

      <div class="skeleton-button"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Props {
  count?: number
}

withDefaults(defineProps<Props>(), {
  count: 6
})
</script>

<style scoped>
/* Mirrors ServerCard and the discovery grid. */
.skeleton-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--space-3);
}

.skeleton-server-card {
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.skeleton-icon {
  width: 64px;
  height: 64px;
  border-radius: var(--radius-xl);
}

.skeleton-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.skeleton-name {
  width: 60%;
  height: 18px;
  border-radius: var(--radius-sm);
}

.skeleton-line {
  height: 13px;
  border-radius: var(--radius-sm);
}

.skeleton-line.short {
  width: 70%;
}

.skeleton-stats {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-1);
}

.skeleton-stat {
  width: 72px;
  height: 12px;
  border-radius: var(--radius-sm);
}

.skeleton-button {
  height: 36px;
  border-radius: var(--radius-md);
}

.skeleton-icon,
.skeleton-name,
.skeleton-line,
.skeleton-stat,
.skeleton-button {
  background-color: var(--background-modifier-hover);
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    var(--background-modifier-hover) 50%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.6s ease-in-out infinite;
}

@keyframes shimmer {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: -100% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .skeleton-icon,
  .skeleton-name,
  .skeleton-line,
  .skeleton-stat,
  .skeleton-button {
    animation: none;
  }
}

@media (max-width: 768px) {
  .skeleton-grid {
    grid-template-columns: 1fr;
  }
}
</style>
