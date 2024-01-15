<template>
    <div class="new-profile">
        <h2>Create Your Profile</h2>
        <div class="input-wrapper">
            <span class="at-symbol">@</span>
            <input v-model="username" maxlength="24" @input="formatUsername" type="text" class="username-input" placeholder="username">
            <span class="domain" :style="{ left: usernameOffset + 'px' }">@{{ domain }}</span>
        </div>
        <input v-model="displayName" placeholder="Display Name" />
        <!-- <textarea v-model="about" placeholder="About"></textarea> -->
        <button @click="createProfile">Create Profile</button>
    </div>
</template>
  
<script lang="ts">
    import { ref, computed } from 'vue';
    import { useProfileStore } from '@/stores/useProfile';
    import { useAuthStore } from '@/stores/auth';
    import { useRouter } from 'vue-router';
    import { useToast } from 'vue-toastification';

    export default {
        setup() {
            const username = ref('');
            const domain = import.meta.env.VITE_DOMAIN;
            const displayName = ref('');
            const about = ref('');
            const profileStore = useProfileStore();
            const authStore = useAuthStore();
            const router = useRouter();

            const toast = useToast();

            const usernameOffset = computed(() => {
                let baseOffset = 28; // Adjust this based on the initial position of the '@' symbol
                const charWidth = 8; // Approximate width of each character
                // Calculate the offset based on the length of the username
                if(username.value.length === 0){
                    baseOffset = 93;
                }
                return baseOffset + username.value.length * charWidth;
            });

            const formattedUsername = computed(() => {
                return username.value ? `@${username.value}@${domain}` : '';
            });
            const formatUsername = (event: any) => {
                username.value = event.target.value.replace(/[^a-zA-Z0-9]/g, ''); // This regex removes any non-alphanumeric characters
            };

            const createProfile = async () => {
            if (authStore.session?.user) {
                try {
                    await profileStore.createProfile({
                        id: authStore.session.user.id,
                        username: formattedUsername.value,
                        display_name: displayName.value,
                        color: '#ffffff',
                    });
                    toast.success('Profile created!');
                    router.push('/chat');
                } catch (error: any) {
                    toast.error(error.message);
                }
            }
            };

            return { username, displayName, about, createProfile, domain, formatUsername, usernameOffset };
        },
    };
</script>

<style scoped>
    .new-profile {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 20px;
        border-radius: 8px;
        background-color: #36393f;
        color: white;
        max-width: 500px;
        margin: auto;
    }

    .new-profile h2 {
        color: white;
        margin-bottom: 20px;
    }

    .new-profile input,
    .new-profile textarea {
        width: 100%;
        padding: 10px;
        margin: 10px 0;
        border-radius: 5px;
        border: 1px solid #40444b;
        background-color: #2f3136;
        color: white;
    }

    .new-profile button {
        padding: 10px 15px;
        margin-top: 10px;
        background-color: #5865f2;
        color: white;
        border: none;
        border-radius: 5px;
        cursor: pointer;
    }

    .new-profile button:hover {
        background-color: #4e5cd1;
    }


    .input-wrapper {
        position: relative;
        width: 100%;
    }

    .username-input {
        padding: 10px 10px 10px 25px!important; /* Adjust left padding for "@" symbol */
        color: white; /* Text color */
        font-size:15px;
    }
    /* styling for username-input's placeholder */
    .username-input::placeholder {
        color: white;
        font-size:15px;
    }

    .at-symbol, .domain {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        color: grey;
        pointer-events: none;
    }

    .at-symbol {
        left: 10px;
    }

</style>
  