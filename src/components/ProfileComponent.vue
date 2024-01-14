<template>
  <div class="user-settings">
    <div v-if="profile" class="profile">
      <img class="avatar" :src="profile.avatar_url" alt="Avatar">
      <div class="info">
        <p><span class="label">DisplayName:</span> {{ profile.display_name }}</p>
        <p><span class="label">Username:</span> {{ profile.username }}</p>
        <p><span class="label">About:</span> {{ profile.about }}</p>
      </div>
    </div>
    <input type="file" @change="onFileChange" class="file-input" />
    <div class="buttons">
      <button @click="signOut" class="btn sign-out">Sign Out</button>
      <button @click="back" class="btn back">Back</button>
    </div>
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
  .user-settings {
    background-color: #36393f;
    padding: 20px;
    border-radius: 8px;
    max-width: 400px;
    margin: auto;
    color: white;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  }

  .profile {
    display: flex;
    align-items: center;
    margin-bottom: 20px;
  }

  .avatar {
    width: 128px;
    height: 128px;
    border-radius: 50%;
    object-fit: cover;
    margin-right: 20px;
  }

  .info p {
    margin: 5px 0;
    font-size: 0.9rem;
  }

  .label {
    font-weight: bold;
  }

  .file-input {
    margin-bottom: 10px;
    cursor: pointer;
  }

  .buttons {
    display: flex;
    justify-content: space-between;
  }

  .btn {
    padding: 10px 15px;
    border: none;
    border-radius: 5px;
    color: white;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .sign-out {
    background-color: #f04747; /* Red color for sign out */
  }

  .back {
    background-color: #5865f2; /* Discord's primary blue color */
  }
  .btn:hover {
  opacity: 0.8;
  }
</style>