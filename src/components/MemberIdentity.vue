<template>
  <span class="member-identity"><DisplayName :user-id="userId" :fallback="fallback" :truncate="truncate" /><span v-if="handle" class="member-identity-handle">{{ ` (@${handle})` }}</span><span v-if="nickname" class="member-identity-nickname">{{ ` (${nickname})` }}</span></span>
</template>

<script setup lang="ts">
/**
 * A person on a moderation screen: "Account Name (@username)", with " (Server Nickname)"
 * after it when the member has one in the server. A nickname alone would hide who a moderator
 * is acting on, so the account name always shows.
 */
import { computed } from 'vue'
import DisplayName from '@/components/DisplayName.vue'
import { useUserData } from '@/composables/useUserData'
import { getMemberServerProfile } from '@/composables/useMemberProfile'

const props = defineProps<{
  userId: string
  serverId?: string | null
  /** Shown while the account is not loaded. */
  fallback?: string
  /** Used when the account's username is not loaded. */
  username?: string | null
  truncate?: boolean
}>()

const { getUser } = useUserData()

const handle = computed(() => getUser(props.userId).value?.username || props.username || '')
const nickname = computed(() => {
  if (!props.serverId) return ''
  return getMemberServerProfile(props.userId, props.serverId).value?.nickname?.trim() || ''
})
</script>

<style scoped>
.member-identity-handle,
.member-identity-nickname {
  color: var(--text-muted);
}
</style>
