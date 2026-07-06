<template>
  <div class="user-account-settings">
    <div class="settings-header">
      <h2 class="settings-title">{{ $t('settings.account') }}</h2>
      <p class="settings-description">
        Manage your account settings and set e-mail preferences.
      </p>
    </div>

    <div class="settings-section" style="padding: 0">
      <div class="profile-preview">
        <div 
          class="profile-banner" 
          :style="bannerStyle"
          @click="triggerBannerUpload"
        >
          <div v-if="bannerUploading" class="banner-loading-overlay">
            <span class="banner-spinner"></span>
            <span>Uploading...</span>
          </div>
          <div v-else class="banner-overlay">
            <Icon name="camera" />
            <span>{{ $t('user.banner') }}</span>
          </div>
          <input
            ref="bannerInput"
            type="file"
            accept="image/*"
            @change="handleBannerFileSelect"
            style="display: none"
          />
        </div>
        <div class="profile-info">
          <div class="avatar-wrapper">
            <Avatar 
              :src="profile?.avatar_url"
              :alt="$t('user.avatar')"
              size="xl"
              :editable="true"
              :loading="loading && !bannerUploading"
              @upload="handleAvatarUpload"
            />
          </div>
          <div class="user-info">
            <h3 class="display-name" :style="{ color: profile?.color || '#ffffff' }">
              <DisplayName
                v-if="localProfile.display_name"
                :parts="previewDisplayNameParts"
                :fallback="localProfile.display_name || profile?.display_name || $t('auth.displayName')"
                :color="localProfile.color || profile?.color || '#ffffff'"
              />
              <template v-else>{{ profile?.display_name || $t('auth.displayName') }}</template>
            </h3>
            <p class="username">{{ profile?.username || $t('auth.username') }}</p>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="form-group">
        <label class="form-label">{{ $t('auth.displayName') }}</label>
        <div class="display-name-input-wrapper">
          <input
            ref="displayNameInput"
            v-model="localProfile.display_name"
            type="text"
            class="form-input"
            :placeholder="$t('auth.displayName')"
            maxlength="50"
            @input="onDisplayNameInput"
            @keydown="onDisplayNameKeyDown"
          />
          <AutoSuggest
            v-if="displayNameAutoSuggest.state.value.isActive && instanceSettings.settings.allowCustomEmojisInDisplayNames"
            :isVisible="displayNameAutoSuggest.state.value.isActive"
            :suggestions="displayNameAutoSuggest.suggestions.value"
            :selected-index="displayNameAutoSuggest.state.value.selectedIndex"
            :position="displayNameAutoSuggest.state.value.position"
            :header-text="displayNameAutoSuggest.headerText.value"
            @select="onDisplayNameEmojiSelect"
          />
        </div>
        <div class="form-hint">
          This is how others see you.{{ instanceSettings.settings.allowCustomEmojisInDisplayNames ? ' You can use custom emoji (type : to search).' : '' }} {{ (localProfile.display_name?.length || 0) }}/50
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">{{ $t('auth.username') }}</label>
        <div class="username-input-container">
          <input
            v-model="localProfile.username"
            type="text"
            class="form-input"
            :placeholder="$t('auth.username')"
            maxlength="32"
            disabled
            readonly
          />
        </div>
        <div class="form-hint">
          Username cannot be changed until federation username updates are properly implemented.
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">{{ $t('user.bio') }}</label>
        <textarea
          v-model="localProfile.bio"
          class="form-textarea"
          :placeholder="$t('user.placeholders.bio')"
          maxlength="500"
          rows="3"
          @input="onProfileChange"
        ></textarea>
        <div class="form-hint">
          {{ (localProfile.bio?.length || 0) }}/500 characters
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Display Color</label>
        <div class="color-picker-container">
          <div class="color-preview-row">
            <div class="color-hex-field">
              <button
                type="button"
                class="color-hex-swatch"
                :style="{ backgroundColor: localProfile.color || '#0EA5E9' }"
                ref="colorPreviewRef"
                aria-label="Open color picker"
                @click="toggleColorPicker"
              ></button>
              <input
                v-model="localProfile.color"
                type="text"
                class="form-input color-hex-input"
                :placeholder="localProfile.color || '#0EA5E9'"
                @input="onColorChange"
              />
            </div>
            <button type="button" class="btn btn-secondary color-reset-btn" @click="resetColor">
              {{ $t('common.reset') }}
            </button>
          </div>
          <div
            v-show="showColorPicker"
            v-click-outside="closeColorPicker"
            ref="colorPickerRef"
            class="color-picker-popover"
          >
            <ColorPicker
              :color="normalizedProfileColor"
              @update:color="onColorPickerChange"
              @change="onColorPickerChange"
            />
          </div>
        </div>
        <div class="form-hint">
          Used for your display name and profile accents.
        </div>
      </div>
    </div>

    <!--
      Profile fields editor (name/value link rows shown on the profile
      page; e.g. "EMISSARY → https://emissary.dev"). Backed by the
      `profiles.profile_fields` jsonb column and federated to remote
      instances as ActivityPub PropertyValue attachments (see
      toActivityPub.ts:191). Capped at PROFILE_FIELDS_MAX rows so the
      profile UI stays readable and to match Mastodon/Misskey conventions.
    -->
    <div class="settings-section">
      <h3 class="section-title">Profile fields</h3>
      <p class="section-description">
        Add up to {{ PROFILE_FIELDS_MAX }} short links or labels to your profile - websites, social handles, anything you want others to find you on. Visible on your profile page and federated to other ActivityPub instances.
      </p>

      <div class="profile-fields-editor" v-if="localProfileFields.length > 0">
        <div
          v-for="(field, index) in localProfileFields"
          :key="index"
          class="profile-field-row"
        >
          <div class="profile-field-inputs">
            <input
              v-model="field.name"
              type="text"
              class="form-input profile-field-name"
              placeholder="Label (e.g. Website)"
              :maxlength="PROFILE_FIELD_NAME_MAX"
              @input="onProfileChange"
            />
            <input
              v-model="field.value"
              type="text"
              class="form-input profile-field-value"
              placeholder="Value (e.g. https://example.com)"
              :maxlength="PROFILE_FIELD_VALUE_MAX"
              @input="onProfileChange"
            />
          </div>
          <button
            type="button"
            class="profile-field-remove"
            :title="'Remove this field'"
            :aria-label="'Remove field'"
            @click="removeProfileField(index)"
          >
            <Icon name="x" :size="14" />
          </button>
        </div>
      </div>
      <p v-else class="profile-fields-empty">No fields yet. Add one below.</p>

      <button
        type="button"
        class="profile-field-add"
        :disabled="localProfileFields.length >= PROFILE_FIELDS_MAX"
        @click="addProfileField"
      >
        <Icon name="plus" :size="14" />
        Add field
        <span class="profile-field-count">{{ localProfileFields.length }} / {{ PROFILE_FIELDS_MAX }}</span>
      </button>
    </div>

    <div class="settings-section">
      <h3 class="section-title">{{ $t('user.profile') }}</h3>
      
      <div class="info-row">
        <div class="info-label">{{ $t('auth.email') }}</div>
        <div class="info-value">{{ userEmail || 'Not provided' }}</div>
      </div>
      
      <div class="info-row">
        <div class="info-label">{{ $t('user.since') }}</div>
        <div class="info-value">{{ formatDate(profile?.created_at) }}</div>
      </div>
    </div>

    <!-- Support -->
    <div class="settings-section supporter-section">
      <h3 class="section-title">Support</h3>
      <p class="section-description">
        Supporting this instance helps keep it running and contributes to its development.
        Supporters get a badge displayed next to their name based on their cumulative
        donations during the current cycle.
      </p>

      <div class="donor-handle-callout">
        <p class="donor-handle-callout-title">
          <Icon name="info" :size="14" /> How to get your supporter badge
        </p>
        <p>
          When donating, include this handle <strong>anywhere</strong> in your message -
          we'll match it automatically and assign the right tier:
        </p>
        <div class="donor-handle-row">
          <code class="donor-handle-token">@{{ currentUserHandleShort || 'username' }}@{{ supporterInstanceDomain }}</code>
          <button
            v-if="currentUserHandleShort"
            type="button"
            class="donor-copy-btn"
            @click="copyCurrentSupportHandle"
          >
            <Icon name="copy" :size="12" /> Copy
          </button>
        </div>

        <details class="donor-examples">
          <summary>See message examples</summary>
          <ul class="donor-examples-list">
            <li>
              <code>@{{ currentUserHandleShort || 'alice' }}@{{ supporterInstanceDomain }}</code>
              <span class="example-note">Just the handle - works fine.</span>
            </li>
            <li>
              <code>thanks for the great instance! @{{ currentUserHandleShort || 'alice' }}@{{ supporterInstanceDomain }}</code>
              <span class="example-note">Handle at the end - works.</span>
            </li>
            <li>
              <code>@{{ currentUserHandleShort || 'alice' }}@{{ supporterInstanceDomain }} keep it up &lt;3</code>
              <span class="example-note">Handle at the start with a note - works.</span>
            </li>
            <li>
              <code>hey ping me @{{ currentUserHandleShort || 'alice' }}@{{ supporterInstanceDomain }} when the new feature ships</code>
              <span class="example-note">Handle in the middle - works.</span>
            </li>
          </ul>
        </details>

        <p class="donor-handle-hint">
          If you forget the handle, your donation isn't lost - it's queued
          for the admins to review and attribute manually. Auto-matching is
          just faster.
        </p>
      </div>

      <div v-if="supporterLoading" class="supporter-loading">Loading...</div>
      <template v-else>
        <div v-if="supporterBadge" class="supporter-card">
          <span
            class="supporter-badge-preview"
            :style="supporterBadge.badge_color ? {
              backgroundColor: supporterBadge.badge_color + '20',
              borderColor: supporterBadge.badge_color,
              color: supporterBadge.badge_color
            } : {}"
          ><SupporterBadgeIcon :icon="supporterBadge.badge_icon" /></span>
          <div class="supporter-details">
            <span class="supporter-tier">{{ supporterBadge.tier_name }} Supporter</span>
            <span class="supporter-active">Active</span>
          </div>
        </div>
        <div v-else class="supporter-card supporter-inactive">
          <span class="supporter-inactive-text">Not currently a supporter</span>
        </div>

        <div v-if="supporterDonations.length > 0" class="supporter-donations">
          <div v-for="donation in supporterDonations" :key="donation.id" class="supporter-donation-row">
            <span class="donation-amt">{{ donation.currency }} {{ donation.amount }}</span>
            <span class="donation-dt">{{ formatDate(donation.donated_at) }}</span>
            <span v-if="donation.platform" class="donation-plat">{{ donation.platform }}</span>
          </div>
        </div>

        <div v-if="fundingLinks.length > 0" class="supporter-links">
          <a
            v-for="(link, i) in fundingLinks"
            :key="i"
            :href="link.url"
            target="_blank"
            rel="noopener noreferrer"
            class="supporter-link"
          >
            <PlatformIcon :platform="link.platform" :size="16" :use-brand-color="true" />
            <span>{{ link.label || link.platform }}</span>
          </a>
        </div>
      </template>
    </div>

    <div class="settings-actions">
      <button 
        class="btn btn-primary" 
        @click="saveChanges"
        :disabled="loading || !hasChanges"
      >
        <span v-if="loading" class="loading-spinner"></span>
        {{ $t('common.save') }}
      </button>
      <button 
        class="btn btn-secondary" 
        @click="resetChanges"
        :disabled="loading || !hasChanges"
      >
        {{ $t('common.reset') }}
      </button>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { debug } from '@/utils/debug'
