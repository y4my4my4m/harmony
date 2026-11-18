<template>
  <BaseModal :show="show" :title="t('roleMenu.createTitle')" icon="users" compact @close="close">
    <form class="rm-form" data-testid="role-menu-create" @submit.prevent="submit">
      <p v-if="!hasPickable" class="rm-empty" data-testid="role-menu-create-empty">{{ t('roleMenu.noRoles') }}</p>
      <template v-else>
        <label class="rm-label" for="role-menu-group">{{ t('roleMenu.group') }}</label>
        <select id="role-menu-group" v-model="group" class="rm-input" data-testid="role-menu-group">
          <option :value="ALL">{{ t('roleMenu.allGroups') }}</option>
          <option v-for="name in groupNames" :key="name" :value="name">{{ name }}</option>
        </select>

        <label class="rm-label" for="role-menu-title">{{ t('roleMenu.titleLabel') }}</label>
        <input
          id="role-menu-title"
          v-model="title"
          class="rm-input"
          type="text"
          maxlength="100"
          :placeholder="t('roleMenu.defaultTitle')"
          data-testid="role-menu-title"
        />

        <div class="rm-preview" :aria-label="t('roleMenu.preview')">
          <span class="rm-preview-label">{{ t('roleMenu.preview') }}</span>
          <RoleChipGroup
            v-for="g in previewGroups"
            :key="g.name ?? ''"
            :roles="g.roles"
            :held="none"
            :pending="none"
            :label="t('roleMenu.preview')"
            disabled
          />
        </div>
      </template>
    </form>
    <template #footer>
      <div class="rm-actions">
        <UnifiedButton variant="ghost" :text="t('common.cancel')" @click="close" />
        <UnifiedButton
          variant="primary"
          :text="t('roleMenu.post')"
          :disabled="!hasPickable"
          :loading="posting"
          data-testid="role-menu-post"
          @click="submit"
        />
      </div>
    </template>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import BaseModal from '@/components/common/BaseModal.vue'
import UnifiedButton from '@/components/shared/UnifiedButton.vue'
import RoleChipGroup from '@/components/roles/RoleChipGroup.vue'
import { useServerRolesStore } from '@/stores/useServerRoles'
import { useProfileStore } from '@/stores/useProfile'
import { sendToTarget } from '@/stores/shared/sendToTarget'
import { pickableRoleGroups, selfAssignGroupNames } from '@/utils/selfAssignableRoles'
import { roleMenuMessageParts } from '@/utils/roleMenu'
import type { MessagePart } from '@/types'

const props = defineProps<{
  show: boolean
  serverId: string
  channelId: string
  replyTo?: string | null
}>()

const emit = defineEmits<{ close: [] }>()

const ALL = '\u0000all'

const { t } = useI18n()
const toast = useToast()
const rolesStore = useServerRolesStore()
const profileStore = useProfileStore()

const group = ref<string>(ALL)
const title = ref('')
const posting = ref(false)
const none = new Set<string>()

onMounted(() => { void rolesStore.ensureServerLoaded(props.serverId) })

const roles = computed(() => rolesStore.rolesByServer.get(props.serverId) ?? [])
const groupNames = computed(() => selfAssignGroupNames(roles.value))
const selectedGroup = computed(() => (group.value === ALL ? null : group.value))
const previewGroups = computed(() => pickableRoleGroups(roles.value, selectedGroup.value))
const hasPickable = computed(() => pickableRoleGroups(roles.value).length > 0)

function close() {
  if (!posting.value) emit('close')
}

async function submit() {
  const authorId = profileStore.profileId
  if (!hasPickable.value || posting.value || !authorId) return
  posting.value = true
  try {
    const names = previewGroups.value.flatMap((g) => g.roles.map((r) => r.name))
    const parts = roleMenuMessageParts(props.serverId, selectedGroup.value, title.value || t('roleMenu.defaultTitle'), names)
    const outcome = await sendToTarget(
      { kind: 'channel', serverId: props.serverId, channelId: props.channelId },
      authorId,
      parts as MessagePart[],
      props.replyTo ?? undefined,
    )
    if (outcome === 'ok') emit('close')
    else if (outcome === 'failed') toast.error(t('roleMenu.postFailed'))
  } catch {
    toast.error(t('roleMenu.postFailed'))
  } finally {
    posting.value = false
  }
}
</script>

<style scoped>
.rm-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rm-label {
  font-weight: 600;
  font-size: var(--font-size-sm, 14px);
  color: var(--text-primary);
}

.rm-input {
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-primary);
  background: var(--bg-primary);
  color: var(--text-primary);
  font: inherit;
  margin-bottom: 8px;
}

.rm-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 10px;
  background: var(--bg-secondary);
}

.rm-preview-label {
  font-size: var(--font-size-xs, 12px);
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 700;
}

.rm-empty {
  margin: 0;
  color: var(--text-secondary);
}

.rm-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}
</style>
