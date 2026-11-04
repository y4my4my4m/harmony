<!-- The Support window, wherever it is opened from (useFundingStore().openModal). Loaded on first open. -->
<template>
  <FundingModal v-if="store.modal" />
</template>

<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import { useFundingStore } from '@/stores/useFunding'

const FundingModal = defineAsyncComponent(() => import('@/components/FundingModal.vue'))
const store = useFundingStore()
</script>
