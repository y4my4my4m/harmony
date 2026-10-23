<!--
  Block of a server hosted elsewhere on this instance (instance_set_server_blocked): the
  consequences before the step is taken. The block ends every membership from here, join
  requests and the blocking staff member's own included; each count comes from the people list.
-->
<template>
  <BaseModal
    :show="show"
    :title="t('instanceServer.block.action', { server: serverName, instance })"
    icon="shield-off"
    role="alertdialog"
    compact
    @close="close"
  >
    <div class="instance-block" data-testid="instance-block-dialog">
      <ul class="consequences">
        <li>{{ t('instanceServer.block.consequenceSee', { instance }) }}</li>
        <li data-testid="instance-block-members">
          {{ t('instanceServer.block.consequenceMembers', { count: affected.members, instance }, affected.members) }}
        </li>
        <li v-if="affected.waiting > 0" data-testid="instance-block-waiting">
          {{ t('instanceServer.block.consequenceWaiting', { count: affected.waiting, instance }, affected.waiting) }}
        </li>
        <li v-if="affected.includesYou" class="consequence-you" data-testid="instance-block-you">
          {{ t('instanceServer.block.consequenceYou', { server: serverName }) }}
        </li>
        <li>{{ t('instanceServer.block.consequenceElsewhere', { server: serverName }) }}</li>
      </ul>

      <div class="form-group">
        <label :for="reasonId">{{ t('instanceServer.block.reasonLabel', { instance }) }}</label>
        <textarea
          :id="reasonId"
          v-model="reason"
          class="form-textarea"
          maxlength="500"
          rows="2"
          data-testid="instance-block-reason"
        />
      </div>
    </div>

    <template #footer>
      <div class="modal-actions">
        <UnifiedButton variant="ghost" :text="t('common.cancel')" :disabled="busy" @click="close" />
        <UnifiedButton
          variant="danger"
          :text="t('instanceServer.block.confirm')"
          :loading="busy"
          data-testid="instance-block-confirm"
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
import UnifiedButton from '@/components/shared/UnifiedButton.vue'
import { useT } from '@/composables/useT'
import { getInstanceDomain } from '@/services/instanceConfig'
import { setServerBlocked, type BlockResult, type RemoteServerPerson } from '@/services/instanceServerTools'
import { useProfileStore } from '@/stores/useProfile'

const props = defineProps<{
  show: boolean
  serverId: string
  serverName: string
  /** Accounts from here in the server (instance_remote_server_people). */
  people: RemoteServerPerson[]
}>()

const emit = defineEmits<{
  close: []
  done: [result: BlockResult]
}>()

const { t } = useT()
const toast = useToast()
const instance = getInstanceDomain()
const reasonId = `instance-block-reason-${useId()}`
const profileStore = useProfileStore()

// Kept-out people hold no membership; the block does not touch them.
const affected = computed(() => {
  const inServer = props.people.filter((person) => person.standing !== 'kept_out')
  const me = profileStore.profile?.id
  return {
    members: inServer.filter((person) => person.standing === 'accepted').length,
    waiting: inServer.filter((person) => person.standing === 'pending').length,
    includesYou: !!me && inServer.some((person) => person.profile_id === me),
  }
})

const reason = ref('')
const busy = ref(false)

watch(() => props.show, (open) => {
  if (open) reason.value = ''
})

function close() {
  if (!busy.value) emit('close')
}

async function confirm() {
  if (busy.value) return
  busy.value = true
  try {
    const result = await setServerBlocked(props.serverId, true, reason.value)
    toast.success(t('instanceServer.block.done', { server: props.serverName, instance }))
    emit('done', result)
  } catch (error: any) {
    toast.error(t('instanceServer.block.failed') + (error?.message ? ` ${error.message}` : ''))
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.instance-block {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.consequences {
  margin: 0;
  padding-left: 20px;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.6;
}

.consequences li + li {
  margin-top: 4px;
}

.consequence-you {
  color: var(--text-primary);
  font-weight: var(--font-weight-semibold);
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
