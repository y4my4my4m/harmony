<template>
  <!-- <h2>Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login </h2> -->
  <LoginComponent />
</template>

<script lang="ts">
import { defineComponent, watch } from 'vue';
import { useRouter } from 'vue-router';
import LoginComponent from '@/components/LoginComponent.vue';
import { useAuthStore } from '@/stores/auth';
import { UserStatus } from '@/types';
import { updateUserStatus } from '@/services/profileService';

export default defineComponent({
  components: {
    LoginComponent,
  },
  setup() {
    const router = useRouter();
    const authStore = useAuthStore();

    watch(() => authStore.isLoggedIn, (isLoggedIn) => {
      if (isLoggedIn) {
        try {
          const userId = authStore.session?.user?.id || '';
          updateUserStatus(userId, UserStatus.Online);
          router.push('/chat');
        } catch (error: any) {
          console.log(error);
          router.push('/new-profile');
        }
      }
    });

    return {};
  },
});
</script>

<style scoped>
  h2 {
    background-clip: text;
    -webkit-text-fill-color: transparent; 
    -moz-text-fill-color: transparent;
    background-image: linear-gradient(45deg, #3416f7, #c41d1d);
    width: 180%;
    height: 100%;
    position: absolute;
    display: block;
    top: -390px;
    margin: 0 auto;
    left: -480px;
    right: 0;
    text-align: center;
    font-weight: 900;
    opacity: .1;
    font-size: 20em;
    text-shadow: 0 3px 10px rgba(0,0,0,0.7);
    transform: skew(6deg, 8deg) rotate3d(7, 0, 0, 30deg);
  }
</style>