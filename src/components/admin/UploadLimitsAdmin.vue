<!-- Upload limits by instance role, under the ceiling the server operator sets; editable by
     instance admins, read-only for moderators. -->
<template>
  <section class="upload-limits" data-testid="upload-limits-admin" :aria-labelledby="`${uid}-title`">
    <h3 :id="`${uid}-title`">{{ t('uploadLimits.title') }}</h3>
    <p class="setting-hint">{{ t('uploadLimits.hint') }}</p>
    <form class="upload-limits__form" @submit.prevent="save">
      <div v-for="tier in TIERS" :key="tier" class="upload-limits__row">
        <label :for="`${uid}-${tier}`">{{ t(`uploadLimits.tier.${tier}`) }}</label>
        <span class="upload-limits__unit">
          <input
            :id="`${uid}-${tier}`"
            v-model.number="form[tier]"
            type="number"
            min="0"
            :max="ceilingMb ?? undefined"
            step="any"
            required
            class="cyber-input"
            :disabled="!canEdit || loading"
            :aria-invalid="overCeiling(tier) || undefined"
            :aria-describedby="overCeiling(tier) ? `${uid}-${tier}-over` : undefined"
            :data-testid="`upload-limit-${tier}`"
          />
          MB
        </span>
        <span v-if="overCeiling(tier)" :id="`${uid}-${tier}-over`" class="upload-limits__over">
          {{ t('uploadLimits.aboveCeiling', { limit: formatBytes(ceiling) }) }}
        </span>
      </div>
      <div class="upload-limits__row">
        <span class="upload-limits__label">{{ t('uploadLimits.ceiling') }}</span>
        <strong data-testid="upload-limit-ceiling">{{ loading ? '…' : formatBytes(ceiling) }}</strong>
        <span class="setting-hint">{{ t('uploadLimits.ceilingHint') }}</span>
      </div>
      <p class="setting-hint">{{ t('uploadLimits.driveNote') }}</p>
      <p v-if="!canEdit && !loading" class="setting-hint">{{ t('uploadLimits.readOnly') }}</p>
      <p v-if="error" class="upload-limits__error" role="alert">{{ error }}</p>
      <div v-if="canEdit" class="upload-limits__actions">
        <span v-if="saved" role="status">{{ t('uploadLimits.saved') }}</span>
        <button type="submit" class="save-btn" :disabled="saving || invalid" data-testid="upload-limits-save">
          <Icon name="save" :size="16" />
          {{ t('uploadLimits.save') }}
        </button>
      </div>
    </form>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, useId } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { supabase } from '@/supabase'
import { useT } from '@/composables/useT'
import { formatBytes } from '@/utils/uploadValidation'
import { resetUploadLimit } from '@/services/uploads/uploadLimit'

const TIERS = ['user', 'moderator', 'admin'] as const
type Tier = typeof TIERS[number]

interface Limits {
  user_mb: number
  moderator_mb: number
  admin_mb: number
  ceiling_bytes: number
  can_edit: boolean
}

const { t } = useT()
const uid = useId()
const form = reactive<Record<Tier, number>>({ user: 0, moderator: 0, admin: 0 })
const ceiling = ref(0)
const canEdit = ref(false)
const loading = ref(true)
const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)

const MB = 1048576
const ceilingMb = computed(() => (ceiling.value > 0 ? ceiling.value / MB : null))
const overCeiling = (tier: Tier) => ceiling.value > 0 && Number(form[tier]) * MB > ceiling.value
const invalid = computed(() => TIERS.some((tier) => !Number.isFinite(Number(form[tier])) || Number(form[tier]) < 0 || overCeiling(tier)))

function apply(limits: Limits): void {
  form.user = Number(limits.user_mb)
  form.moderator = Number(limits.moderator_mb)
  form.admin = Number(limits.admin_mb)
  ceiling.value = Number(limits.ceiling_bytes)
  canEdit.value = limits.can_edit === true
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  const { data, error: e } = await supabase.rpc('admin_upload_limits')
  loading.value = false
  if (e || !data) {
    error.value = e?.message || t('uploadLimits.loadFailed')
    return
  }
  apply(data as Limits)
}

async function save(): Promise<void> {
  if (invalid.value) return
  saving.value = true
  saved.value = false
  error.value = null
  const { data, error: e } = await supabase.rpc('admin_set_upload_limits', {
    p_user_mb: Number(form.user),
    p_moderator_mb: Number(form.moderator),
    p_admin_mb: Number(form.admin),
  })
  saving.value = false
  if (e || !data) {
    error.value = e?.message || t('uploadLimits.saveFailed')
    return
  }
  apply(data as Limits)
  // The admin's own limit may have changed.
  resetUploadLimit()
  saved.value = true
}

onMounted(load)
</script>

<style scoped src="./adminShared.css"></style>
<style scoped>
.upload-limits__form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 520px;
}

.upload-limits__row label,
.upload-limits__label {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.upload-limits__unit {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
}

.upload-limits__unit .cyber-input {
  max-width: 160px;
}

.upload-limits__over,
.upload-limits__error {
  display: block;
  margin-top: 6px;
  font-size: 13px;
  color: var(--text-danger);
}

.upload-limits__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}

.save-btn {
  padding: 8px 16px;
  background: var(--harmony-primary-fill);
  border: none;
  border-radius: var(--radius-base);
  color: var(--text-on-primary);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
}

.save-btn:hover {
  background: var(--harmony-primary-fill-hover);
}

.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
