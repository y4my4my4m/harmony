<!--
  A moderator sets or clears another member's server nickname (moderate_server_profile).
  An empty value clears it.
-->
<template>
  <BaseModal
    :show="show"
    :title="t('moderation.serverProfile.nicknameTitle')"
    icon="shield"
    compact
    @close="close"
  >
    <form class="nickname-form" data-testid="moderate-nickname-form" @submit.prevent="submit">
      <div class="user-preview">
        <Avatar :src="user.avatar_url" size="sm" />
        <div class="user-info">
          <span class="user-display-name">{{ name }}</span>
          <span class="user-username">@{{ user.username }}</span>
        </div>
      </div>

      <div class="form-group">
        <label :for="inputId">{{ t('moderation.serverProfile.nicknameLabel', { name }) }}</label>
        <input
          :id="inputId"
          v-model="draft"
          class="form-input"
          type="text"
          maxlength="64"
          autocomplete="off"
          :placeholder="t('moderation.serverProfile.nicknamePlaceholder')"
          data-testid="moderate-nickname-input"
        />
        <span class="hint">{{ t('moderation.serverProfile.nicknameHint') }}</span>
      </div>
    </form>

    <template #footer>
      <div class="modal-actions">
        <UnifiedButton variant="ghost" :text="t('common.cancel')" :disabled="busy" @click="close" />
        <UnifiedButton
          variant="primary"
          :text="t('common.save')"
          :loading="busy"
          data-testid="moderate-nickname-submit"
          @click="submit"
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
import { getMemberServerProfile } from '@/composables/useMemberProfile'
import { moderationErrorMessage } from '@/composables/useModerateServerProfile'
import { useT } from '@/composables/useT'
import { moderateServerProfile } from '@/services/serverProfileService'
import { userDataService } from '@/services/userDataService'

interface MemberInfo {
  id: string
  username: string
  display_name?: string | null
  avatar_url?: string | null
}

const props = defineProps<{
  show: boolean
  serverId: string
  user: MemberInfo
}>()

const emit = defineEmits<{
  close: []
  done: [nickname: string | null]
}>()

const { t } = useT()
const toast = useToast()
const inputId = `moderate-nickname-${useId()}`

const draft = ref('')
const busy = ref(false)

const name = computed(() => props.user.display_name || props.user.username)

watch(() => props.show, (open) => {
  if (!open) return
  draft.value = getMemberServerProfile(props.user.id, props.serverId).value?.nickname?.trim() || ''
}, { immediate: true })

function close() {
  if (!busy.value) emit('close')
}

async function submit() {
  if (busy.value) return
  const nickname = draft.value.trim() || null
  busy.value = true
  try {
    await moderateServerProfile(props.serverId, props.user.id, { nickname })
    userDataService.setMemberServerProfile(props.serverId, props.user.id, { nickname })
    toast.success(nickname
      ? t('moderation.serverProfile.nicknameDone', { name: name.value, nickname })
      : t('moderation.serverProfile.nicknameCleared', { name: name.value }))
    emit('done', nickname)
  } catch (error) {
    toast.error(moderationErrorMessage(error, t, name.value))
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.nickname-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.user-preview {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.user-info {
  display: flex;
  flex-direction: column;
}

.user-display-name {
  font-weight: 600;
  color: var(--text-primary);
  font-size: 0.95rem;
}

.user-username,
.hint {
  color: var(--text-muted);
  font-size: 0.8rem;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group label {
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--text-secondary);
}

.form-input {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 10px;
  color: var(--text-primary);
  font-size: 0.9rem;
  font-family: inherit;
  width: 100%;
  box-sizing: border-box;
}
.form-input:focus {
  outline: none;
  border-color: var(--accent-color, var(--harmony-primary));
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