import { useAuthStore } from '@/stores/auth'
import type { User } from '@/types'
import { format } from 'date-fns'
import { getBannerUrl } from '@/utils/bannerUtils'

// Components
import ColorPicker from '@/components/common/ColorPicker.vue'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import AutoSuggest from '@/components/AutoSuggest.vue'
import DisplayName from '@/components/DisplayName.vue'
import SupporterBadgeIcon from '@/components/common/SupporterBadgeIcon.vue'
import PlatformIcon from '@/components/common/PlatformIcon.vue'
import { fundingService, type SupporterBadge, type DonationRecord, type FundingLink } from '@/services/FundingService'
import { supabase } from '@/supabase'
import { useAutoSuggest } from '@/composables/useAutoSuggest'
import { userDataService } from '@/services/userDataService'
import { getInstanceDomain } from '@/services/instanceConfig'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'
import { useToast } from 'vue-toastification'

// Props
interface Props {
  profile: User | null
  loading: boolean
  bannerUploading?: boolean
}

const props = defineProps<Props>()

// Emits
const emit = defineEmits<{
  'update-profile': [profile: Partial<User>]
  'upload-avatar': [file: File]
  'upload-banner': [file: File]
}>()

// Composables
const authStore = useAuthStore()
const instanceSettings = useInstanceSettingsStore()
const toast = useToast()

