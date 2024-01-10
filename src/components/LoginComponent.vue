<template>
  <div>
    <img src="/icon.png" class="logo" alt="Logo" />
    <h2>Login</h2>
    <input v-model="email" type="email" placeholder="Email" />
    <input v-model="password" type="password" placeholder="Password" />
    <button @click="login">Login</button>
    <a href="/register">Register</a>
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
      await authStore.login(email.value, password.value);
    };

    return { email, password, login };
  },
});
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