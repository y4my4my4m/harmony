<template>
  <BaseModal
    :show="show"
    :title="t('discordMigration.adminConfirm.title')"
    :subtitle="t('discordMigration.adminConfirm.lead')"
    role="alertdialog"
    @close="emit('cancel')"
  >
    <div data-testid="admin-confirm">
      <div v-if="loadFailed">
        <p class="dm-error" role="alert" data-testid="admin-confirm-error">{{ t('discordMigration.adminConfirm.holdersFailed') }}</p>
        <button type="button" class="btn btn-secondary btn-sm" data-testid="admin-confirm-retry" @click="emit('retry')">
          {{ t('discordMigration.retry') }}
        </button>
      </div>
      <template v-else>
        <p class="dm-text" data-testid="admin-confirm-holders-text">
          {{ t(pending ? 'discordMigration.adminConfirm.holdersPending' : 'discordMigration.adminConfirm.holders') }}
        </p>
        <ul v-if="holders.length" class="dm-holders" data-testid="admin-confirm-holders">
          <li v-for="holder in holders" :key="holder.user_id">
            {{ holder.display_name || holder.username || holder.user_id }}
            <span v-if="holder.display_name && holder.username" class="dm-muted">{{ '@' + holder.username }}</span>
          </li>
        </ul>
        <p v-else class="dm-muted" data-testid="admin-confirm-none">{{ t('discordMigration.adminConfirm.noHolders') }}</p>
      </template>
      <p class="dm-text" data-testid="admin-confirm-future">
        {{ t(pending ? 'discordMigration.adminConfirm.futurePending' : 'discordMigration.adminConfirm.future') }}
      </p>
    </div>
    <template #footer>
      <button type="button" class="btn btn-secondary" data-testid="admin-confirm-cancel" @click="emit('cancel')">
        {{ t('common.cancel') }}
      </button>
      <button
        type="button"
        class="btn btn-danger"
        data-testid="admin-confirm-ok"
        :disabled="busy || loadFailed"
        @click="emit('confirm')"
      >
        {{ t('discordMigration.adminConfirm.confirm') }}
      </button>
    </template>
  </BaseModal>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import BaseModal from '@/components/common/BaseModal.vue'
import type { AdminHolder } from './migrationApi'

defineProps<{
  show: boolean
  holders: AdminHolder[]
  busy?: boolean
  /** The holders could not be loaded: Confirm stays disabled until a retry works. */
  loadFailed?: boolean
  /** Saving a role map whose Harmony roles do not carry Administrator yet: only the Discord side does. */
  pending?: boolean
}>()

const emit = defineEmits<{ confirm: []; cancel: []; retry: [] }>()
const { t } = useI18n()
</script>

<style scoped>
.dm-text {
  margin: 0 0 12px;
  font-size: 14px;
  line-height: 1.55;
  color: var(--text-primary);
}

.dm-error {
  margin: 0 0 12px;
  font-size: 14px;
  color: var(--error);
}

.dm-muted {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-secondary);
}

.dm-holders {
  margin: 0 0 12px;
  padding-left: 20px;
  max-height: 200px;
  overflow-y: auto;
  font-size: 14px;
  color: var(--text-primary);
}
</style>