// State
const localProfile = ref<Partial<User>>({})
const bannerKey = ref(0) // For forcing banner reload

// ---------------------------------------------------------------------------
// Profile fields editor state
// ---------------------------------------------------------------------------
// Editable mirror of `profile_fields`. We DECODE the stored HTML on load
// (extracting the bare URL out of any `<a href="...">...</a>` wrapper) so the
// user sees the plain value they originally typed, and ENCODE on save
// (wrapping URL-shaped values in an <a> tag) so federated instances render
// them as clickable links. This matches Mastodon's storage format and keeps
// the editing UX as "type a URL, hit save" without exposing HTML to the user.
const PROFILE_FIELDS_MAX = 4
const PROFILE_FIELD_NAME_MAX = 255
const PROFILE_FIELD_VALUE_MAX = 255

interface EditableField { name: string; value: string }
const localProfileFields = ref<EditableField[]>([])
const showColorPicker = ref(false)

const URL_REGEX = /^https?:\/\/[^\s<>]+$/i
const URL_HREF_REGEX = /^<a [^>]*\bhref=["']([^"']+)["'][^>]*>[\s\S]*<\/a>$/i

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function encodeFieldValueForStorage(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (URL_REGEX.test(trimmed)) {
    const safe = escapeHtmlAttribute(trimmed)
    // `rel="me"` is the Mastodon convention for link verification (rel=me
    // back from the destination would mark the field as verified). We keep
    // noopener/noreferrer/nofollow so the link follows the same security
    // posture as the rest of our outbound profile links.
    return `<a href="${safe}" target="_blank" rel="me nofollow noopener noreferrer">${safe}</a>`
  }
  // Plain text value: HTML-escape so the v-html-based display layer
  // doesn't accidentally execute or render it as markup.
  return escapeHtmlAttribute(trimmed)
}

