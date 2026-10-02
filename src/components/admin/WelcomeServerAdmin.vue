<template>
  <div class="admin-module welcome-server-module" data-testid="welcome-server-admin">
    <div class="module-header">
      <Icon name="door-open" :size="20" />
      <h2>{{ $t('welcomeServer.admin.title') }}</h2>
    </div>
    <p class="ws-admin-hint">{{ $t('welcomeServer.admin.hint') }}</p>

    <div v-if="loading" class="ws-admin-loading">
      <LoadingSpinner :size="20" />
    </div>

    <div v-else class="ws-admin-body">
      <label class="ws-admin-label" for="welcome-server-select">{{ $t('welcomeServer.admin.label') }}</label>
      <div class="ws-admin-row">
        <select
          id="welcome-server-select"
          v-model="selectedId"
          class="cyber-select ws-admin-select"
          :disabled="saving"
          data-testid="welcome-server-select"
        >
          <option value="">{{ $t('welcomeServer.admin.none') }}</option>
          <option v-if="currentIsUnavailable" :value="currentId">{{ $t('welcomeServer.admin.unavailableOption') }}</option>
          <option v-for="server in servers" :key="server.id" :value="server.id">
            {{ $t('welcomeServer.admin.option', { name: server.name, count: server.member_count ?? 0 }, server.member_count ?? 0) }}
          </option>
        </select>
        <button
          type="button"
          class="action-btn ws-admin-save"
          :disabled="saving || !dirty"
          data-testid="welcome-server-save"
          @click="save"
        >
          <Icon v-if="saving" name="loader" :size="16" class="spin" />
          {{ $t('welcomeServer.admin.save') }}
        </button>
      </div>

      <p v-if="currentIsUnavailable && !dirty" class="ws-admin-warning" role="status">
        <Icon name="alert-triangle" :size="14" />
        {{ $t('welcomeServer.admin.unavailable') }}
      </p>
      <p class="ws-admin-note">
        {{ selectedId ? $t('welcomeServer.admin.selectedNote') : $t('welcomeServer.admin.noneNote') }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { adminService } from '@/services/AdminService'
import { setWelcomeServer } from '@/services/ServerWelcomeService'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { debug } from '@/utils/debug'

type PublicServer = Awaited<ReturnType<typeof adminService.getPublicServersForAdmin>>[number]

const { t } = useI18n()
const toast = useToast()
const instanceSettings = useInstanceSettingsStore()

const servers = ref<PublicServer[]>([])
const currentId = ref('')
const selectedId = ref('')
const loading = ref(true)
const saving = ref(false)

const dirty = computed(() => selectedId.value !== currentId.value)

/** Set to a server that is no longer public, or no longer exists. */
const currentIsUnavailable = computed(
  () => !!currentId.value && !servers.value.some((s) => s.id === currentId.value),
)

async function load() {
  loading.value = true
  try {
    const [list] = await Promise.all([adminService.getPublicServersForAdmin(), instanceSettings.refresh()])
    servers.value = list
    currentId.value = instanceSettings.settings.welcomeServerId ?? ''
    selectedId.value = currentId.value
  } catch (error) {
    debug.error('Failed to load the welcome server setting:', error)
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  try {
    await setWelcomeServer(selectedId.value || null)
    currentId.value = selectedId.value
    instanceSettings.settings.welcomeServerId = selectedId.value || null
    toast.success(t('welcomeServer.admin.saved'))
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t('welcomeServer.admin.saveFailed'))
  } finally {
    saving.value = false
  }
}

onMounted(() => { void load() })
</script>

<style scoped src="./adminShared.css"></style>

<style scoped>
.ws-admin-hint {
  margin: 16px 24px 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.ws-admin-loading {
  display: flex;
  justify-content: center;
  padding: 24px;
}

.ws-admin-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 24px 24px;
}

.ws-admin-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.ws-admin-row {
  display: flex;
  gap: 8px;
}

.ws-admin-select {
  flex: 1;
  min-width: 0;
}

.ws-admin-save {
  flex-shrink: 0;
}

.ws-admin-warning {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  color: var(--warning, #faa61a);
}

.ws-admin-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 480px) {
  .ws-admin-row {
    flex-direction: column;
  }

  .ws-admin-save {
    justify-content: center;
  }
}
</style>
