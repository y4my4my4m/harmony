<template>
  <p class="db-muted">
    <i18n-t keypath="discordBridge.self.docker" tag="span" scope="global">
      <template #desktop>
        <a :href="DOCKER_DESKTOP_URL" target="_blank" rel="noopener noreferrer">Docker Desktop</a>
      </template>
      <template #engine>
        <a :href="DOCKER_ENGINE_URL" target="_blank" rel="noopener noreferrer">Docker Engine</a>
      </template>
    </i18n-t>
  </p>
</template>

<script setup lang="ts">
const DOCKER_DESKTOP_URL = 'https://www.docker.com/products/docker-desktop/'
const DOCKER_ENGINE_URL = 'https://docs.docker.com/engine/install/'
</script>

<style scoped src="./bridge.css"></style>
