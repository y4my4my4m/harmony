<template>
  <div class="login-view" @mousemove="updateBackgroundRotation" :style="{'--random-bg': randomBg, '--bg-rotation-angle': bgRotation + 'deg'}">
    <div class="login-container">
      <div class="login-bg">
        <h1>Harmony</h1>
        <input v-model="email" type="email" placeholder="Email" />
        <input v-model="password" type="password" placeholder="Password" />
        <br/>
        <div class="buttons">
          <button class="login" @click="login">Login</button>
          <button class="register" @click="$router.push('/register')">Register</button>
        </div>
        <img src="/icon_3d.png" class="logo" alt="Logo" />
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { ref, defineComponent, onMounted } from 'vue';
import { useAuthStore } from '../stores/auth';

export default defineComponent({
  setup() {
    const email = ref('');
    const password = ref('');
    const authStore = useAuthStore();
    const randomBg = ref('');
    const bgRotation = ref(0);

    const login = async () => {
      await authStore.login(email.value, password.value);
    };

    const updateBackgroundRotation = (event: any) => {
      const x = event.clientX - (window.innerWidth / 2);
      const y = event.clientY - (window.innerHeight / 2);
      const angle = Math.atan2(y, x) * (180 / Math.PI);
      bgRotation.value = angle;
    };


    onMounted(() => {
      randomBg.value = `url('/img/login_bg${Math.floor(Math.random() * 41) + 1}.png')`;
    });

    return { email, password, login, randomBg, updateBackgroundRotation, bgRotation };
  },
});
</script>

<style scoped>
  @import url('https://fonts.googleapis.com/css2?family=Arizonia&family=Press+Start+2P&family=Rubik+Moonrocks&display=swap');
  
  .login-view {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100vh;
    background:var(--random-bg) center center;
    background-size: cover;
    background-attachment: fixed;
  }
  .login-container {
    position:relative;
    z-index:2;
  }
  .login-container::before {
    position:absolute;
    content: '';
    top:0;
    left:0;
    right:0;
    bottom:0;
    background:var(--random-bg) center center;
    background-size: 100vw 100vh;
    z-index:3;
    filter: blur(15px);
  }
  .login-bg{
    /* background: rgba(0,0,0,0.93); */
    background: linear-gradient(var(--bg-rotation-angle), rgba(0,0,0,.9) 0%, rgba(0,0,0,0.7) 100%);
    padding: 40px 140px 100px 140px; 
    position: relative;
    z-index:5;
    border-radius:24px;
    box-shadow: -3px 7px 16px rgba(0,0,0,0.32), 4px 8px 16px rgba(0,0,0,0.22);
  }
  h1 {
    text-align: center;
    margin: 0px auto;
    font-weight:900;
    font-size: 12em;
    /* font-family: 'Rubik Moonrocks', sans-serif; */
    font-family: 'Arizonia', cursive;
    /* font-family: 'Press Start 2P', system-ui; */
    text-shadow: 3px 3px 4px #3141f8, 0px -3px 4px #e41616,  -6px 6px 32px #3142f889, 5px -5px 32px #e4161678;
    /* text-shadow: 0 3px 4px #4dff0c,  0 -3px 7px #3141f8,  -3px 0px 8px #e41616; */
  }

  h2 {
    text-align: center;
    margin: 20px auto;
    font-weight:500;
    font-size:2em;
  }
  .logo {
    display:block;
    margin: 20px auto;
    width: 12rem;
    height: 12rem;
    position:relative;
    top: 50px;
    cursor: pointer;
    transition: .3s;
    /* border-radius:16px; */
    /* box-shadow: -2px 5px 16px rgba(0,0,0,0.12), 3px 6px 16px rgba(0,0,0,0.16); */
  }
  .logo:hover {
    transform: scale(1.1);
  }

  input {
    display: block;
    width: 100%;
    margin: 20px auto;
    padding: 10px;
    border-radius: 5px; /* Rounded corners */
    border: 1px solid #40444b; /* Subtle border */
    background-color: #2f3136; /* Slightly lighter than the background */
    color: white; /* White text */
    outline: none;
    font-size:2em;
  }
  .buttons {
    display: flex;
    justify-content: space-between;
    gap: 20px; /* Add spacing between sub elements */
  }
  button {
    display: block;
    width: 100%;
    margin: 20px auto;
    padding: 20px;
    border: none;
    border-radius: 6px;
    color: white;
    cursor: pointer;
    background: rgba(128,128,128,0.2);
    transition: .3s;
    font-size:1.75em;
    font-weight:bold;
  }
  button.login {
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