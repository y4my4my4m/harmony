<template>
  <div class="auth-layout">
    <!-- Main Content Area -->
    <div class="auth-content">
      <RouterView />
    </div>
  </div>
</template>

<script setup lang="ts">
// No additional logic needed for auth layout - just a simple wrapper
</script>

<style scoped>
.auth-layout {
  width: 100vw;
  height: 100vh;
  height: 100dvh; /* mobile: exclude browser chrome so content isn't clipped */
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--h-background, #1e1f22);
  overflow: hidden;
}

.auth-content {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Ensure auth content takes full space without sidebars */
@media (max-width: 768px) {
  .auth-layout {
    padding: 0;
  }
  
  .auth-content {
    /* padding: 1rem; */
  }
}
</style>
