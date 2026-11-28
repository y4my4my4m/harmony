<template>
<!-- Announcements -->
<div class="admin-module announcements-module">
  <div class="module-header">
    <Icon name="message-square" :size="20" />
    <h2>{{ t('announcements.title') }}</h2>
    <button @click="showAnnouncementForm = true" class="primary-btn-sm">
      <Icon name="plus" :size="14" />
      {{ t('common.create') }}
    </button>
  </div>
  <p class="module-hint">{{ t('admin.announcements.hint') }}</p>
  <div v-if="showAnnouncementForm" class="announcement-form">
    <h4>{{ editingAnnouncementId ? t('admin.announcements.editTitle') : t('admin.announcements.newTitle') }}</h4>
    <div class="form-row">
      <label>{{ t('admin.announcements.titleLabel') }}</label>
      <input v-model="announcementForm.title" class="cyber-input" :placeholder="t('admin.announcements.titlePlaceholder')" />
    </div>
    <div class="form-row">
      <label>{{ t('admin.announcements.contentLabel') }}</label>
      <textarea v-model="announcementForm.content" class="cyber-input" rows="4" :placeholder="t('admin.announcements.contentPlaceholder')"></textarea>
    </div>
    <div class="form-row">
      <label>{{ t('admin.announcements.iconLabel') }}</label>
      <input v-model="announcementForm.icon" class="cyber-input" placeholder="info" />
    </div>
    <div class="form-row">
      <label>{{ t('admin.announcements.imageUrlLabel') }}</label>
      <input v-model="announcementForm.image_url" class="cyber-input" type="url" placeholder="https://..." />
    </div>
    <div class="form-row two-col">
      <div>
        <label>{{ t('admin.announcements.startsAtLabel') }}</label>
        <input
          v-model="announcementForm.starts_at"
          class="cyber-input"
          type="datetime-local"
        />
        <p class="form-hint">{{ t('admin.announcements.startsAtHint') }}</p>
      </div>
      <div>
        <label>{{ t('admin.announcements.endsAtLabel') }}</label>
        <input
          v-model="announcementForm.ends_at"
          class="cyber-input"
          type="datetime-local"
          :min="announcementForm.starts_at || undefined"
        />
        <p class="form-hint">{{ t('admin.announcements.endsAtHint') }}</p>
      </div>
    </div>
    <div class="form-row checks">
      <label class="toggle-label">
        <input type="checkbox" v-model="announcementForm.is_pinned" />
        <span class="toggle-slider"></span>
        <span class="toggle-text">{{ t('admin.announcements.pinned') }}</span>
      </label>
      <label class="toggle-label">
        <input type="checkbox" v-model="announcementForm.show_popup" />
        <span class="toggle-slider"></span>
        <span class="toggle-text">{{ t('admin.announcements.showPopup') }}</span>
      </label>
      <label class="toggle-label" v-if="editingAnnouncementId">
        <input type="checkbox" v-model="announcementForm.is_active" />
        <span class="toggle-slider"></span>
        <span class="toggle-text">{{ t('admin.announcements.active') }}</span>
      </label>
    </div>
    <div class="form-actions">
      <button @click="saveAnnouncement" class="primary-btn-sm" :disabled="!announcementForm.title || !announcementForm.content">
        {{ editingAnnouncementId ? t('common.update') : t('common.create') }}
      </button>
      <button @click="cancelAnnouncementForm" class="cyber-btn-sm">{{ t('common.cancel') }}</button>
    </div>
  </div>
  <div class="announcements-list">
    <div v-for="a in announcements" :key="a.id" class="announcement-item">
      <div class="announcement-meta">
        <span class="announcement-icon">
          <template v-if="announcementIcon(a.icon).emoji">{{ announcementIcon(a.icon).emoji }}</template>
          <Icon v-else :name="announcementIcon(a.icon).name!" :size="18" />
        </span>
        <span class="announcement-title">{{ a.title }}</span>
        <span v-if="a.is_pinned" class="badge">{{ t('admin.announcements.pinned') }}</span>
        <span v-if="!a.is_active" class="badge inactive">{{ t('admin.announcements.inactive') }}</span>
      </div>
      <div class="announcement-actions">
        <button @click="editAnnouncement(a)" class="action-btn-sm" :title="t('common.edit')" :aria-label="t('common.edit')">
          <Icon name="edit" :size="14" />
        </button>
        <button @click="deleteAnnouncement(a.id)" class="danger-btn-sm" :title="t('common.delete')" :aria-label="t('common.delete')">
          <Icon name="trash" :size="14" />
        </button>
      </div>
    </div>
    <EmptyState
      v-if="announcements.length === 0 && !loadingStates.announcements"
      icon="megaphone"
      :title="t('empty.admin.announcements.title')"
      :description="t('empty.admin.announcements.description')"
    />
  </div>
