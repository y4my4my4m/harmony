<template>
  <div>
    <!-- Display profile information -->
    <div v-if="profile">
      <img class="avatar" :src="profile.avatar_url" alt="Avatar">
      <p>DisplayName: {{ profile.display_name }}</p>
      <p>Username: {{ profile.username }}</p>
      <p>About: {{ profile.about }}</p>
    </div>

    <!-- File input for avatar upload -->
    <input type="file" @change="onFileChange" />
    <!-- sign out button -->
    <button @click="signOut">Sign Out</button>
    <button @click="back">Back</button>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getProfileWithAvatarUrl, updateProfile, uploadAvatar } from '@/services/profileService';
import type { User } from '@/types';
import { useRouter } from 'vue-router';

export default defineComponent({
  setup() {
    const router = useRouter();

    const authStore = useAuthStore();
    const profile = ref<User | null>(null);

    onMounted(async () => {
      if (authStore.session?.user) {
        profile.value = await getProfileWithAvatarUrl(authStore.session.user.id);
      }
    });

    const signOut = async () => {
      await authStore.logout();
      router.go(0); // refresh page
    };
    const back = async () => {
      router.push({ name: 'Chat' });
    };
    const handleAvatarUpload = async (file: File) => {
      if (authStore.session?.user) {
        const filePath = await uploadAvatar(authStore.session.user.id, file);
        await updateProfile(authStore.session.user.id, { avatar_url: filePath });
        profile.value = { ...profile.value, avatar_url: filePath };
      }
    };

    const onFileChange = async (event: Event) => {
      const target = event.target as HTMLInputElement;
      if (target.files?.[0]) {
        await handleAvatarUpload(target.files[0]);
      }
    };

    return { profile, onFileChange, back, signOut };
  },
});
</script>

<style scoped>
  .avatar {
    width:128px;
    height:128px;
  }
</style>