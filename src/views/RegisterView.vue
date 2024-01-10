<template>
    <div class="register-view">
      <h2>Register</h2>
      <RegistrationComponent />
    </div>
  </template>
  
  <script lang="ts">
  import { defineComponent } from 'vue';
  import RegistrationComponent from '../components/RegistrationComponent.vue';
  
  export default defineComponent({
    components: {
      RegistrationComponent,
    },
  });
  </script>
  
<style scoped>
.register-view {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100vh;
}
</style>