function decodeFieldValueForEditing(value: string): string {
  if (!value) return ''
  // Strip a single outer <a> wrapper around a URL - the most common shape,
  // and what we write back in encodeFieldValueForStorage. Anything more
  // complex (mixed HTML / multiple anchors) falls through unchanged; the
  // user can still edit it as raw text if they want.
  const match = value.match(URL_HREF_REGEX)
  if (match) return match[1]
  return value
}

function addProfileField() {
  if (localProfileFields.value.length >= PROFILE_FIELDS_MAX) return
  localProfileFields.value.push({ name: '', value: '' })
}

function removeProfileField(index: number) {
  localProfileFields.value.splice(index, 1)
  onProfileChange()
}

// Refs
const colorPickerRef = ref<HTMLElement | null>(null)
const colorPreviewRef = ref<HTMLElement | null>(null)
const bannerInput = ref<HTMLInputElement>()
const displayNameInput = ref<HTMLInputElement | null>(null)

const displayNameAutoSuggest = useAutoSuggest(
  displayNameInput,
  () => localProfile.value.display_name || '',
  (newText: string, cursorPosition?: number) => {
    localProfile.value.display_name = newText
    if (cursorPosition !== undefined && displayNameInput.value) {
      nextTick(() => {
        displayNameInput.value?.setSelectionRange(cursorPosition, cursorPosition)
      })
    }
  },
  { mode: 'chat', enableEmojis: true, enableMentions: false }
)

// Computed
const userEmail = computed(() => authStore.session?.user?.email)

// Snapshot of the editable fields as they were when the form was last
// synced from props. Used purely for the dirty check; we compare the
// JSON-stringified form because the array shape is small and a deep-equal
// dependency isn't worth pulling in for this one place.
const initialProfileFieldsJson = ref('[]')

const hasChanges = computed(() => {
  if (!props.profile) return false

  const baseChanged =
    localProfile.value.display_name !== props.profile.display_name ||
    localProfile.value.bio !== props.profile.bio ||
    localProfile.value.color !== props.profile.color
  if (baseChanged) return true

  // Compare the editable mirror against the snapshot taken at sync time
  // so adding an empty row OR clearing an existing field both register as
  // dirty (and so re-saving without changes correctly disables the button).
  return JSON.stringify(localProfileFields.value) !== initialProfileFieldsJson.value
  // Note: username is excluded from changes - it cannot be edited until federation is fixed
})

const emojiCacheStore = useEmojiCacheStore()

// Async-resolve custom emojis from the DB so the preview can distinguish
// between a custom emoji named "fire" and the standard unicode fire emoji.
const SHORTCODE_RE = /:([a-zA-Z0-9_+-]+):/g
const resolvedPinnedEmojis = ref<Array<{ id: string; name: string; url: string }>>([])
watch(
  () => localProfile.value.display_name,
  async (dn) => {
    if (!dn || !instanceSettings.settings.allowCustomEmojisInDisplayNames) {
      resolvedPinnedEmojis.value = []
      return
    }
    const codes: string[] = []
    let m: RegExpExecArray | null
    SHORTCODE_RE.lastIndex = 0
    while ((m = SHORTCODE_RE.exec(dn)) !== null) codes.push(m[1])
    if (codes.length === 0) { resolvedPinnedEmojis.value = []; return }

    const { data } = await supabase
      .from('emojis')
      .select('id, name, url')
      .in('name', codes)
      .not('url', 'is', null)
    resolvedPinnedEmojis.value = (data || []).map((e: any) => ({ id: e.id, name: e.name, url: e.url }))
  },
  { immediate: true },
)

