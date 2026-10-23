<template>
  <span
    v-if="label"
    class="federated-user-badge"
    role="img"
    :aria-label="label"
    :title="label"
    data-testid="federated-user-badge"
  >
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M17.9,17.39C17.64,16.59 16.89,16 16,16H15V13A1,1 0 0,0 14,12H8V10H10A1,1 0 0,0 11,9V7H13A2,2 0 0,0 15,5V4.59C17.93,5.77 20,8.64 20,12C20,14.08 19.2,15.97 17.9,17.39M11,19.93C7.05,19.44 4,16.08 4,12C4,11.38 4.08,10.79 4.21,10.21L9,15V16A2,2 0 0,0 11,18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" />
    </svg>
  </span>
</template>

<script setup lang="ts">
// Globe after the name of a user from another instance (profiles.is_local false).
// Reads the profile cache only; an uncached profile counts as local.
import { computed } from 'vue'
import { useUserData } from '@/composables/useUserData'
import { useT } from '@/composables/useT'

const props = defineProps<{
  userId: string | null | undefined
}>()

const { t } = useT()
const { getUser } = useUserData()

const label = computed<string | null>(() => {
  if (!props.userId) return null
  const user = getUser(props.userId).value
  if (!user || user.isLocal !== false) return null
  return user.domain
    ? t('activitypub.fromDomain', { domain: user.domain })
    : t('federation.federatedUser')
})
</script>

<style scoped>
/* Size and colour of the federated-mention globe (UnifiedMessageContent);
   spacing of BridgedSourceIcon. */
.federated-user-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-left: 6px;
  line-height: 0;
  color: #10b981;
  vertical-align: middle;
}

/* #10b981 is 2.5:1 on white; #059669 is 3.8:1. */
:root[data-theme-type="light"] .federated-user-badge {
  color: #059669;
}
</style>
