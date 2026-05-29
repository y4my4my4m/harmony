<template>
  <div class="invite-accept-container">
    <div v-if="status === 'loading'" class="invite-status">
      <LoadingSpinner :size="36" />
      <p>{{ t('invite.accepting') }}</p>
    </div>
    <div v-else-if="status === 'error'" class="invite-status error">
      <span class="error-icon">&#10006;</span>
      <p>{{ errorMessage }}</p>
      <button class="retry-btn" @click="$router.push('/chat')">{{ t('common.back') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { acceptInvite } from '@/services/inviteService';
import { useAuthStore } from '@/stores/auth';
import { useToast } from 'vue-toastification';
import { useI18n } from 'vue-i18n';
import { debug } from '@/utils/debug';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const toast = useToast();
const { t } = useI18n();

const status = ref<'loading' | 'error'>('loading');
const errorMessage = ref('');

onMounted(async () => {
  const code = route.params.code as string;
  if (!code) {
    debug.error('No invite code found in URL');
    status.value = 'error';
    errorMessage.value = t('invite.noCode');
    return;
  }

  if (!authStore.session?.user?.id) {
    debug.error('User is not logged in');
    status.value = 'error';
    errorMessage.value = t('invite.notLoggedIn');
    return;
  }

  // BUGS.md Pattern A: `acceptInvite` inserts into
  // `user_servers.user_id` which references `profiles(id)`. Passing the
  // auth UUID broke the FK / RLS. Resolve profile id here.
  let profileId: string;
  try {
    const { authContextService } = await import('@/services/AuthContextService');
    profileId = await authContextService.getCurrentProfileId();
  } catch (err) {
    debug.error('Failed to resolve profile id for invite accept:', err);
    status.value = 'error';
    errorMessage.value = t('invite.notLoggedIn');
    return;
  }

  try {
    const success = await acceptInvite(code, profileId);
    if (success) {
      debug.log('Invite accepted successfully');
      toast.success(t('invite.accepted'));
      router.push('/chat');
    } else {
      debug.error('Failed to accept invite');
      status.value = 'error';
      errorMessage.value = t('invite.failed');
      toast.error(t('invite.failed'));
    }
  } catch (err) {
    debug.error('Error accepting invite:', err);
    status.value = 'error';
    errorMessage.value = t('invite.failed');
    toast.error(t('invite.failed'));
  }
});
</script>

<style scoped>
.invite-accept-container {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: var(--background-primary, #1a1a2e);
}

.invite-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 32px;
  border-radius: 12px;
  background: var(--background-secondary, #16213e);
  color: var(--text-primary, #e0e0e0);
  font-size: 16px;
}

.invite-status.error {
  color: var(--color-error, #e53935);
}

.error-icon {
  font-size: 32px;
}


.retry-btn {
  padding: 8px 20px;
  border: none;
  border-radius: 6px;
  background: var(--color-primary, #5865f2);
  color: #fff;
  font-size: 14px;
  cursor: pointer;
  transition: opacity 0.2s;
}

.retry-btn:hover {
  opacity: 0.85;
}
</style>
