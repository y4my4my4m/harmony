<template>
  <div class="public-servers-header">
    <div class="header-content">
      <div class="icon-container">
        <img
          src="/img/app_icon_badge.png"
          alt=""
          class="discover-portal-bear"
          width="30"
          height="30"
        />
      </div>
      <div class="header-text">
        <h1 class="modal-title">{{ $t('server.discoverCommunities') }}</h1>
        <p class="modal-subtitle">{{ $t('server.findNextFavoriteServer') }}</p>
      </div>
    </div>
    
    <button @click="$emit('close')" class="close-button" aria-label="Close">
      <svg viewBox="0 0 24 24" class="close-icon">
        <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
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
  padding: 24px 32px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  background: linear-gradient(135deg, color-mix(in srgb, var(--harmony-primary) 6%, transparent) 0%, transparent 100%);
}

.header-content {
  display: flex;
  align-items: center;
  gap: 16px;
}

.icon-container {
  width: 48px;
  height: 48px;
  background: linear-gradient(135deg, var(--harmony-primary), var(--harmony-primary-hover));
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.icon-container::before {
  content: '';
  position: absolute;
  inset: -1px;
  background: linear-gradient(135deg, var(--harmony-primary), var(--harmony-primary-hover));
  border-radius: 12px;
  opacity: 0.3;
  z-index: -1;
  filter: blur(4px);
}

/* Same white bear as Harmony Portal (ServerSidebar) */
.discover-portal-bear {
  width: 30px;
  height: 30px;
  object-fit: contain;
  display: block;
  position: relative;
  z-index: 1;
}

.discover-icon {
  width: 24px;
  height: 24px;
  color: var(--text-primary);
}

.header-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.modal-title {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
  line-height: 1.2;
}

.modal-subtitle {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.7);
  margin: 0;
  line-height: 1.4;
}

.close-button {
  width: 40px;
  height: 40px;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 8px;
  color: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  position: relative;
}

.close-button:hover {
  background: rgba(255, 255, 255, 0.15);
  color: var(--text-primary);
  transform: scale(1.05);
}

.close-button:active {
  transform: scale(0.95);
}

.close-icon {
  width: 20px;
  height: 20px;
}

/* Mobile responsive */
@media (max-width: 768px) {
  .public-servers-header {
    padding: 20px 24px;
  }
  
  .header-content {
    gap: 12px;
  }
  
  .icon-container {
    width: 40px;
    height: 40px;
  }
  
  .discover-icon {
    width: 20px;
    height: 20px;
  }
  
  .modal-title {
    font-size: 20px;
  }
  
  .modal-subtitle {
    font-size: 13px;
  }
}

@media (max-width: 480px) {
  .public-servers-header {
    padding: 16px 20px;
  }
  
  .modal-title {
    font-size: 18px;
  }
  
  .close-button {
    width: 36px;
    height: 36px;
  }
}
</style>
