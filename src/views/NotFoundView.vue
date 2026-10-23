<template>
  <NotFound404 />
</template>

<script setup lang="ts">
import NotFound404 from '@/components/error/NotFound404.vue'

// RouterView props and listeners stay off the root element.
defineOptions({ inheritAttrs: false })
</script>
