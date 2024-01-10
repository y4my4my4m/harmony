<template>
  <div>
    <h2>Login</h2>
    <input v-model="email" type="email" placeholder="Email" />
    <input v-model="password" type="password" placeholder="Password" />
    <button @click="login">Login</button>
  </div>
</template>

<script lang="ts">
import { ref, defineComponent } from 'vue';
import { useAuthStore } from '../stores/auth';

export default defineComponent({
  setup() {
    const email = ref('');
    const password = ref('');
    const authStore = useAuthStore();

    const login = async () => {
      const { error } = await authStore.login(email.value, password.value);
      if (error) {
        console.error('Error logging in:', error);
      }
    };

    return { email, password, login };
  },
});
</script>
