<template>
  <div class="register-view" :style="{'--random-bg': randomBg}">
    <div class="register-container">
      <div class="register-bg">
        <h1>Harmony<img src="/icon_3d.png" class="logo" alt="Logo" /></h1>
        <h2>Register</h2>
        <input v-model="email" type="email" placeholder="Email" />
        <input v-model="password" type="password" placeholder="Password" />
        <button class="register" @click="register">Register</button>
        <button class="login" @click="$router.push('/Login')">Login</button>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { ref, onMounted } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useRouter } from 'vue-router';
import { useToast } from 'vue-toastification';

export default {
    setup() {
        const email = ref('');
        const password = ref('');
        const authStore = useAuthStore();
        const toast = useToast();
        const router = useRouter();
        const randomBg = ref('');

        const register = async () => {
          try {
            await authStore.register(email.value, password.value);
            router.push('/new-profile');
          } catch (error: any) {
            console.log(error);
            toast.error(error.message);
          }
        };

        onMounted(() => {
          randomBg.value = `url('/img/login_bg${Math.floor(Math.random() * 41) + 1}.png')`;
        });

        return { email, password, register, randomBg };
    },
};
</script>

<style scoped>
  .register-view {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100vh;
    background:var(--random-bg) center center;
    background-size: cover;
    background-attachment: fixed;
  }
  .register-container {
  }
  .register-container::before {
    position:absolute;
    content: '';
    top:0;
    left:0;
    right:0;
    bottom:0;
    background:var(--random-bg) center center;
    background-size: 67.5vw 67.5vh;
    z-index:3;
    filter: blur(5px);
  }
  .register-bg{
    background: rgba(0,0,0,0.8);
    padding: 40px 140px; 
    position: relative;
    z-index:5;
    border-radius:10px;
    box-shadow: -3px 7px 16px rgba(0,0,0,0.32), 4px 8px 16px rgba(0,0,0,0.22);
  }
  .logo {
    display:inline-flex;
    margin: 0 10px;
    width: 64px;
    height: 64px;
    position:relative;
    top: 16px;
    /* border-radius:16px; */
    /* box-shadow: -2px 5px 16px rgba(0,0,0,0.12), 3px 6px 16px rgba(0,0,0,0.16); */
  }
  h1 {
    text-align: center;
    margin: 20px auto;
    font-weight:900;
    font-size:42px;
  }

  h2 {
    text-align: center;
    margin: 20px auto;
    font-weight:500;
  }

  input {
    display: block;
    width: 100%;
    margin: 10px auto;
    padding: 10px;
    border-radius: 5px; /* Rounded corners */
    border: 1px solid #40444b; /* Subtle border */
    background-color: #2f3136; /* Slightly lighter than the background */
    color: white; /* White text */
    outline: none;
  }

  button {
    display: block;
    width: 100%;
    margin: 20px auto;
    padding: 10px;
    border: none;
    border-radius: 5px;
    color: white;
    cursor: pointer;
    background: rgba(0,0,0,0.1);
    transition: .3s;
  }
  button.register {
    background-color: #4752c4; /* Slightly darker blue on hover */
  }

  button:hover {
    background-color: #5865f2; /* Discord's blue color */
  }

  a {
    display: block;
    text-align: center;
    margin-top: 20px;
    color: #7289da; /* Lighter blue for links */
    text-decoration: none;
  }

  a:hover {
    text-decoration: underline;
  }
</style>