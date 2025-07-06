<template>
  <div class="public-servers-footer">
    <div class="footer-content">
      <div class="footer-info">
        <svg viewBox="0 0 24 24" class="info-icon">
          <path d="M11,9H13V7H11M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M11,17H13V11H11V17Z" fill="currentColor"/>
        </svg>
        <span class="info-text">Can't find what you're looking for?</span>
      </div>
      
      <button @click="$emit('createServer')" class="create-server-btn">
        <svg viewBox="0 0 24 24" class="btn-icon">
          <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z" fill="currentColor"/>
        </svg>
        <span class="btn-text">Create Your Own Server</span>
      </button>
    </div>
    
    <div class="footer-gradient"></div>
  </div>
</template>

<script setup lang="ts">
interface Emits {
  (e: 'createServer'): void
}

defineEmits<Emits>()
</script>

<style scoped>
.public-servers-footer {
  position: relative;
  padding: 24px 32px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(32, 34, 37, 0.5);
}

.footer-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}

.footer-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.info-icon {
  width: 20px;
  height: 20px;
  color: rgba(88, 101, 242, 0.7);
}

.info-text {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.7);
  font-weight: 500;
}

.create-server-btn {
  background: linear-gradient(135deg, #57f287, #3ba55d);
  border: none;
  border-radius: 10px;
  padding: 14px 24px;
  color: #ffffff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
  box-shadow: 0 4px 15px rgba(87, 242, 135, 0.3);
}

.create-server-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, #57f287, #3ba55d);
  opacity: 0;
  transition: opacity 0.3s ease;
}

.create-server-btn:hover::before {
  opacity: 1;
}

.create-server-btn:hover {
  transform: translateY(-2px);
  box-shadow: 
    0 8px 25px rgba(87, 242, 135, 0.4),
    0 0 0 1px rgba(87, 242, 135, 0.2);
}
.create-server-btn:active {
  transform: translateY(-1px);
}

.btn-icon {
  width: 18px;
  height: 18px;
  position: relative;
  z-index: 1;
}

.btn-text {
  position: relative;
  z-index: 1;
}

.footer-gradient {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(87, 242, 135, 0.3), transparent);
}

/* Mobile responsive */
@media (max-width: 768px) {
  .public-servers-footer {
    padding: 20px 24px;
  }
  
  .footer-content {
    flex-direction: column;
    align-items: stretch;
    gap: 16px;
    text-align: center;
  }
  
  .footer-info {
    justify-content: center;
  }
  
  .create-server-btn {
    justify-content: center;
    padding: 16px 24px;
  }
}

@media (max-width: 480px) {
  .public-servers-footer {
    padding: 16px 20px;
  }
  
  .info-text {
    font-size: 13px;
  }
  
  .create-server-btn {
    font-size: 13px;
    padding: 14px 20px;
  }
  
  .btn-text {
    white-space: nowrap;
  }
}
</style>
