<template>
  <div class="public-servers-header">
    <div class="header-content">
      <div class="icon-container">
        <svg viewBox="0 0 24 24" class="discover-icon">
          <path d="M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z" fill="currentColor"/>
        </svg>
      </div>
      <div class="header-text">
        <h1 class="modal-title">Discover Communities</h1>
        <p class="modal-subtitle">Find your next favorite server</p>
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
  background: linear-gradient(135deg, rgba(88, 101, 242, 0.1) 0%, transparent 100%);
}

.header-content {
  display: flex;
  align-items: center;
  gap: 16px;
}

.icon-container {
  width: 48px;
  height: 48px;
  background: linear-gradient(135deg, #5865f2, #7289da);
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
  background: linear-gradient(135deg, #5865f2, #7289da);
  border-radius: 12px;
  opacity: 0.3;
  z-index: -1;
  filter: blur(4px);
}

.discover-icon {
  width: 24px;
  height: 24px;
  color: #ffffff;
}

.header-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.modal-title {
  font-size: 24px;
  font-weight: 700;
  color: #ffffff;
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
  color: #ffffff;
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