</div>

</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { debug } from '@/utils/debug'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import { announcementIcon } from '@/utils/announcementIcon'
import EmptyState from '@/components/common/EmptyState.vue'
import { announcementService, type Announcement } from '@/services/AnnouncementService'
import { useConfirmDialog } from '@/composables/useConfirmDialog'


const { t } = useI18n()
const toast = useToast()
const { confirm } = useConfirmDialog()

const loadingStates = ref({ announcements: false })


// Announcements
const announcements = ref<Announcement[]>([])
const showAnnouncementForm = ref(false)
const editingAnnouncementId = ref<string | null>(null)
const announcementForm = ref({
  title: '',
  content: '',
  icon: 'info',
  image_url: '',
  is_pinned: false,
  show_popup: true,
  is_active: true,
  // datetime-local strings ("YYYY-MM-DDTHH:mm" in the admin's local TZ).
  // Empty string means "use the DB default" (now() for starts_at, NULL /
  // never-expires for ends_at). Converted to ISO at save time via
  // `localInputToIso` so PostgreSQL stores UTC.
  starts_at: '',
  ends_at: '',
})


// datetime-local <-> ISO helpers
// HTML's `datetime-local` input gives us a naive local timestamp without a
// timezone (e.g. "2026-05-26T21:00"). We convert in both directions so the
// admin sees their own timezone but the DB stores UTC ISO strings.
//
// Both helpers are intentionally null-safe and treat an empty input as "no
// value" rather than as the Unix epoch.
function localInputToIso(local: string): string | undefined {
  if (!local) return undefined
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toISOString()
}

function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  // Shift by the local TZ offset so `toISOString().slice(0, 16)` formats
  // as the admin's wall-clock time rather than as UTC.
  const tzOffsetMs = d.getTimezoneOffset() * 60_000
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 16)
}


const loadAnnouncements = async () => {
  loadingStates.value.announcements = true
  try {
    announcements.value = await announcementService.getAllAnnouncements()
  } catch (error) {
    debug.error('Failed to load announcements:', error)
    announcements.value = []
  } finally {
    loadingStates.value.announcements = false
  }
}



const saveAnnouncement = async () => {
  if (!announcementForm.value.title || !announcementForm.value.content) return

  // Asymmetric handling for the two timestamps:
  //   * `starts_at`: an empty input means "use the DB default (now()) on
  //     create" / "leave the existing value alone on update". Sending
  //     undefined makes the Supabase client omit the key entirely.
  //   * `ends_at`:   an empty input means "no expiration" - admins clearing
  //     the field must be able to explicitly drop the value back to NULL,
  //     otherwise an existing expiry would be impossible to remove. We
  //     send `null` rather than undefined so the column is overwritten.
  // Cross-field validation: end-before-start would silently produce an
  // announcement that's already expired the moment it's published.
  const startsIso = localInputToIso(announcementForm.value.starts_at)
  const endsIsoOrNull = announcementForm.value.ends_at
    ? localInputToIso(announcementForm.value.ends_at) ?? null
    : null
  if (startsIso && endsIsoOrNull && new Date(endsIsoOrNull) <= new Date(startsIso)) {
    toast.error(t('admin.announcements.endBeforeStart'))
    return
  }
  try {
    if (editingAnnouncementId.value) {
      await announcementService.updateAnnouncement(editingAnnouncementId.value, {
        title: announcementForm.value.title,
        content: announcementForm.value.content,
        icon: announcementForm.value.icon || 'info',
        image_url: announcementForm.value.image_url || undefined,
        is_pinned: announcementForm.value.is_pinned,
        show_popup: announcementForm.value.show_popup,
        is_active: announcementForm.value.is_active,
        starts_at: startsIso,
        ends_at: endsIsoOrNull,
      })
      toast.success(t('admin.announcements.updated'))
    } else {
      await announcementService.createAnnouncement({
        title: announcementForm.value.title,
        content: announcementForm.value.content,
        icon: announcementForm.value.icon || 'info',
        image_url: announcementForm.value.image_url || undefined,
        is_pinned: announcementForm.value.is_pinned,
        show_popup: announcementForm.value.show_popup,
        starts_at: startsIso,
        ends_at: endsIsoOrNull,
      })
      toast.success(t('admin.announcements.created'))
    }
    cancelAnnouncementForm()
    await loadAnnouncements()
  } catch (error: any) {
    debug.error('Failed to save announcement:', error)
    toast.error(error.message || t('admin.announcements.saveFailed'))
  }
}

