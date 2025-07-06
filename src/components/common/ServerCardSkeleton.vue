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
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.1) 25%, rgba(255, 255, 255, 0.2) 50%, rgba(255, 255, 255, 0.1) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

.skeleton-status {
  width: 60px;
  height: 20px;
  border-radius: 10px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.1) 25%, rgba(255, 255, 255, 0.2) 50%, rgba(255, 255, 255, 0.1) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

.skeleton-content {
  margin-bottom: 20px;
}

.skeleton-name {
  width: 70%;
  height: 24px;
  border-radius: 4px;
  margin-bottom: 12px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.1) 25%, rgba(255, 255, 255, 0.2) 50%, rgba(255, 255, 255, 0.1) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

.skeleton-description {
  margin-bottom: 16px;
}

.skeleton-line {
  height: 16px;
  border-radius: 4px;
  margin-bottom: 8px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.1) 25%, rgba(255, 255, 255, 0.2) 50%, rgba(255, 255, 255, 0.1) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
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
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.1) 25%, rgba(255, 255, 255, 0.2) 50%, rgba(255, 255, 255, 0.1) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
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
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.1) 25%, rgba(255, 255, 255, 0.2) 50%, rgba(255, 255, 255, 0.1) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

.skeleton-owner-name {
  width: 60px;
  height: 14px;
  border-radius: 4px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.1) 25%, rgba(255, 255, 255, 0.2) 50%, rgba(255, 255, 255, 0.1) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

.skeleton-actions {
  display: flex;
  justify-content: flex-end;
}

.skeleton-button {
  width: 80px;
  height: 36px;
  border-radius: 8px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.1) 25%, rgba(255, 255, 255, 0.2) 50%, rgba(255, 255, 255, 0.1) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

@keyframes shimmer {
  0% {
    background-position: -200% 0;
  }
  100% {
    background-position: 200% 0;
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