const previewDisplayNameParts = computed(() => {
  const dn = localProfile.value.display_name
  if (!dn) return undefined
  if (!instanceSettings.settings.allowCustomEmojisInDisplayNames) return undefined
  emojiCacheStore.resolvedEmojis
  return userDataService.resolveDisplayNameParts(
    dn,
    resolvedPinnedEmojis.value.length > 0 ? resolvedPinnedEmojis.value : undefined,
  )
})

const bannerStyle = computed(() => {
  // Include bannerKey to force reactivity when banner changes
  bannerKey.value
  const bannerUrl = getBannerUrl(props.profile?.banner_url, { width: 1280, height: 720, quality: 80 })
  if (bannerUrl) {
    return {
      backgroundImage: `url(${bannerUrl})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center'
    }
  }
  return {
    backgroundColor: props.profile?.color || '#0EA5E9'
  }
})

// Methods
const syncLocalProfile = () => {
  if (props.profile) {
    localProfile.value = {
      display_name: props.profile.display_name || '',
      username: props.profile.username || '',
      bio: props.profile.bio || '',
      color: props.profile.color || '#0EA5E9'
    }
    // Decode any stored HTML wrappers (e.g. `<a href="...">URL</a>`) back
    // to bare plain text so the user edits what they originally typed.
    const incoming = ((props.profile as any).profile_fields ?? []) as Array<{ name: string; value: string }>
    localProfileFields.value = incoming.map((f) => ({
      name: f.name ?? '',
      value: decodeFieldValueForEditing(f.value ?? ''),
    }))
    initialProfileFieldsJson.value = JSON.stringify(localProfileFields.value)
  }
}

const onProfileChange = () => {
  // Debounce could be added here if needed
}

const onDisplayNameInput = () => {
  const el = displayNameInput.value
  if (!el) return
  displayNameAutoSuggest.handleInput(el.value, el.selectionStart || el.value.length)
  onProfileChange()
}

const onDisplayNameKeyDown = (e: KeyboardEvent) => {
  displayNameAutoSuggest.handleKeyDown(e)
}

const onDisplayNameEmojiSelect = (suggestion: any) => {
  displayNameAutoSuggest.selectSuggestion(suggestion)
}

// Username editing is disabled until federation username updates are properly implemented
// const onUsernameChange = () => {
//   // Format username (remove special characters, convert to lowercase)
//   if (localProfile.value.username) {
//     localProfile.value.username = localProfile.value.username
//       .toLowerCase()
//       .replace(/[^a-z0-9_]/g, '')
//   }
// }

const onColorChange = () => {
  const color = localProfile.value.color
  if (color && !color.startsWith('#')) {
    localProfile.value.color = '#' + color
  }
}

const normalizedProfileColor = computed(() => {
  const color = localProfile.value.color || '#0EA5E9'
  return color.startsWith('#') ? color : `#${color}`
})

const onColorPickerChange = (hex: string) => {
  localProfile.value.color = hex
}

const toggleColorPicker = () => {
  showColorPicker.value = !showColorPicker.value
}

const closeColorPicker = () => {
  showColorPicker.value = false
}

const resetColor = () => {
  localProfile.value.color = '#0EA5E9'
}

const handleAvatarUpload = (file: File) => {
  emit('upload-avatar', file)
}

const triggerBannerUpload = () => {
  debug.log('🖼️ Banner upload triggered')
  bannerInput.value?.click()
}

const handleBannerFileSelect = (event: Event) => {
  debug.log('📁 Banner file selected')
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (file) {
    debug.log('📤 Emitting banner upload event:', file.name, file.size)
    emit('upload-banner', file)
    target.value = ''
  } else {
    debug.log('❌ No file selected')
  }
}

const DISPLAY_NAME_EMOJI_REGEX = /:([a-zA-Z0-9_+-]+):/
const saveChanges = () => {
  if (!hasChanges.value) return

  // Require a non-empty display name. Otherwise the user shows up as
  // `Unknown User` everywhere via the `getUserDisplayName` fallback - bad
  // UX and a confusing impersonation surface. Both the service-layer
  // validation (`CoreProfileService.validateProfileData`) and the DB
  // CHECK constraint (`profiles_display_name_not_blank`) also enforce
  // this; surfacing it here turns the trip into a one-step toast rather
  // than a roundtrip + generic error.
  const trimmedDisplayName = (localProfile.value.display_name || '').trim()
  if (trimmedDisplayName.length === 0) {
    toast.error('Display name cannot be empty.')
    return
  }
  // Persist the trimmed value so we don't store leading/trailing
  // whitespace.
  localProfile.value.display_name = trimmedDisplayName

  if (!instanceSettings.settings.allowCustomEmojisInDisplayNames && localProfile.value.display_name && DISPLAY_NAME_EMOJI_REGEX.test(localProfile.value.display_name)) {
    toast.error('Custom emojis in display names are disabled on this instance. Please remove emoji shortcodes (e.g. :name:) from your display name.')
    return
  }

  // Build the persistable profile_fields array:
  //   - drop completely-empty rows (both name and value blank) so the user
  //     can leave an unused row visible without it being persisted;
  //   - reject rows that have only one of (name, value) - partial rows
  //     wouldn't render anything useful on the profile page;
  //   - encode URL-shaped values into <a> wrappers so federated renderers
  //     produce clickable links.
  const cleanedFields: Array<{ name: string; value: string }> = []
  for (const row of localProfileFields.value) {
    const name = row.name.trim()
    const value = row.value.trim()
    if (!name && !value) continue
    if (!name || !value) {
      toast.error('Each profile field needs both a label and a value.')
      return
    }
    cleanedFields.push({
      name,
      value: encodeFieldValueForStorage(value),
    })
  }

  emit('update-profile', {
    ...localProfile.value,
    profile_fields: cleanedFields,
  } as Partial<User>)
}

const resetChanges = () => {
  syncLocalProfile()
}

const formatDate = (dateString?: string) => {
  if (!dateString) return 'Unknown'
  return format(new Date(dateString), 'MMMM d, yyyy')
}

const vClickOutside = {
  beforeMount(el: HTMLElement & { __vueClickOutside__?: (event: MouseEvent) => void }, binding: { value: () => void }) {
    const onClick = (event: MouseEvent) => {
      if (el && !el.contains(event.target as Node) &&
          (!colorPreviewRef.value || !colorPreviewRef.value.contains(event.target as Node))) {
        binding.value()
      }
    }
    el.__vueClickOutside__ = onClick
    document.addEventListener('click', onClick)
  },
  unmounted(el: HTMLElement & { __vueClickOutside__?: (event: MouseEvent) => void }) {
    if (el.__vueClickOutside__) {
      document.removeEventListener('click', el.__vueClickOutside__)
    }
    el.__vueClickOutside__ = undefined
  },
}

// Watchers
watch(() => props.profile, syncLocalProfile, { immediate: true })

// Watch for banner URL changes to trigger UI refresh
watch(() => props.profile?.banner_url, (newBannerUrl, oldBannerUrl) => {
  if (newBannerUrl !== oldBannerUrl) {
    bannerKey.value++
  }
}, { immediate: false })

// Supporter section
const supporterLoading = ref(true)
const supporterBadge = ref<SupporterBadge | null>(null)
const supporterDonations = ref<DonationRecord[]>([])
const fundingLinks = ref<FundingLink[]>([])

// Used by the donor-handle callout in the Support section. Pulls from the
// loaded profile (already passed in via props) so the user sees their own
// handle pre-filled and can copy with one click.
const supporterInstanceDomain = computed(() => getInstanceDomain())
const currentUserHandleShort = computed(() => props.profile?.username ?? '')
const copyCurrentSupportHandle = async () => {
  if (!currentUserHandleShort.value) return
  try {
    await navigator.clipboard.writeText(
      `@${currentUserHandleShort.value}@${supporterInstanceDomain.value}`,
    )
    toast.success('Handle copied')
  } catch {
    toast.error('Failed to copy')
  }
}

onMounted(async () => {
  syncLocalProfile()

  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const [config, badge, donations] = await Promise.all([
        fundingService.getFundingConfig(),
        fundingService.getSupporterBadge(user.id),
        fundingService.getDonationHistory(user.id),
      ])
      supporterBadge.value = badge
      supporterDonations.value = donations
      if (config?.enabled && config.funding_links) {
        fundingLinks.value = config.funding_links
      }
    }
  } finally {
    supporterLoading.value = false
  }
})
</script>

