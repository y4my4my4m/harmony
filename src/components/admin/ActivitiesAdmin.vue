<!--
  Admin → Activities: the play-together apps this instance offers, each switched on or off
  (set_activity_app_enabled; turning one off ends its running sessions), and packages installed from
  a zip upload or an HTTPS URL. Every install is previewed first; what is installed is exactly the
  previewed zip (its SHA-256), and a new package starts switched off.
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
              <span v-if="app.source === 'package'" class="aa-badge">{{ t('playTogether.admin.package') }}</span>
            </div>
            <div class="aa-desc">{{ store.appLabel(app).description }}</div>
            <div class="aa-meta">
              {{ t('playTogether.players', { min: app.minPlayers, max: app.maxPlayers }) }}
              ·
              {{ app.contexts.map((c) => t(`playTogether.admin.context.${c}`)).join(', ') }}
            </div>
            <div v-if="app.source === 'package'" class="aa-actions">
              <button
                v-if="app.packageUrl"
                type="button"
                class="aa-link"
                :disabled="!isAdmin || !!busy"
                :data-testid="`activities-admin-update-${app.id}`"
                @click="preview({ url: app.packageUrl })"
              >{{ t('playTogether.admin.checkUpdate') }}</button>
              <button
                type="button"
                class="aa-link aa-link--danger"
                :disabled="!isAdmin || !!busy"
                :data-testid="`activities-admin-remove-${app.id}`"
                @click="remove(app.id)"
              >{{ confirming === app.id ? t('playTogether.admin.removeConfirm') : t('playTogether.admin.remove') }}</button>
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

    <section v-if="isAdmin" class="aa-card" data-testid="activities-admin-install">
      <h3 class="aa-title">{{ t('playTogether.admin.installTitle') }}</h3>
      <p class="aa-hint">{{ t('playTogether.admin.installIntro') }}</p>
      <div class="aa-install">
        <label class="aa-file">
          <input
            type="file"
            accept=".zip,application/zip"
            data-testid="activities-admin-file"
            :disabled="!!busy"
            @change="onFile"
          />
          <span>{{ t('playTogether.admin.chooseZip') }}</span>
        </label>
        <span class="aa-or">{{ t('playTogether.admin.or') }}</span>
        <form class="aa-url" @submit.prevent="url.trim() && preview({ url: url.trim() })">
          <input
            v-model="url"
            type="url"
            inputmode="url"
            class="aa-input"
            placeholder="https://…/activity.zip"
            :aria-label="t('playTogether.admin.urlLabel')"
            data-testid="activities-admin-url"
            :disabled="!!busy"
          />
          <button type="submit" class="aa-button" :disabled="!url.trim() || !!busy">{{ t('playTogether.admin.preview') }}</button>
        </form>
      </div>

      <div v-if="pending" class="aa-preview" data-testid="activities-admin-preview">
        <img :src="pending.preview.icon" alt="" class="aa-icon aa-icon--large" />
        <div class="aa-body">
          <div class="aa-name">
            {{ pending.preview.name }}
            <span class="aa-version">v{{ pending.preview.version }}</span>
            <span v-if="pending.preview.existing" class="aa-badge">
              {{ t('playTogether.admin.replaces', { version: pending.preview.existing.version ?? '?' }) }}
            </span>
          </div>
          <div class="aa-desc">{{ pending.preview.description }}</div>
          <dl class="aa-facts">
            <dt>{{ t('playTogether.admin.id') }}</dt><dd><code>{{ pending.preview.id }}</code></dd>
            <dt>{{ t('playTogether.admin.playersLabel') }}</dt><dd>{{ t('playTogether.players', { min: pending.preview.minPlayers, max: pending.preview.maxPlayers }) }}</dd>
            <dt>{{ t('playTogether.admin.runsIn') }}</dt><dd>{{ pending.preview.contexts.map((c) => t(`playTogether.admin.context.${c}`)).join(', ') }}</dd>
            <dt>{{ t('playTogether.admin.size') }}</dt><dd>{{ formatBytes(pending.preview.size) }}</dd>
            <dt>SHA-256</dt><dd><code class="aa-sha">{{ pending.preview.sha256 }}</code></dd>
            <template v-if="pending.preview.url"><dt>{{ t('playTogether.admin.from') }}</dt><dd class="aa-break">{{ pending.preview.url }}</dd></template>
          </dl>
          <p class="aa-warning" role="note">{{ t('playTogether.admin.trustWarning') }}</p>
          <div class="aa-actions">
            <button type="button" class="aa-button" data-testid="activities-admin-install-confirm" :disabled="!!busy" @click="install">
              {{ pending.preview.existing ? t('playTogether.admin.update') : t('playTogether.admin.install') }}
            </button>
            <button type="button" class="aa-link" :disabled="!!busy" @click="pending = null">{{ t('playTogether.admin.cancel') }}</button>
          </div>
        </div>
      </div>
      <p v-if="installError" class="aa-error" role="alert" data-testid="activities-admin-error">{{ installError }}</p>
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
import {
  PackageRequestError,
  installPackage,
  previewPackage,
  removePackage,
  setAppEnabled,
  type PackagePreview,
} from '@/services/playTogether/catalog'
import { useProfileStore } from '@/stores/useProfile'