const cancelAnnouncementForm = () => {
  showAnnouncementForm.value = false
  editingAnnouncementId.value = null
  announcementForm.value = {
    title: '',
    content: '',
    icon: 'info',
    image_url: '',
    is_pinned: false,
    show_popup: true,
    is_active: true,
    starts_at: '',
    ends_at: '',
  }
}

const editAnnouncement = (a: Announcement) => {
  editingAnnouncementId.value = a.id
  announcementForm.value = {
    title: a.title,
    content: a.content,
    icon: a.icon || 'info',
    image_url: a.image_url || '',
    is_pinned: a.is_pinned ?? false,
    show_popup: a.show_popup ?? true,
    is_active: (a as any).is_active ?? true,
    // Convert the DB-stored UTC ISO back to the admin's local "YYYY-MM-DDTHH:mm"
    // so the datetime-local inputs render the wall-clock time they originally
    // entered, not UTC. Empty when unset.
    starts_at: isoToLocalInput((a as any).starts_at),
    ends_at: isoToLocalInput(a.ends_at),
  }
  showAnnouncementForm.value = true
}

const deleteAnnouncement = async (id: string) => {
  if (!(await confirm({ title: t('admin.announcements.deleteTitle'), message: t('admin.announcements.deleteMessage'), confirmButtonText: t('common.delete'), dangerAction: true }))) return
  try {
    await announcementService.deleteAnnouncement(id)
    toast.success(t('admin.announcements.deleted'))
    await loadAnnouncements()
  } catch (error: any) {
    debug.error('Failed to delete announcement:', error)
    toast.error(error.message || t('admin.announcements.deleteFailed'))
  }
}

onMounted(() => { void loadAnnouncements() })
</script>

<style scoped>








.toggle-label {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  cursor: pointer;
}









/* Override parent label styles so toggles stay horizontal and text doesn't truncate */
.setting-group .toggle-label,
.announcement-form .form-row.checks .toggle-label {
  display: flex;
  margin-bottom: 0;
}









.toggle-label .toggle-slider {
  flex-shrink: 0;
}









.toggle-label .toggle-text {
  flex-shrink: 0;
  white-space: nowrap;
}









.toggle-label input[type="checkbox"] {
  display: none;
}









.toggle-slider {
  position: relative;
  width: 44px;
  height: 24px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
  transition: all 0.2s ease;
}









.toggle-slider:before {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  background: var(--text-secondary);
  border-radius: 50%;
  transition: all 0.2s ease;
}









.toggle-label input[type="checkbox"]:checked + .toggle-slider {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
}









.toggle-label input[type="checkbox"]:checked + .toggle-slider:before {
  left: 22px;
  background: var(--text-on-primary);
}









.badge.inactive {
  background: var(--background-modifier-active);
  color: var(--text-muted);
}









/* Announcements module */
.module-hint {
  font-size: 13px;
  color: var(--text-secondary);
  padding: 16px 24px;
  margin: 0;
  text-align: center;
  line-height: 1.5;
}








.announcement-form {
  margin: 0 24px 20px;
  padding: 20px;
  background: var(--background-tertiary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
}








.announcement-form h4 { margin: 0 0 16px 0; }








.announcement-form .form-row { margin-bottom: 12px; }








.announcement-form .form-row label { display: block; font-size: 13px; margin-bottom: 4px; color: var(--text-secondary); }








.announcement-form .form-row.checks { display: flex; gap: 16px; flex-wrap: wrap; }








.announcement-form .form-row.two-col {
  /* Two-up layout for the scheduling inputs so the form doesn't get
     unnecessarily tall. Collapses to a stack on narrow viewports. */
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

@media (max-width: 640px) {




  .announcement-form .form-row.two-col { grid-template-columns: 1fr; }
}








.announcement-form .form-row.two-col > div { display: flex; flex-direction: column; }








.announcement-form .form-row.two-col label { margin-bottom: 4px; }








.announcement-form .form-hint {
  margin: 4px 0 0 0;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.35;
}








.announcement-form .form-actions { display: flex; gap: 8px; margin-top: 16px; }








.announcements-list { padding: 0 24px 24px; }








.announcement-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: var(--background-tertiary);
  border-radius: var(--radius-md);
  margin-bottom: 8px;
  border: 1px solid var(--border-color);
}








.announcement-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }








.announcement-icon { font-size: 18px; }








.announcement-title { font-weight: 600; color: var(--text-primary); }








.announcement-item .badge.inactive { background: var(--background-quaternary); color: var(--text-muted); }








.announcement-actions { display: flex; gap: 4px; }









/* Featured Communities Module */
.featured-module .module-hint { margin: 0 24px 16px; font-size: 13px; color: var(--text-secondary); }
</style>

<style scoped src="./adminShared.css"></style>
