<template>
  <div class="register-view" @mousemove="updateBackgroundRotation" :style="{'--random-bg': randomBg, '--bg-rotation-angle': bgRotation + 'deg'}">
    <div class="register-container">
      <div class="register-bg">
        <h1>Harmony</h1>
        <h2>Register</h2>
        <div class="inputs-container">
          <input v-model="email" type="email" placeholder="Email" />
          <input v-model="password" type="password" placeholder="Password" />
        </div>
        <div class="buttons">
          <button class="register" @click="register">Register</button>
          <button class="login" @click="$router.push('/login')">Login</button>
        </div>
        <img src="/icon_3d.png" class="logo" alt="Logo" @click="playSound" />
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
        const bgRotation = ref(0);
        const audio = ref(new Audio('/assets/sounds/pirori-wet.mp3'));

        const playSound = () => {
          audio.value.play();
        };

        const register = async () => {
          try {
            await authStore.register(email.value, password.value);
            router.push('/new-profile');
          } catch (error: any) {
            console.log(error);
            toast.error(error.message);
          }
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

        return { email, password, register, randomBg, updateBackgroundRotation, bgRotation, playSound };
    },
};
</script>

<style scoped>
  @import url('https://fonts.googleapis.com/css2?family=Arizonia&family=Press+Start+2P&family=Rubik+Moonrocks&display=swap');
  
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
    position: absolute;
    z-index:2;
    left:200px;
  }
  .register-container::before {
    position:absolute;
    content: '';
    top:0;
    left:0;
    right:0;
    bottom:0;
    background:var(--random-bg) center center;
    background-size: 100vw 100vh;
    background-position-x:-200px;
    z-index:3;
    filter: blur(15px);
  }
  .register-bg{
    /* background: rgba(0,0,0,0.93); */
    background: linear-gradient(var(--bg-rotation-angle), rgba(0,0,0,.9) 0%, rgba(0,0,0,0.7) 100%);
    padding: 40px 120px 100px 120px; 
    position: relative;
    z-index:5;
    border-radius:24px;
    box-shadow: -3px 7px 16px rgba(0,0,0,0.32), 4px 8px 16px rgba(0,0,0,0.22);
  }
  h1 {
    text-align: center;
    margin: 0px auto;
    font-weight:900;
    font-size: 9em;
    /* font-family: 'Rubik Moonrocks', sans-serif; */
    font-family: 'Arizonia', cursive;
    /* font-family: 'Press Start 2P', system-ui; */
    text-shadow: 3px 3px 4px #3141f8, 0px -3px 4px #e41616,  -6px 6px 32px #3142f889, 5px -5px 32px #e4161678;
    /* text-shadow: 0 3px 4px #4dff0c,  0 -3px 7px #3141f8,  -3px 0px 8px #e41616; */
  }

  h2 {
    text-align: center;
    font-weight:100;
    font-size:2em;
    position:relative;
    top: -15px;
  }
  .logo {
    display:block;
    margin: 15px auto;
    width: 8rem;
    height: 8rem;
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
    border-radius: 6px; /* Rounded corners */
    border: 1px solid #40444b; /* Subtle border */
    background-color: #2f3136; /* Slightly lighter than the background */
    color: white; /* White text */
    outline: none;
    font-size:1em;
  }
  input:focus{
    outline: none;
    border: 1px solid #7289da;
    box-shadow: 0 0 0 3px #7289da;
  }
  input:-webkit-autofill {
    -webkit-box-shadow:0 0 0 50px #24274e inset; /* Change the color to your own background color */
    border: 1px solid #242b37; /* Subtle border */
    -webkit-text-fill-color: #dddddd;
    font-size:1em;
  }

  input:-webkit-autofill:focus {
      -webkit-box-shadow: 0 0 0 50px #5865f2 inset;/*your box-shadow*/
      -webkit-text-fill-color: white;
  }
  .buttons {
    display: flex;
    justify-content: space-between;
    gap: 20px; /* Add spacing between sub elements */
  }
  button {
    display: block;
    width: 100%;
    margin: 15px auto;
    padding: 15px;
    border: none;
    border-radius: 6px;
    color: white;
    cursor: pointer;
    background: rgba(128,128,128,0.2);
    transition: .3s;
    font-size:1.15em;
    font-weight:bold;
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

  @media screen and (max-width: 768px) {
    .register-view {
      height: auto;
    }
    .register-container {
      left:0;
      position:relative;
    }
    .register-container::before {
      display:none;
    }
    .register-bg {
      padding: 20px 60px 60px 60px; 
      width:100vw;
      height:100vh;
      box-shadow:none;
      border-radius:0;
      display: block;
      /* flex-direction: column; */
      /* justify-content: space-around; */
    }
    .inputs-container {
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    h1 {
      font-size: 4.25rem;
    }
  }
</style>