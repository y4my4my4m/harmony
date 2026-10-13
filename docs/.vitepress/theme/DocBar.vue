<script setup lang="ts">
import { computed } from 'vue'
import { useData } from 'vitepress'

const { page } = useData()
const file = computed(() => page.value.relativePath)
</script>

<template>
  <div class="hm-docbar" aria-hidden="true">
    <i class="hm-docbar-box" />
    <i class="hm-docbar-stripes" />
    <span class="hm-docbar-title">{{ file }}</span>
    <i class="hm-docbar-stripes" />
    <i class="hm-docbar-box hm-docbar-box--zoom" />
  </div>
</template>
