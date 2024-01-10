<template>
  <div>
    <h1>Login</h1>
    <form @submit.prevent="login">
      <input type="text" placeholder="Username" v-model="username" />
      <input type="password" placeholder="Password" v-model="password" />
      <button type="submit">Login</button>
    </form>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue';
import { useStore } from '@/stores';
import { useRouter } from 'vue-router';

export default defineComponent({
  setup() {
    const username = ref('');
    const password = ref('');
    const store = useStore();
    const router = useRouter();

    const login = () => {
      // Simulate login logic - setting a "test" user
      store.loginUser({ username: 'test', password: 'test' });
      console.log('Logged in as test user');
      router.push({ name: 'Chat' }); // Redirect to the chat view after login
    };

    return { username, password, login };
  }
});
</script>
