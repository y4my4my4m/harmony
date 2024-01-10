<template>
    <div>
      <input v-model="email" type="email" placeholder="Email" />
      <input v-model="password" type="password" placeholder="Password" />
      <button @click="register">Register</button>
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
        const { error } = await authStore.register(email.value, password.value);
        if (error) {
            console.error('Error registering:', error);
        } else {
            // Redirect or emit event
        }
        };

        return { email, password, register };
    },
};
</script>