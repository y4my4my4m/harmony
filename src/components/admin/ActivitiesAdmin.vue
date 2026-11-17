<!--
  Admin → Activities: the play-together apps this instance offers, each switched on or off
  (set_activity_app_enabled; turning one off ends its running sessions).
-->
<template>
  <div class="aa" data-testid="activities-admin">
    <section class="aa-card">
      <h3 class="aa-title">{{ t('playTogether.admin.title') }}</h3>
      <p class="aa-hint">{{ t('playTogether.admin.intro') }}</p>

      <p v-if="!store.appsLoaded" class="aa-hint">{{ t('playTogether.loadingApps') }}</p>
      <p v-else-if="!store.apps.length" class="aa-hint">{{ t('playTogether.admin.none') }}</p>

      <ul v-else class="aa-list" role="list">
        <li v-for="app in store.apps" :key="app.id" class="aa-row" :data-testid="`activities-admin-${app.id}`">
          <img :src="app.iconUrl" alt="" class="aa-icon" />
          <div class="aa-body">
            <div class="aa-name">
              {{ store.appLabel(app).name }}
              <span class="aa-version">v{{ app.version }}</span>
            </div>
            <div class="aa-desc">{{ store.appLabel(app).description }}</div>
            <div class="aa-meta">
              {{ t('playTogether.players', { min: app.minPlayers, max: app.maxPlayers }) }}
              ·
              {{ app.contexts.map((c) => t(`playTogether.admin.context.${c}`)).join(', ') }}
            </div>
          </div>
          <ToggleSwitch
            :model-value="app.enabled"
            :disabled="!isAdmin || busy === app.id"
            :label="t('playTogether.admin.toggle', { name: store.appLabel(app).name })"
            :data-testid="`activities-admin-toggle-${app.id}`"
            @update:model-value="(on: boolean) => toggle(app.id, on)"
          />
        </li>
      </ul>
    </section>

    <section class="aa-card">
      <h3 class="aa-title">{{ t('playTogether.admin.safetyTitle') }}</h3>
      <ul class="aa-points">
        <li>{{ t('playTogether.admin.safety.sandbox') }}</li>
        <li>{{ t('playTogether.admin.safety.network') }}</li>
        <li>{{ t('playTogether.admin.safety.relay') }}</li>
        <li>{{ t('playTogether.admin.safety.members') }}</li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useToast } from 'vue-toastification'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { useT } from '@/composables/useT'
import { usePlayTogetherStore } from '@/stores/playTogether'
import { setAppEnabled } from '@/services/playTogether/catalog'
import { useProfileStore } from '@/stores/useProfile'

const { t } = useT()
const toast = useToast()
const store = usePlayTogetherStore()
const profile = useProfileStore()
const busy = ref<string | null>(null)

const isAdmin = computed(() => profile.profile?.is_admin === true)

async function toggle(appId: string, on: boolean): Promise<void> {
  busy.value = appId
  try {
    await setAppEnabled(appId, on)
    await store.loadApps(true)
    toast.success(on ? t('playTogether.admin.enabled') : t('playTogether.admin.disabled'))
  } catch {
    toast.error(t('playTogether.errors.UNKNOWN'))
  } finally {
    busy.value = null
  }
}

onMounted(() => { void store.loadApps(true) })
</script>

<style scoped>
.aa {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.aa-card {
  padding: 16px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--background-secondary);
}

.aa-title {
  margin: 0 0 6px;
  font-size: 16px;
  color: var(--text-primary);
}

.aa-hint {
  margin: 0 0 12px;
  color: var(--text-secondary);
  font-size: var(--font-size-sm, 14px);
}

.aa-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.aa-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
}

.aa-icon {
  width: 44px;
  height: 44px;
  border-radius: 11px;
  flex-shrink: 0;
}

.aa-body {
  flex: 1;
  min-width: 0;
}

.aa-name {
  font-weight: var(--font-weight-semibold, 600);
  color: var(--text-primary);
}

.aa-version {
  margin-left: 6px;
  font-weight: normal;
  font-size: var(--font-size-xs, 12px);
  color: var(--text-muted);
}

.aa-desc,
.aa-meta {
  font-size: var(--font-size-sm, 13px);
  color: var(--text-secondary);
}

.aa-meta {
  margin-top: 2px;
  color: var(--text-muted);
}

.aa-points {
  margin: 0;
  padding-left: 18px;
  color: var(--text-secondary);
  font-size: var(--font-size-sm, 14px);
  line-height: 1.5;
}
</style>
