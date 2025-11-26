<template>
    <div>
      Accepting invite...
    </div>
</template>
<script lang="ts">
import { defineComponent, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { acceptInvite } from '@/services/inviteService';
import { useAuthStore } from '@/stores/auth';
import { useToast } from "vue-toastification";

export default defineComponent({
  setup() {
    const route = useRoute();
    const router = useRouter();
    const authStore = useAuthStore();
    const toast = useToast();
    
    onMounted(async () => {
      const code = route.params.code as string;
      if (!code) {
        debug.error('No invite code found in URL');
        return;
      }
      
      const userId = authStore.session?.user?.id;
      if (!userId) {
        debug.error('User is not logged in');
        return;
      }

      const success = await acceptInvite(code, userId);
      if (success) {
        debug.log('Invite accepted successfully');
        toast.success('Invite accepted successfully');
        router.push('/chat');
      } else {
        debug.error('Failed to accept invite');
        toast.error('Failed to accept invite');
        // Show an error message or handle the failure
      }
    });

    return {};
  }
});
</script>