<template>
  <AuthComponent :isLogin="false" />
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import AuthComponent from '@/components/AuthComponent.vue'

export default defineComponent({
  name: 'RegisterView',
  components: {
    AuthComponent,
  },
})
</script>
