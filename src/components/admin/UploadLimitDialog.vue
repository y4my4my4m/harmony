<!-- One account's upload limit: its tier, an override or the tier, the effective limit.
     Instance admins edit it; moderators read it. -->
<template>
  <BaseModal :show="show" :title="t('uploadLimits.user.title', { name })" icon="upload" compact @close="emit('close')">
    <div class="upload-limit-dialog" data-testid="upload-limit-dialog">
      <p v-if="loading" class="upload-limit-dialog__muted">…</p>
      <template v-else-if="limit">
        <p data-testid="upload-limit-tier">
          {{ t('uploadLimits.user.tier', { tier: t(`uploadLimits.tierName.${limit.tier}`), limit: formatBytes(limit.tier_bytes) }) }}
        </p>
        <p data-testid="upload-limit-effective">
          <strong>{{ t('uploadLimits.user.effective', { limit: formatBytes(limit.effective_bytes) }) }}</strong>
        </p>

        <fieldset class="upload-limit-dialog__choice" :disabled="!limit.can_edit || busy">
          <legend class="upload-limit-dialog__legend">{{ t('uploadLimits.user.choice') }}</legend>
          <label class="upload-limit-dialog__option">
            <input v-model="mode" type="radio" value="tier" data-testid="upload-limit-use-tier" />
            {{ t('uploadLimits.user.useTier') }}
          </label>
          <label class="upload-limit-dialog__option">
            <input v-model="mode" type="radio" value="custom" data-testid="upload-limit-custom" />
            {{ t('uploadLimits.user.custom') }}
          </label>
          <span v-if="mode === 'custom'" class="upload-limit-dialog__unit">
            <input
              :id="`${uid}-mb`"
              v-model.number="customMb"
              type="number"
              min="0"
              :max="limit.ceiling_bytes / MB"
              step="any"
              class="upload-limit-dialog__input"
              :aria-label="t('uploadLimits.user.customLabel', { name })"
              :aria-invalid="customInvalid || undefined"
              data-testid="upload-limit-custom-mb"
            />
            MB
          </span>
        </fieldset>
        <p class="upload-limit-dialog__muted">{{ t('uploadLimits.user.ceiling', { limit: formatBytes(limit.ceiling_bytes) }) }}</p>
        <p v-if="!limit.can_edit" class="upload-limit-dialog__muted">{{ t('uploadLimits.readOnly') }}</p>
      </template>
      <p v-if="error" class="upload-limit-dialog__error" role="alert">{{ error }}</p>
    </div>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="emit('close')">{{ t('common.close') }}</button>
      <button
        v-if="limit?.can_edit"
        type="button"
        class="btn btn-primary"
        :disabled="busy || customInvalid"
        :aria-busy="busy || undefined"
        data-testid="upload-limit-save"
        @click="save"
      >{{ t('uploadLimits.save') }}</button>
    </template>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import { supabase } from '@/supabase'
import { useT } from '@/composables/useT'
import { formatBytes } from '@/utils/uploadValidation'
import { resetUploadLimit } from '@/services/uploads/uploadLimit'

interface AccountLimit {
  override_bytes: number | null
  tier: 'user' | 'moderator' | 'admin'
  tier_bytes: number
  effective_bytes: number
  ceiling_bytes: number
  can_edit: boolean
}

const props = defineProps<{
  show: boolean
  profileId: string | null
  name: string
}>()

const emit = defineEmits<{
  close: []
  saved: [limit: AccountLimit]
}>()

const MB = 1048576
const { t } = useT()
const uid = useId()
const limit = ref<AccountLimit | null>(null)
const mode = ref<'tier' | 'custom'>('tier')
const customMb = ref<number | ''>('')
const loading = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)

const customInvalid = computed(() => {
  if (mode.value !== 'custom' || !limit.value) return false
  const mb = Number(customMb.value)
  return customMb.value === '' || !Number.isFinite(mb) || mb < 0 || Math.round(mb * MB) > limit.value.ceiling_bytes
})

function apply(value: AccountLimit): void {
  limit.value = value
  mode.value = value.override_bytes === null ? 'tier' : 'custom'
  customMb.value = value.override_bytes === null ? '' : Number((value.override_bytes / MB).toFixed(2))
}

async function load(): Promise<void> {
  if (!props.profileId) return
  loading.value = true
  error.value = null
  limit.value = null
  const { data, error: e } = await supabase.rpc('admin_get_upload_limit', { p_profile: props.profileId })
  loading.value = false
  if (e || !data) {
    error.value = e?.message || t('uploadLimits.loadFailed')
    return
  }
  apply(data as AccountLimit)
}

async function save(): Promise<void> {
  if (!props.profileId || customInvalid.value) return
  busy.value = true
  error.value = null
  const { data, error: e } = await supabase.rpc('admin_set_upload_limit', {
    p_profile: props.profileId,
    p_limit_bytes: mode.value === 'tier' ? null : Math.round(Number(customMb.value) * MB),
  })
  busy.value = false
  if (e || !data) {
    error.value = e?.message || t('uploadLimits.saveFailed')
    return
  }
  apply(data as AccountLimit)
  resetUploadLimit()
  emit('saved', data as AccountLimit)
}

watch(() => [props.show, props.profileId] as const, ([open]) => {
  if (open) void load()
}, { immediate: true })
</script>

<style scoped>
.upload-limit-dialog {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.upload-limit-dialog p {
  margin: 0;
}

.upload-limit-dialog__choice {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.upload-limit-dialog__legend {
  padding: 0 4px;
  font-size: 13px;
  color: var(--text-secondary);
}

.upload-limit-dialog__option {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.upload-limit-dialog__unit {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 24px;
  color: var(--text-secondary);
}

.upload-limit-dialog__input {
  width: 140px;
  padding: 8px 12px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-primary);
}

.upload-limit-dialog__muted {
  font-size: 13px;
  color: var(--text-muted);
}

.upload-limit-dialog__error {
  font-size: 13px;
  color: var(--text-danger);
}
</style>
