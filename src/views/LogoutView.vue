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
  background: var(--background-senary);
  position: relative;
  overflow: hidden;
}

.logout-card {
  position: relative;
  z-index: 10;
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-xl);
  padding: 48px;
  min-width: 360px;
  text-align: center;
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
  background: color-mix(in srgb, var(--harmony-primary) 15%, transparent);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--harmony-primary);
  margin-bottom: 8px;
}

.logout-icon svg {
  width: 32px;
  height: 32px;
}

.logout-content h2 {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.logout-content p {
  font-size: 0.95rem;
  color: var(--text-secondary);
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
  background: var(--harmony-primary);
  border: none;
  border-radius: var(--radius-lg);
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-on-primary);
  cursor: pointer;
  transition: background-color 0.2s ease;
}

.btn-logout:hover {
  background: var(--harmony-primary-hover);
}

.btn-cancel {
  padding: 12px;
  background: transparent;
  border: none;
  border-radius: var(--radius-lg);
  font-size: 0.95rem;
  color: var(--text-secondary);
  cursor: pointer;
  transition: color 0.2s ease;
}

.btn-cancel:hover {
  color: var(--text-primary);
}

@media (max-width: 480px) {
  .logout-card {
    margin: 20px;
    padding: 32px 24px;
    min-width: auto;
  }
}
</style>