const { t } = useT()
const toast = useToast()
const store = usePlayTogetherStore()
const profile = useProfileStore()
const busy = ref<string | null>(null)
const url = ref('')
const pending = ref<{ preview: PackagePreview; source: { file: Blob } | { url: string } } | null>(null)
const installError = ref('')
const confirming = ref<string | null>(null)

const PACKAGE_ERRORS = ['NOT_A_ZIP', 'TOO_LARGE', 'UNEXPECTED_FILE', 'MISSING_FILE', 'BAD_MANIFEST', 'BAD_ENTRY', 'BAD_ICON',
  'BUILTIN_ID', 'TOO_MANY_PACKAGES', 'PACKAGE_CHANGED', 'FETCH_FAILED', 'BAD_URL']

function errorText(error: unknown): string {
  if (error instanceof PackageRequestError && PACKAGE_ERRORS.includes(error.code)) {
    return t(`playTogether.admin.errors.${error.code}`) + (error.message && error.message !== error.code ? ` (${error.message})` : '')
  }
  return t('playTogether.errors.UNKNOWN')
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

async function preview(source: { file: Blob } | { url: string }): Promise<void> {
  busy.value = 'preview'
  installError.value = ''
  pending.value = null
  try {
    pending.value = { preview: await previewPackage(source), source }
  } catch (error) {
    installError.value = errorText(error)
  } finally {
    busy.value = null
  }
}

function onFile(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) void preview({ file })
}

async function install(): Promise<void> {
  const current = pending.value
  if (!current) return
  busy.value = 'install'
  installError.value = ''
  try {
    const result = await installPackage(current.source, current.preview.sha256)
    pending.value = null
    url.value = ''
    await store.loadApps(true)
    toast.success(result.updated ? t('playTogether.admin.updated') : t('playTogether.admin.installed'))
  } catch (error) {
    installError.value = errorText(error)
  } finally {
    busy.value = null
  }
}

async function remove(appId: string): Promise<void> {
  if (confirming.value !== appId) {
    confirming.value = appId
    return
  }
  confirming.value = null
  busy.value = appId
  try {
    await removePackage(appId)
    await store.loadApps(true)
    toast.success(t('playTogether.admin.removed'))
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    busy.value = null
  }
}

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

.aa-badge {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
  font-size: var(--font-size-xs, 12px);
  font-weight: normal;
}

.aa-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}

.aa-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--harmony-primary, #0EA5E9);
  font-size: var(--font-size-sm, 13px);
  cursor: pointer;
}

.aa-link--danger {
  color: var(--text-danger, #f87171);
}

.aa-link:disabled,
.aa-button:disabled {
  opacity: 0.6;
  cursor: default;
}

.aa-install {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.aa-file {
  position: relative;
  display: inline-flex;
  align-items: center;
  padding: 7px 14px;
  border: 1px dashed var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  cursor: pointer;
}

.aa-file input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.aa-file:focus-within {
  outline: 2px solid var(--harmony-primary, #0EA5E9);
}

.aa-or {
  color: var(--text-muted);
  font-size: var(--font-size-sm, 13px);
}

.aa-url {
  display: flex;
  flex: 1;
  min-width: 240px;
  gap: 8px;
}

.aa-input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--background-primary);
  color: var(--text-primary);
}

.aa-button {
  padding: 7px 14px;
  border: 0;
  border-radius: 8px;
  background: var(--harmony-primary, #0EA5E9);
  color: #fff;
  font-weight: var(--font-weight-semibold, 600);
  cursor: pointer;
}

.aa-preview {
  display: flex;
  gap: 14px;
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
}

.aa-icon--large {
  width: 64px;
  height: 64px;
  border-radius: 14px;
}

.aa-facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 10px 0;
  font-size: var(--font-size-sm, 13px);
  color: var(--text-secondary);
}

.aa-facts dd {
  margin: 0;
  min-width: 0;
}

.aa-sha,
.aa-break {
  word-break: break-all;
}

.aa-warning {
  margin: 0 0 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--text-danger, #f87171) 12%, transparent);
  color: var(--text-primary);
  font-size: var(--font-size-sm, 13px);
}

.aa-error {
  margin: 10px 0 0;
  color: var(--text-danger, #f87171);
  font-size: var(--font-size-sm, 13px);
}

.aa-points {
  margin: 0;
  padding-left: 18px;
  color: var(--text-secondary);
  font-size: var(--font-size-sm, 14px);
  line-height: 1.5;
}
</style>
