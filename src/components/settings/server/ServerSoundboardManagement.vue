<template>
  <div class="server-soundboard">
    <div class="settings-section">
      <h2 class="section-title">{{ t('soundboard.settings.title') }}</h2>
      <p class="section-description">{{ t('soundboard.settings.description') }}</p>
    </div>

    <div v-if="canManage" class="settings-card" data-testid="soundboard-upload">
      <div class="card-header">
        <h3>{{ t('soundboard.settings.addSound') }}</h3>
        <span class="counter">{{ sounds.length }}/{{ SOUNDBOARD_LIMITS.perServer }}</span>
      </div>
      <p class="card-hint">{{ t('soundboard.settings.fileHint', { kb: SOUNDBOARD_LIMITS.bytes / 1024, seconds: SOUNDBOARD_LIMITS.durationMs / 1000 }) }}</p>

      <p v-if="full" class="card-note">{{ t('soundboard.errors.full', { max: SOUNDBOARD_LIMITS.perServer }) }}</p>
      <template v-else>
        <div class="file-row">
          <label class="btn btn-secondary btn-sm file-pick">
            <Icon name="upload" :size="14" />
            {{ draft.file ? t('soundboard.settings.replaceFile') : t('soundboard.settings.chooseFile') }}
            <input
              ref="fileInputRef"
              type="file"
              class="visually-hidden"
              accept=".mp3,.ogg,.oga,.opus,.wav,audio/mpeg,audio/ogg,audio/wav"
              data-testid="soundboard-file"
              @change="onFileChange"
            />
          </label>
          <span v-if="checking" class="file-meta">{{ t('soundboard.settings.checking') }}</span>
          <span v-else-if="draft.file && draft.checked" class="file-meta">
            {{ draft.file.name }} · {{ formatDuration(draft.checked.durationMs) }}
          </span>
        </div>
        <p v-if="fileError" class="error-state" role="alert" data-testid="soundboard-file-error">{{ fileError }}</p>

        <div v-if="draft.checked" class="sound-form">
          <div class="form-group name-field">
            <label class="form-label" :for="`${uid}-name`">{{ t('soundboard.settings.name') }}</label>
            <input
              :id="`${uid}-name`"
              v-model="draft.name"
              type="text"
              class="form-input"
              :maxlength="SOUNDBOARD_LIMITS.name"
              data-testid="soundboard-name"
            />
          </div>
          <div class="form-group emoji-field">
            <label class="form-label" :for="`${uid}-emoji`">{{ t('soundboard.settings.emoji') }}</label>
            <input
              :id="`${uid}-emoji`"
              v-model="draft.emoji"
              type="text"
              class="form-input"
              :maxlength="SOUNDBOARD_LIMITS.emoji"
              placeholder="🔊"
            />
          </div>
          <div class="form-group volume-field">
            <label class="form-label" :for="`${uid}-volume`">
              {{ t('soundboard.settings.volume') }}
              <span class="counter">{{ draft.volume }}%</span>
            </label>
            <input
              :id="`${uid}-volume`"
              v-model.number="draft.volume"
              type="range"
              min="0"
              max="100"
              class="form-range"
            />
          </div>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary btn-sm" @click="previewDraft">
              <Icon name="play" :size="14" />
              {{ t('soundboard.settings.preview') }}
            </button>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="uploading || !draftNameValid"
              data-testid="soundboard-upload-submit"
              @click="upload"
            >
              {{ uploading ? t('soundboard.settings.uploading') : t('soundboard.settings.upload') }}
            </button>
          </div>
        </div>
      </template>
    </div>

    <div class="settings-card">
      <div class="card-header">
        <h3>{{ t('soundboard.settings.serverSounds') }}</h3>
        <span v-if="!canManage" class="counter">{{ sounds.length }}/{{ SOUNDBOARD_LIMITS.perServer }}</span>
      </div>

      <div v-if="loading" class="loading-state"><LoadingSpinner :size="32" /></div>
      <p v-else-if="loadError" class="error-state" role="alert">{{ t('soundboard.errors.load') }}</p>
      <p v-else-if="sounds.length === 0" class="empty-state">{{ t('soundboard.settings.empty') }}</p>

      <ul v-else class="sound-list">
        <li v-for="sound in sounds" :key="sound.id" class="sound-row" data-testid="soundboard-row">
          <template v-if="editing?.id === sound.id">
            <input
              v-model="editing.emoji"
              type="text"
              class="form-input emoji-input"
              :maxlength="SOUNDBOARD_LIMITS.emoji"
              :aria-label="t('soundboard.settings.emoji')"
              placeholder="🔊"
            />
            <input
              v-model="editing.name"
              type="text"
              class="form-input name-input"
              :maxlength="SOUNDBOARD_LIMITS.name"
              :aria-label="t('soundboard.settings.name')"
              data-testid="soundboard-edit-name"
            />
            <input
              v-model.number="editing.volume"
              type="range"
              min="0"
              max="100"
              class="form-range volume-input"
              :aria-label="t('soundboard.settings.volume')"
            />
            <span class="sound-meta">{{ editing.volume }}%</span>
            <div class="row-actions">
              <button
                type="button"
                class="icon-btn"
                :disabled="saving || !editNameValid"
                :aria-label="t('soundboard.settings.save')"
                :title="t('soundboard.settings.save')"
                data-testid="soundboard-edit-save"
                @click="saveEdit"
              >
                <Icon name="check" :size="16" />
              </button>
              <button
                type="button"
                class="icon-btn"
                :aria-label="t('soundboard.settings.cancel')"
                :title="t('soundboard.settings.cancel')"
                @click="editing = null"
              >
                <Icon name="x" :size="16" />
              </button>
            </div>
          </template>
          <template v-else>
            <span class="sound-emoji" aria-hidden="true">{{ sound.emoji || '🔊' }}</span>
            <span class="sound-name">{{ sound.name }}</span>
            <span class="sound-meta">{{ formatDuration(sound.durationMs) }} · {{ Math.round(sound.volume * 100) }}%</span>
            <div class="row-actions">
              <button
                type="button"
                class="icon-btn"
                :aria-label="t('soundboard.preview', { name: sound.name })"
                :title="t('soundboard.preview', { name: sound.name })"
                @click="previewSound(sound)"
              >
                <Icon name="play" :size="16" />
              </button>
              <template v-if="canManage">
                <button
                  type="button"
                  class="icon-btn"
                  :aria-label="t('soundboard.settings.edit', { name: sound.name })"
                  :title="t('soundboard.settings.edit', { name: sound.name })"
                  data-testid="soundboard-edit"
                  @click="startEdit(sound)"
                >
                  <Icon name="pencil" :size="16" />
                </button>
                <button
                  type="button"
                  class="icon-btn danger"
                  :aria-label="t('soundboard.settings.delete', { name: sound.name })"
                  :title="t('soundboard.settings.delete', { name: sound.name })"
                  data-testid="soundboard-delete"
                  @click="remove(sound)"
                >
                  <Icon name="trash" :size="16" />
                </button>
              </template>
            </div>
          </template>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useSoundboardStore } from '@/stores/soundboard'
