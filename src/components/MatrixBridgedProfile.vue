<template>
  <UnifiedModal :model-value="!!user" :title="user?.displayName || user?.username || 'Matrix'" size="sm"
    @update:model-value="(open: boolean) => { if (!open) emit('close') }">
    <template v-if="user">
      <Avatar :src="user.avatarUrl || '/default_avatar.webp'" size="lg" />
      <BridgeSourceBadge source="matrix" />
      <p class="matrix-id">{{ user.id }}</p>
      <p>{{ t('matrixBridge.externalIdentity') }}</p>
      <a v-if="profileUrl" :href="profileUrl" target="_blank" rel="noopener noreferrer">{{ t('matrixBridge.openMatrix') }}</a>
    </template>
  </UnifiedModal>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UnifiedModal from '@/components/shared/UnifiedModal.vue'
import Avatar from '@/components/common/Avatar.vue'
import BridgeSourceBadge from '@/components/messages/BridgeSourceBadge.vue'
import type { BridgedChannelUser } from '@/services/bridgedChannelUsersService'
import { matrixProfileUrl } from '@/utils/matrixMentions'
const props = defineProps<{ user: BridgedChannelUser | null }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const profileUrl = computed(() => matrixProfileUrl(props.user?.id || ''))
</script>
<style scoped>
.matrix-id { overflow-wrap: anywhere; user-select: text; }
</style>
