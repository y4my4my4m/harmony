<template>
  <div class="login-view">
    <LoginComponent />
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import LoginComponent from '../components/LoginComponent.vue';

export default defineComponent({
  name: 'LoginView',
  components: {
    LoginComponent
  }
});
</script>

<style scoped>
.login-view {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100vh;
}
</style>