import { soundboardPlayer } from '@/services/soundboard/player'
import {
  SOUNDBOARD_LIMITS,
  checkSoundFile,
  createServerSound,
  deleteServerSound,
  listServerSounds,
  soundboardErrorKey,
  updateServerSound,
  type CheckedSoundFile,
  type SoundboardFileProblem,
  type SoundboardSound,
} from '@/services/soundboard/sounds'

const props = defineProps<{
  serverId: string
  /** MANAGE_EMOJIS on a local server; can_manage_server_sounds decides each write. */
  canManage: boolean
}>()

const { t } = useI18n()
const toast = useToast()
const { confirm } = useConfirmDialog()
const soundboard = useSoundboardStore()
const uid = `ssm-${useId()}`

const sounds = ref<SoundboardSound[]>([])
const loading = ref(true)
const loadError = ref(false)
const checking = ref(false)
const uploading = ref(false)
const saving = ref(false)
const fileError = ref('')
const fileInputRef = ref<HTMLInputElement | null>(null)

const draft = reactive({
  file: null as File | null,
  checked: null as CheckedSoundFile | null,
  url: '',
  name: '',
  emoji: '',
  volume: 100,
})

const editing = ref<{ id: string; name: string; emoji: string; volume: number } | null>(null)

const full = computed(() => sounds.value.length >= SOUNDBOARD_LIMITS.perServer)
const draftNameValid = computed(() => {
  const name = draft.name.trim()
  return name.length > 0 && name.length <= SOUNDBOARD_LIMITS.name
})
const editNameValid = computed(() => {
  const name = editing.value?.name.trim() ?? ''
  return name.length > 0 && name.length <= SOUNDBOARD_LIMITS.name
})

function formatDuration(ms: number): string {
  return t('soundboard.settings.seconds', { seconds: (ms / 1000).toFixed(1) })
}

