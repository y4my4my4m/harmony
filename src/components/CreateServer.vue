<template>
    <div class="create-server-form">
        <h2>Create a New Server</h2>
        <input v-model="serverName" placeholder="Server Name" />
        <button @click="createServer">Create Server</button>
        <p v-if="errorMessage" class="error-message">{{ errorMessage }}</p>
    </div>
</template>

<script lang="ts">
    import { ref } from 'vue';
    import { useServerChannelStore } from '@/stores/useServerChannel';
    import { useAuthStore } from '@/stores/auth';
    import { useRouter } from 'vue-router';

    export default {
        setup() {
            const serverName = ref('');
            const serverChannelStore = useServerChannelStore();
            const authStore = useAuthStore();
            const errorMessage = ref('');
            const router = useRouter();

            const createServer = async () => {
                if (!serverName.value) {
                    errorMessage.value = "Please enter a server name.";
                    return;
                }
                const userId = authStore.session?.user?.id;
                if (userId) {
                    const success = await serverChannelStore.createServer(serverName.value, userId);
                    if (success) {
                        // refresh page
                        router.go(0);
                    } else {
                        errorMessage.value = "Failed to create server.";
                    }
                }
            };

            return { serverName, createServer, errorMessage };
        },
    };
</script>

<style scoped>
    .create-server-form {
        /* Styles for your form */
    }
    .error-message {
        color: red;
    }
</style>