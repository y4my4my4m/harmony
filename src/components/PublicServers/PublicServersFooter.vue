<template>
  <div class="public-servers-footer">
    <div class="footer-content">
      <div class="footer-info">
        <svg viewBox="0 0 24 24" class="info-icon">
          <path d="M11,9H13V7H11M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M11,17H13V11H11V17Z" fill="currentColor"/>
        </svg>
        <span class="info-text">{{ $t('server.cantFindLookingFor') }}</span>
      </div>
      
      <div class="footer-actions">
        <button @click="$emit('joinByUrl')" class="join-url-btn">
          <svg width="18" height="18" viewBox="0 0 24 24" class="join-icon">
            <path d="M17.9,17.39C17.64,16.59 16.89,16 16,16H15V13A1,1 0 0,0 14,12H8V10H10A1,1 0 0,0 11,9V7H13A2,2 0 0,0 15,5V4.59C17.93,5.77 20,8.64 20,12C20,14.08 19.2,15.97 17.9,17.39M11,19.93C7.05,19.44 4,16.08 4,12C4,11.38 4.08,10.79 4.21,10.21L9,15V16A2,2 0 0,0 11,18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" fill="currentColor"/>
          </svg>
          <span class="btn-text">{{ $t('federation.joinByUrl') }}</span>
        </button>
        
        <button @click="$emit('createServer')" class="create-server-btn">
          <Icon name="plus" :size="18" />
          <span class="btn-text">{{ $t('server.createYourOwnServer') }}</span>
        </button>
      </div>
    </div>
    
    <div class="footer-gradient"></div>
  </div>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue';

interface Emits {
  (e: 'createServer'): void
  (e: 'joinByUrl'): void
}

defineEmits<Emits>()
</script>

<style scoped>
.public-servers-footer {
  position: relative;
  padding: 24px 32px;
  border-top: 1px solid var(--border-primary);
  background: var(--background-secondary);
}

.footer-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}

.footer-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.join-url-btn {
  background: rgba(0, 212, 255, 0.1);
  border: 1px solid rgba(0, 212, 255, 0.3);
  border-radius: 10px;
  padding: 14px 20px;
  color: #00d4ff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.join-url-btn:hover {
  background: rgba(0, 212, 255, 0.2);
  border-color: rgba(0, 212, 255, 0.5);
  transform: translateY(-2px);
}

.join-url-btn .join-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  color: currentColor;
}

.footer-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.info-icon {
  width: 20px;
  height: 20px;
  color: var(--harmony-primary);
}

.info-text {
  font-size: 14px;
  color: var(--text-secondary);
  font-weight: 500;
}

.create-server-btn {
  background: linear-gradient(135deg, #57f287, #3ba55d);
  border: none;
  border-radius: 10px;
  padding: 14px 24px;
  color: var(--text-on-primary, #ffffff);
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
  z-index:-1;
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
  
  .footer-actions {
    flex-direction: column;
    gap: 10px;
  }
  
  .join-url-btn,
  .create-server-btn {
    justify-content: center;
    padding: 16px 24px;
    width: 100%;
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
}
</style>
