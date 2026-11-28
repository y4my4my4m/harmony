<template>
  <NotFound404 
    :title="t('notFound.serverTitle')"
    :description="t('notFound.serverNotFound')"
    :home-button-text="t('notFound.browseServers')"
    suggested-route="/browse-servers"
  />
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import NotFound404 from '@/components/error/NotFound404.vue'

const { t } = useI18n()
</script>
