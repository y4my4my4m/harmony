<!-- NoServersSplash.vue -->
<template>
    <CreateServerForm v-if="showCreateServerForm" />
    <div v-else class="no-servers-splash">
        <h2>Welcome to the Harmony!</h2>
        <p>You are not part of any servers yet.</p>
        <button @click="showCreateServerForm = true">Create a Server</button>
        <button>TODO: Join a Server</button>
    </div>
</template>
  
<script lang="ts">
    import CreateServerForm from './CreateServer.vue';
    import { ref } from 'vue';

    export default {
    components: {
        CreateServerForm,
    },
    setup() {
        const showCreateServerForm = ref(false);
        return { showCreateServerForm };
    },
    };
</script>

<style scoped>
    .no-servers-splash {
        /* Styles for your splash screen */
    }
</style>
  