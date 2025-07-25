<template>
  <NotFound404 
    title="Server Not Found"
    description="The server you're looking for doesn't exist or you don't have access to it."
    home-button-text="Browse Servers"
    suggested-route="/browse-servers"
  />
</template>

<script setup lang="ts">
import NotFound404 from '@/components/error/NotFound404.vue'
</script>