<style scoped>
.user-account-settings {
  max-width: 600px;
}

.settings-header {
  margin-bottom: 32px;
}

.settings-title {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.settings-section {
  margin-bottom: 32px;
  padding: 24px;
  background-color: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
}

.profile-preview {
  position: relative;
  border-radius: 8px;
  overflow: hidden;
  background-color: var(--background-secondary);
}

.profile-banner {
  height: 120px;
  background: linear-gradient(135deg, var(--color) 0%, var(--color) 100%);
  position: relative;
  cursor: pointer;
  transition: all 0.2s ease;
}

.profile-banner:hover {
  filter: brightness(0.9);
}

.banner-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s ease;
  color: #ffffff;
  font-size: 12px;
  font-weight: 500;
}

.profile-banner:hover .banner-overlay {
  opacity: 1;
}

.banner-loading-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #ffffff;
  font-size: 12px;
  font-weight: 500;
  z-index: 1;
}

.banner-spinner {
  width: 24px;
  height: 24px;
  border: 3px solid rgba(255, 255, 255, 0.3);
  border-top-color: #ffffff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.profile-info {
  display: flex;
  align-items: flex-end;
  padding: 16px 20px 20px;
  margin-top: -32px;
  position: relative;
}

.avatar-wrapper {
  margin-right: 16px;
}

