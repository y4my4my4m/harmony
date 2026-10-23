<!--
  Removal of a local member from a server hosted elsewhere, by this instance's staff
  (instance_remove_member). The member leaves and is told; the server is not.
-->
<template>
  <BaseModal
    :show="show"
    :title="t('instanceServer.remove.action', { server: serverName, instance })"
    icon="shield"
    role="alertdialog"
    compact
    @close="close"
  >
    <div class="instance-remove" data-testid="instance-remove-dialog">
      <div class="user-preview">
        <Avatar :src="user.avatar_url" size="sm" />
        <div class="user-info">
          <span class="user-display-name">{{ name }}</span>
          <span class="user-username">@{{ user.username }}</span>
        </div>
      </div>

      <p class="consequence">
        {{ t('instanceServer.remove.confirmText', { name, server: serverName, instance }) }}
      </p>

      <label class="keep-out">
        <input v-model="keepOut" type="checkbox" data-testid="instance-remove-keepout" />
        <span>{{ t('instanceServer.remove.keepOut', { instance }) }}</span>
      </label>

      <div class="form-group">
        <label :for="reasonId">{{ t('instanceServer.remove.reasonLabel', { name }) }}</label>
        <textarea
          :id="reasonId"
          v-model="reason"
          class="form-textarea"
          maxlength="512"
          rows="2"
          data-testid="instance-remove-reason"
        />
      </div>
    </div>

    <template #footer>
      <div class="modal-actions">
        <UnifiedButton variant="ghost" :text="t('common.cancel')" :disabled="busy" @click="close" />
        <UnifiedButton
          variant="danger"
          :text="t('instanceServer.remove.confirm')"
          :loading="busy"
          data-testid="instance-remove-confirm"
          @click="confirm"
        />
      </div>
    </template>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useToast } from 'vue-toastification'
import BaseModal from '@/components/common/BaseModal.vue'
import Avatar from '@/components/common/Avatar.vue'
import UnifiedButton from '@/components/shared/UnifiedButton.vue'
import { useT } from '@/composables/useT'
import { getInstanceDomain } from '@/services/instanceConfig'
import { removeMemberHere, type RemoveResult } from '@/services/instanceServerTools'

interface MemberInfo {
  id: string
  username: string
  display_name?: string | null
  avatar_url?: string | null
}

const props = defineProps<{
  show: boolean
  serverId: string
  serverName: string
  user: MemberInfo
}>()

const emit = defineEmits<{
  close: []
  done: [result: RemoveResult]
}>()

const { t } = useT()
const toast = useToast()
const instance = getInstanceDomain()
const reasonId = `instance-remove-reason-${useId()}`

const keepOut = ref(false)
const reason = ref('')
const busy = ref(false)

const name = computed(() => props.user.display_name || props.user.username)

watch(() => props.show, (open) => {
  if (!open) return
  keepOut.value = false
  reason.value = ''
})

function close() {
  if (!busy.value) emit('close')
}

async function confirm() {
  if (busy.value) return
  busy.value = true
  try {
    const result = await removeMemberHere(props.serverId, props.user.id, keepOut.value, reason.value)
    toast.success(result.removed
      ? t('instanceServer.remove.done', { name: name.value, server: props.serverName, instance })
      : t('instanceServer.remove.notMember', { name: name.value }))
    emit('done', result)
  } catch (error: any) {
    toast.error(t('instanceServer.remove.failed', { name: name.value }) + (error?.message ? ` ${error.message}` : ''))
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.instance-remove {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.user-preview {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: var(--radius-base);
  background: var(--background-tertiary);
}

.user-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.user-display-name {
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-username {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.consequence {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}

.keep-out {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.keep-out input {
  margin-top: 3px;
  flex-shrink: 0;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group label {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--text-secondary);
}

.form-textarea {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-sm);
  background: var(--background-tertiary);
  color: var(--text-primary);
  font: inherit;
  resize: vertical;
}

.modal-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}
</style>
