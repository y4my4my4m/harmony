<template>
    <div>
      <img src="/icon.png" class="logo" alt="Logo" />
      <h2>Register</h2>
      <input v-model="email" type="email" placeholder="Email" />
      <input v-model="password" type="password" placeholder="Password" />
      <button @click="register">Register</button>
      <a href="/login">Login</a>
    </div>
</template>

<script lang="ts">
import { ref } from 'vue';
import { useAuthStore } from '../stores/auth';

export default {
    setup() {
        const email = ref('');
        const password = ref('');
        const authStore = useAuthStore();

        const register = async () => {
            await authStore.register(email.value, password.value);
        };

        return { email, password, register };
    },
};
</script>
<style scoped>
  .logo {
    display:flex;
    margin: 0 auto;
    width: 128px;
    height: 128px;
  }
  h2 {
    text-align: center;
    margin: 40px auto;
  }
  a {
    display: block;
    text-align: center;
    margin-top: 20px;
  }
</style>