.user-info {
  flex: 1;
}

.display-name {
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 4px 0;
}

.username {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.form-group {
  margin-bottom: 20px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-label {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.form-input,
.form-textarea {
  width: 100%;
  padding: 12px;
  background-color: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  transition: border-color 0.15s ease;
}

.form-input:focus,
.form-textarea:focus {
  outline: none;
  border-color: #0EA5E9;
}

.form-input:disabled,
.form-input[readonly] {
  opacity: 0.6;
  cursor: not-allowed;
  background-color: var(--background-tertiary);
}

.form-textarea {
  resize: vertical;
  min-height: 80px;
}

.form-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 8px;
}

.color-picker-container {
  position: relative;
}

.color-preview-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* Composite field: swatch inside the same chrome as form-input */
.color-hex-field {
  display: flex;
  align-items: stretch;
  flex: 1;
  max-width: 200px;
  height: 38px;
  box-sizing: border-box;
  background-color: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 4px;
  overflow: hidden;
  transition: border-color 0.15s ease;
}

.color-hex-field:focus-within {
  border-color: var(--harmony-primary, #0EA5E9);
}

.color-hex-swatch {
  width: 36px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-right: 1px solid var(--input-border);
  cursor: pointer;
  transition: filter 0.15s ease;
}

.color-hex-swatch:hover {
  filter: brightness(1.08);
}

.color-hex-input {
  flex: 1;
  min-width: 0;
  width: auto;
  max-width: none;
  height: 100%;
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 0 10px;
  font-size: 13px;
  line-height: 1;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.color-hex-input:focus {
  outline: none;
  border-color: transparent;
}

.color-reset-btn {
  flex-shrink: 0;
  height: 38px;
  box-sizing: border-box;
  padding: 0 14px;
  font-size: 13px;
}

.color-picker-popover {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 1000;
  margin-top: 8px;
  background-color: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 16px 0;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid var(--background-quaternary);
}

.info-row:last-child {
  border-bottom: none;
}

.info-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
}

.info-value {
  font-size: 14px;
  color: var(--text-primary);
}

.display-name-input-wrapper {
  position: relative;
}

.display-name-input-wrapper code {
  background: var(--background-secondary);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
}

.settings-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 24px;
}

.btn {
  padding: 8px 16px;
  border-radius: 4px;
  border: none;
  font-weight: 500;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary {
  background-color: var(--harmony-primary);
  color: var(--text-on-primary, #ffffff);
}

.btn-primary:hover:not(:disabled) {
  background-color: #0284C7;
}

.btn-secondary {
  background-color: transparent;
  color: var(--text-secondary);
  border: 1px solid #4f545c;
}

.btn-secondary:hover:not(:disabled) {
  background-color: var(--background-quaternary);
  color: var(--text-primary);
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top: 2px solid #ffffff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .settings-section {
    padding: 16px;
  }
  
  .profile-info {
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 20px;
  }
  
  .avatar-wrapper {
    margin-right: 0;
    margin-bottom: 12px;
  }

  .color-preview-row {
    flex-wrap: wrap;
  }

  .color-hex-field {
    max-width: none;
    min-width: 0;
  }
}

/* Supporter section */
.supporter-section {
  border-top: 1px solid var(--border-color);
  padding-top: 24px;
}

/* ===== Profile fields editor =====
   Renders one row per name/value pair with a remove button, plus an "Add
   field" button beneath the list. Layout uses CSS grid for the inputs so
   the label column stays narrow on desktop and stacks vertically on mobile. */
.profile-fields-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}

.profile-field-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
}

.profile-field-inputs {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(0, 2fr);
  gap: 8px;
}

.profile-field-name {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 12px;
  font-weight: 600;
}

.profile-field-value {
  font-size: 13px;
}

.profile-field-remove {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  background: transparent;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.profile-field-remove:hover {
  background: rgba(237, 66, 69, 0.12);
  color: #ed4245;
  border-color: rgba(237, 66, 69, 0.35);
}

.profile-fields-empty {
  margin: 0 0 12px;
  padding: 12px;
  font-size: 13px;
  color: var(--text-muted, #949ba4);
  background: rgba(255, 255, 255, 0.03);
  border: 1px dashed var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 6px;
  text-align: center;
}

.profile-field-add {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  background: transparent;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.profile-field-add:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.04);
  border-color: var(--harmony-primary, #0EA5E9);
}

.profile-field-add:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.profile-field-count {
  margin-left: 4px;
  font-size: 11px;
  color: var(--text-muted, #949ba4);
  font-weight: 400;
}

/* On narrow viewports stack label-on-top-of-value so the inputs aren't
   crammed side-by-side. The remove button stays vertically centered to
   the right of the stacked pair. */
@media (max-width: 540px) {
  .profile-field-inputs {
    grid-template-columns: 1fr;
    gap: 6px;
  }
}

.section-description {
  font-size: 13px;
  color: var(--text-secondary);
  margin: -4px 0 16px;
  line-height: 1.5;
}

.donor-handle-callout {
  padding: 14px 16px;
  margin-bottom: 16px;
  background: rgba(14, 165, 233, 0.06);
  border: 1px solid rgba(14, 165, 233, 0.22);
  border-radius: 10px;
}

.donor-handle-callout-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 700;
  color: var(--harmony-primary, #0EA5E9);
  text-transform: none;
  letter-spacing: 0;
}

.donor-handle-callout p {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.donor-handle-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 6px 0 10px;
  flex-wrap: wrap;
}

.donor-handle-token {
  display: inline-block;
  padding: 6px 10px;
  background: var(--background-primary);
  border: 1px dashed var(--harmony-primary, #0EA5E9);
  border-radius: 6px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 13px;
  font-weight: 600;
  color: var(--harmony-primary, #0EA5E9);
  user-select: all;
  word-break: break-all;
}

.donor-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
  padding: 4px 10px;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.donor-copy-btn:hover {
  border-color: var(--harmony-primary, #0EA5E9);
  color: var(--harmony-primary, #0EA5E9);
}

.donor-handle-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-tertiary, var(--text-secondary));
  font-style: italic;
  line-height: 1.5;
}

.donor-examples {
  margin: 6px 0 10px;
  font-size: 12px;
}

.donor-examples summary {
  cursor: pointer;
  color: var(--text-secondary);
  font-weight: 500;
  padding: 4px 0;
  user-select: none;
  transition: color 0.15s;
}

.donor-examples summary:hover {
  color: var(--text-primary);
}

.donor-examples-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.donor-examples-list li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  background: var(--background-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
}

.donor-examples-list code {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
  color: var(--text-primary);
  word-break: break-all;
}

.donor-examples-list .example-note {
  font-size: 11px;
  color: var(--text-tertiary, var(--text-secondary));
  font-style: italic;
}

.supporter-loading {
  color: var(--text-secondary);
  font-size: 13px;
}

.supporter-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: var(--background-secondary);
  border-radius: 8px;
  margin-bottom: 12px;
}

.supporter-inactive {
  opacity: 0.6;
}

.supporter-badge-preview {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 6px;
  border-radius: 4px;
  font-size: 14px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  line-height: 1;
  background: rgba(255, 255, 255, 0.05);
}

.supporter-details {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.supporter-tier {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
}

.supporter-active {
  font-size: 12px;
  color: #57f287;
  font-weight: 600;
}

.supporter-inactive-text {
  font-size: 14px;
  color: var(--text-secondary);
}

.supporter-donations {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}

.supporter-donation-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  background: var(--background-secondary);
  border-radius: 6px;
  font-size: 13px;
}

.donation-amt {
  font-weight: 600;
  color: var(--text-primary);
}

.donation-dt, .donation-plat {
  color: var(--text-secondary);
}

.supporter-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.supporter-link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  border-radius: 6px;
  text-decoration: none;
  font-size: 13px;
  font-weight: 600;
  transition: border-color 0.15s, background 0.15s;
}

.supporter-link:hover {
  border-color: var(--harmony-primary, #0EA5E9);
  background: var(--background-modifier-hover, var(--background-secondary));
}
</style>