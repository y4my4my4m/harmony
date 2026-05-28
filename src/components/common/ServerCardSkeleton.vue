<template>
  <div class="skeleton-grid">
    <div 
      v-for="n in count" 
      :key="n" 
      class="skeleton-server-card"
    >
      <div class="skeleton-header">
        <div class="skeleton-icon"></div>
        <div class="skeleton-status"></div>
      </div>
      
      <div class="skeleton-content">
        <div class="skeleton-name"></div>
        <div class="skeleton-description">
          <div class="skeleton-line"></div>
          <div class="skeleton-line short"></div>
        </div>
        
        <div class="skeleton-info">
          <div class="skeleton-stats">
            <div class="skeleton-stat"></div>
            <div class="skeleton-stat"></div>
          </div>
          <div class="skeleton-owner">
            <div class="skeleton-avatar"></div>
            <div class="skeleton-owner-name"></div>
          </div>
        </div>
      </div>
      
      <div class="skeleton-actions">
        <div class="skeleton-button"></div>
      </div>
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
.skeleton-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 20px;
}

.skeleton-server-card {
  background: rgba(47, 49, 54, 0.98);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  padding: 20px;
  overflow: hidden;
}

.skeleton-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
}

.skeleton-icon {
  width: 64px;
  height: 64px;
  border-radius: 16px;
}

.skeleton-status {
  width: 60px;
  height: 20px;
  border-radius: 10px;
}

.skeleton-content {
  margin-bottom: 20px;
}

.skeleton-name {
  width: 70%;
  height: 24px;
  border-radius: 4px;
  margin-bottom: 12px;
}

.skeleton-description {
  margin-bottom: 16px;
}

.skeleton-line {
  height: 16px;
  border-radius: 4px;
  margin-bottom: 8px;
}

.skeleton-line.short {
  width: 60%;
}

.skeleton-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.skeleton-stats {
  display: flex;
  gap: 12px;
}

.skeleton-stat {
  width: 80px;
  height: 16px;
  border-radius: 4px;
}

.skeleton-owner {
  display: flex;
  align-items: center;
  gap: 8px;
}

.skeleton-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
}

.skeleton-owner-name {
  width: 60px;
  height: 14px;
  border-radius: 4px;
}

.skeleton-actions {
  display: flex;
  justify-content: flex-end;
}

.skeleton-button {
  width: 80px;
  height: 36px;
  border-radius: 8px;
}

.skeleton-icon,
.skeleton-status,
.skeleton-name,
.skeleton-line,
.skeleton-stat,
.skeleton-avatar,
.skeleton-owner-name,
.skeleton-button {
  background-color: rgba(255, 255, 255, 0.06);
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.04) 50%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.8s ease-in-out infinite;
}

@keyframes shimmer {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: -100% 0;
  }
}

/* Responsive adjustments */
@media (max-width: 768px) {
  .skeleton-grid {
    grid-template-columns: 1fr;
    gap: 16px;
  }
}
</style>