function publish(list: SoundboardSound[]): void {
  sounds.value = list
  soundboard.setServerSounds(props.serverId, list)
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = false
  try {
    publish(await listServerSounds(props.serverId))
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

function clearDraft(): void {
  if (draft.url) URL.revokeObjectURL(draft.url)
  draft.file = null
  draft.checked = null
  draft.url = ''
  draft.name = ''
  draft.emoji = ''
  draft.volume = 100
  if (fileInputRef.value) fileInputRef.value.value = ''
}

const PROBLEM_KEYS: Record<SoundboardFileProblem, string> = {
  unsupported: 'soundboard.errors.unsupported',
  tooLarge: 'soundboard.errors.tooLarge',
  tooLong: 'soundboard.errors.tooLong',
}

function baseName(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  const stem = (dot > 0 ? fileName.slice(0, dot) : fileName).replace(/[_-]+/g, ' ').trim()
  return Array.from(stem).slice(0, SOUNDBOARD_LIMITS.name).join('').trim()
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  fileError.value = ''
  if (!file) return
  clearDraft()
  checking.value = true
  try {
    const result = await checkSoundFile(file)
    if (!result.ok) {
      fileError.value = t(PROBLEM_KEYS[result.problem], {
        kb: SOUNDBOARD_LIMITS.bytes / 1024,
        seconds: SOUNDBOARD_LIMITS.durationMs / 1000,
      })
      if (fileInputRef.value) fileInputRef.value.value = ''
      return
    }
    draft.file = file
    draft.checked = result.file
    draft.url = URL.createObjectURL(file)
    draft.name = baseName(file.name)
  } finally {
    checking.value = false
  }
}

function previewDraft(): void {
  if (draft.url) soundboardPlayer.play(draft.url, draft.volume / 100)
}

function previewSound(sound: SoundboardSound): void {
  soundboardPlayer.play(sound.url, sound.volume)
}

function errorText(error: unknown): string {
  const key = soundboardErrorKey(error)
  return t(`soundboard.errors.${key}`, {
    kb: SOUNDBOARD_LIMITS.bytes / 1024,
    max: SOUNDBOARD_LIMITS.perServer,
  })
}

async function upload(): Promise<void> {
  if (!draft.file || !draft.checked || !draftNameValid.value || uploading.value) return
  uploading.value = true
  try {
    const sound = await createServerSound(props.serverId, draft.file, draft.checked, {
      name: draft.name,
      emoji: draft.emoji,
      volume: draft.volume / 100,
    })
    publish([...sounds.value, sound])
    clearDraft()
    toast.success(t('soundboard.settings.added', { name: sound.name }))
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    uploading.value = false
  }
}

function startEdit(sound: SoundboardSound): void {
  editing.value = {
    id: sound.id,
    name: sound.name,
    emoji: sound.emoji ?? '',
    volume: Math.round(sound.volume * 100),
  }
}

async function saveEdit(): Promise<void> {
  const edit = editing.value
  if (!edit || !editNameValid.value || saving.value) return
  saving.value = true
  try {
    const updated = await updateServerSound(edit.id, {
      name: edit.name,
      emoji: edit.emoji,
      volume: edit.volume / 100,
    })
    publish(sounds.value.map((s) => (s.id === updated.id ? updated : s)))
    editing.value = null
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    saving.value = false
  }
}

async function remove(sound: SoundboardSound): Promise<void> {
  const ok = await confirm({
    title: t('soundboard.settings.deleteTitle'),
    message: t('soundboard.settings.deleteMessage', { name: sound.name }),
    confirmButtonText: t('soundboard.settings.deleteConfirm'),
    dangerAction: true,
  })
  if (!ok) return
  try {
    await deleteServerSound(sound)
    publish(sounds.value.filter((s) => s.id !== sound.id))
    if (editing.value?.id === sound.id) editing.value = null
  } catch (error) {
    toast.error(errorText(error))
  }
}

watch(() => props.serverId, () => {
  clearDraft()
  editing.value = null
  void load()
}, { immediate: true })

onBeforeUnmount(() => {
  if (draft.url) URL.revokeObjectURL(draft.url)
})
</script>

<style scoped>
.server-soundboard {
  max-width: 860px;
}

.settings-section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.section-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.settings-card {
  background-color: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
  padding: 20px;
  margin-bottom: 16px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.card-header h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.card-hint,
.card-note {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-secondary);
}

.counter {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.file-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.file-pick {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.file-pick:focus-within {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  border: 0;
}

.file-meta {
  min-width: 0;
  font-size: 13px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sound-form {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 2fr);
  gap: 12px;
  align-items: end;
  margin-top: 16px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.form-label {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.form-input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  background: var(--input-bg, var(--background-tertiary));
  border: 1px solid var(--input-border, var(--border-primary));
  border-radius: 6px;
  color: var(--text-primary);
  font: inherit;
  font-size: 14px;
}

.form-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.form-range {
  width: 100%;
  accent-color: var(--harmony-primary);
}

.form-actions {
  grid-column: 1 / -1;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.form-actions .btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.sound-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sound-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--background-quaternary);
  border-radius: 8px;
  background: var(--background-primary);
}

.sound-emoji {
  flex-shrink: 0;
  width: 24px;
  font-size: 18px;
  text-align: center;
}

.sound-name {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sound-meta {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.emoji-input {
  width: 56px;
  flex-shrink: 0;
  text-align: center;
}

.name-input {
  flex: 1;
  min-width: 0;
}

.volume-input {
  width: 120px;
  flex-shrink: 0;
}

.row-actions {
  flex-shrink: 0;
  display: flex;
  gap: 2px;
}

.icon-btn {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
}

.icon-btn:hover:not(:disabled) {
  background: var(--background-tertiary);
  color: var(--text-primary);
}

.icon-btn.danger:hover:not(:disabled) {
  color: var(--error);
}

.icon-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.icon-btn:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 1px;
}

.loading-state {
  display: flex;
  justify-content: center;
  padding: 24px 0;
}

.empty-state {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}

.error-state {
  margin: 8px 0 0;
  color: var(--error);
  font-size: 14px;
}

@media (max-width: 600px) {
  .settings-card {
    padding: 16px;
  }

  .sound-form {
    grid-template-columns: 1fr;
  }

  .sound-row {
    flex-wrap: wrap;
  }

  .volume-input {
    width: 100%;
  }
}
</style>
