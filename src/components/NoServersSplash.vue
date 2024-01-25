<!-- NoServersSplash.vue -->
<template>
    <CreateServerForm v-if="showCreateServerForm" />
    <div v-else class="no-servers-splash">
        <h2>Welcome to the Harmony!</h2>
        <p>You are not part of any servers yet.</p>
        <button @click="showCreateServerForm = true">Create a Server</button>
        <button @click="togglePublicServers">Join a Server</button>
    </div>
</template>
  
<script lang="ts">
    import CreateServerForm from './CreateServer.vue';
    import { ref, watch } from 'vue';

    export default {
        components: {
            CreateServerForm,
        },
        setup(props, { emit }) {
            const showPublicServers = ref(false);
            const togglePublicServers = () => {
                showPublicServers.value = !showPublicServers.value;
            };

            watch(showPublicServers, (value) => {
            if (value) {
                emit('show-public-servers', value); 
            }
            });
            const showCreateServerForm = ref(false);
            return { 
                showCreateServerForm,
                togglePublicServers
            };
        },
    };
</script>

<style scoped>
    .no-servers-splash {
        color: #ffffff;
        background-color: #36393f;
        font-family: 'Whitney', 'Helvetica Neue', Helvetica, Arial, sans-serif;
        text-align: center;
        padding: 50px;
        border-radius: 8px;
        max-width: 600px;
        margin: 50px auto;
        box-shadow: 0 4px 12px 0 rgba(0,0,0,0.2);
    }

    .no-servers-splash h2 {
        color: #7289da; /* Discord's primary brand color */
        margin-bottom: 20px;
        font-size: 28px;
    }

    .no-servers-splash p {
        margin-bottom: 30px;
        font-size: 16px;
        line-height: 1.5;
    }

    .no-servers-splash button {
        background-color: #7289da;
        border: none;
        color: white;
        padding: 10px 20px;
        font-size: 16px;
        border-radius: 4px;
        cursor: pointer;
        transition: background-color 0.2s;
    }

    .no-servers-splash button:hover {
        background-color: #5b6eae;
    }

    .no-servers-splash button:active {
        background-color: #4e5d94;
    }

    .no-servers-splash button:last-child {
        margin-left: 10px;
    }

</style>
  