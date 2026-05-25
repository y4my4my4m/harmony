<template>
  <div class="logout-wrapper">
    <div class="logout-card">
      <div class="logout-content">
        <div class="logout-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
        </div>
        <h2>{{ $t('auth.logoutConfirm.title') || 'Log out from this device?' }}</h2>
        <p>{{ $t('auth.logoutConfirm.description') || 'You will need to sign in again to access your account.' }}</p>
        <div class="logout-actions">
          <button class="btn-logout" @click="handleLogout" data-testid="logout-confirm-btn">
            {{ $t('auth.logout') }}
          </button>
          <button class="btn-cancel" @click="goBack">
            {{ $t('auth.logoutConfirm.cancel') || 'Cancel' }}
          </button>
        </div>
      </div>
    </div>
    <div class="bg-gradient"></div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const authStore = useAuthStore()

const handleLogout = async () => {
  await authStore.logout()
}

const goBack = () => {
  router.back()
}
</script>

<style scoped>
.logout-wrapper {
  min-height: 100vh;
  min-width: 100vw;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0a0a0f;
  position: relative;
  overflow: hidden;
}

.bg-gradient {
  position: fixed;
  inset: 0;
  background:
    radial-gradient(ellipse 60% 40% at 50% 40%, rgba(99, 102, 241, 0.15) 0%, transparent 50%),
    radial-gradient(ellipse 40% 30% at 70% 60%, rgba(139, 92, 246, 0.1) 0%, transparent 50%);
  pointer-events: none;
}

.logout-card {
  position: relative;
  z-index: 10;
  background: rgba(17, 17, 23, 0.9);
  backdrop-filter: blur(40px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 24px;
  padding: 48px;
  min-width: 360px;
  text-align: center;
  box-shadow: 0 32px 64px rgba(0, 0, 0, 0.4);
}

.logout-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.logout-icon {
  width: 64px;
  height: 64px;
  background: rgba(99, 102, 241, 0.15);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #818cf8;
  margin-bottom: 8px;
}

.logout-icon svg {
  width: 32px;
  height: 32px;
}

.logout-content h2 {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--text-primary, #fff);
  margin: 0;
}

.logout-content p {
  font-size: 0.95rem;
  color: rgba(255, 255, 255, 0.6);
  margin: 0;
  max-width: 280px;
}

.logout-actions {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 16px;
  width: 100%;
  max-width: 240px;
}

.btn-logout {
  padding: 14px 32px;
  background: linear-gradient(135deg, #6366f1 0%, #818cf8 100%);
  border: none;
  border-radius: 12px;
  font-size: 1rem;
  font-weight: 600;
  color: #fff;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-logout:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 32px rgba(99, 102, 241, 0.4);
}

.btn-cancel {
  padding: 12px;
  background: transparent;
  border: none;
  border-radius: 12px;
  font-size: 0.95rem;
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  transition: color 0.2s ease;
}

.btn-cancel:hover {
  color: rgba(255, 255, 255, 0.9);
}

@media (max-width: 480px) {
  .logout-card {
    margin: 20px;
    padding: 32px 24px;
    min-width: auto;
  }
}
</style>
