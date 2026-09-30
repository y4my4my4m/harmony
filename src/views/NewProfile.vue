<template>
  <main class="new-profile-page">
    <form
      class="profile-card"
      data-testid="new-profile-card"
      novalidate
      :aria-busy="isCreatingProfile"
      @submit.prevent="createProfile"
    >
      <header class="np-header">
        <img :src="instanceIcon" alt="" class="instance-icon" width="40" height="40" />
        <h1 class="np-title">{{ $t('onboarding.title') }}</h1>
        <p class="np-subtitle">{{ $t('onboarding.subtitle', { instance: instanceName }) }}</p>
      </header>

      <div class="avatar-row">
        <button
          type="button"
          class="avatar-picker"
          :aria-label="avatarPreview ? $t('onboarding.changeAvatar') : $t('onboarding.addAvatar')"
          @click="triggerAvatarUpload"
        >
          <img v-if="avatarPreview" :src="avatarPreview" alt="" />
          <Icon v-else name="user" :size="28" />
          <span class="avatar-badge" aria-hidden="true"><Icon name="camera" :size="14" /></span>
        </button>
        <div class="avatar-copy">
          <span class="field-label">{{ $t('onboarding.avatarLabel') }}</span>
          <span class="field-hint">{{ $t('onboarding.avatarHint') }}</span>
          <button
            v-if="avatarPreview"
            type="button"
            class="link-btn"
            data-testid="avatar-use-default"
            @click="useDefaultAvatar"
          >
            {{ $t('onboarding.removeAvatar') }}
          </button>
        </div>
        <input
          ref="avatarInput"
          type="file"
          accept="image/*"
          class="visually-hidden"
          tabindex="-1"
          aria-hidden="true"
          @change="handleAvatarUpload"
        />
      </div>

      <div class="field">
        <label class="field-label" for="np-display-name">{{ $t('onboarding.displayName') }}</label>
        <input
          id="np-display-name"
          v-model="displayName"
          type="text"
          class="text-input"
          :class="{ invalid: showDisplayNameError }"
          maxlength="50"
          autocomplete="name"
          :aria-invalid="showDisplayNameError"
          aria-describedby="np-display-name-hint"
          data-testid="profile-display-name"
          @blur="displayNameTouched = true"
        />
        <p id="np-display-name-hint" class="field-hint" :class="{ error: showDisplayNameError }">
          {{ showDisplayNameError ? displayNameError : $t('onboarding.displayNameHint') }}
        </p>
      </div>

      <div class="field">
        <label class="field-label" for="np-username">{{ $t('onboarding.username') }}</label>
        <div class="username-input" :class="{ invalid: !!usernameError }">
          <span class="affix" aria-hidden="true">@</span>
          <input
            id="np-username"
            :value="username"
            type="text"
            maxlength="24"
            autocomplete="username"
            autocapitalize="none"
            spellcheck="false"
            :aria-invalid="!!usernameError"
            aria-describedby="np-username-status"
            data-testid="profile-username"
            @input="formatUsername"
          />
        </div>
        <p id="np-username-status" class="field-hint" aria-live="polite">
          <span v-if="usernameError" class="error">{{ usernameError }}</span>
          <span v-else-if="checkingUsername">{{ $t('onboarding.usernameChecking') }}</span>
          <span v-else-if="usernameAvailable" class="success" data-testid="username-available">
            <Icon name="check" :size="14" /> {{ $t('onboarding.usernameAvailable', { handle: fullHandle }) }}
          </span>
          <span v-else>{{ $t('onboarding.usernameHint') }}</span>
        </p>
      </div>

      <div class="field">
        <label class="field-label" for="np-bio">
          {{ $t('onboarding.bio') }} <span class="optional">{{ $t('onboarding.optional') }}</span>
        </label>
        <textarea
          id="np-bio"
          v-model="bio"
          class="text-input"
          rows="3"
          maxlength="500"
          data-testid="profile-bio"
        ></textarea>
      </div>

      <p v-if="formError" class="np-error" role="alert">
        <Icon name="alert-circle" :size="16" />
        <span>{{ formError }}</span>
      </p>

      <button
        type="submit"
        class="btn btn-primary submit-btn"
        :disabled="!canSubmit"
        data-testid="profile-submit"
      >
        <span v-if="isCreatingProfile" class="np-spinner" aria-hidden="true"></span>
        {{ isCreatingProfile ? $t('onboarding.creating') : $t('onboarding.submit') }}
      </button>

      <p class="signed-in-as">
        {{ $t('onboarding.signedInAs', { email: accountEmail }) }}
        <button type="button" class="link-btn" @click="signOut">{{ $t('onboarding.signOut') }}</button>
      </p>
    </form>
  </main>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useToast } from 'vue-toastification';
import { apiUrl } from '@/services/instanceConfig';
import { debug } from '@/utils/debug';
import { useProfileStore } from '@/stores/useProfile';
import { useAuthStore } from '@/stores/auth';
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings';
import { uploadAvatar, downloadAndUploadImage } from '@/utils/fileUpload';
import { consumePostAuthRedirect } from '@/utils/postAuthRedirect';
import { normalizeUsernameInput, USERNAME_MIN_LENGTH } from '@/utils/usernameRules';
import { supabase } from '@/supabase';
import Icon from '@/components/common/Icon.vue';

const DEFAULT_PROFILE_COLOR = '#0EA5E9';
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

const { t } = useI18n();
const router = useRouter();
const toast = useToast();
const profileStore = useProfileStore();
const authStore = useAuthStore();
const instanceSettings = useInstanceSettingsStore();

const username = ref('');
const displayName = ref('');
const bio = ref('');
const avatarFile = ref<File | null>(null);
const avatarPreview = ref<string | null>(null);
const avatarInput = ref<HTMLInputElement>();

const displayNameTouched = ref(false);
const usernameError = ref('');
const usernameAvailable = ref(false);
const checkingUsername = ref(false);
const isCreatingProfile = ref(false);
const formError = ref('');
const instanceDomain = ref<string | null>(null);

let usernameCheckTimeout: ReturnType<typeof setTimeout> | null = null;
let usernameCheckSeq = 0;

const instanceName = computed(() => instanceSettings.settings.instanceName || 'Harmony');
const instanceIcon = computed(() => instanceSettings.settings.instanceIcon || '/img/app_icon_square.webp');
const accountEmail = computed(() => authStore.session?.user?.email ?? '');
const fullHandle = computed(() =>
  instanceDomain.value ? `@${username.value}@${instanceDomain.value}` : `@${username.value}`
);

const displayNameError = computed(() => {
  const name = displayName.value.trim();
  if (!name) return t('onboarding.displayNameRequired');
  if (name.length > 50) return t('onboarding.displayNameTooLong');
  return '';
});
const showDisplayNameError = computed(() => displayNameTouched.value && !!displayNameError.value);

const canSubmit = computed(() =>
  !isCreatingProfile.value &&
  !displayNameError.value &&
  usernameAvailable.value &&
  !checkingUsername.value &&
  !usernameError.value
);

async function loadInstanceDomain(): Promise<string | null> {
  const { data, error } = await supabase
    .from('instance_config')
    .select('config_value')
    .eq('config_key', 'domain')
    .maybeSingle();
  if (error || data?.config_value == null) return null;
  const raw = typeof data.config_value === 'string' ? data.config_value : String(data.config_value);
  return raw.replace(/"/g, '').trim() || null;
}

onMounted(async () => {
  const user = authStore.session?.user;
  if (!user) return;

  // A profile created by an earlier attempt whose response was lost.
  try {
    await profileStore.fetchProfileByAuthUserId(user.id);
    if (profileStore.profile?.username) {
      await router.replace(consumePostAuthRedirect('/chat'));
      return;
    }
  } catch {
    /* fall through to the form */
  }

  instanceDomain.value = await loadInstanceDomain();
  prefillFromOAuth(user.user_metadata || {}, user.identities || [], user.email);
});

function prefillFromOAuth(
  metadata: Record<string, any>,
  identities: Array<{ provider: string }>,
  email?: string,
) {
  const oauth = identities.some(i => ['google', 'github', 'twitch'].includes(i.provider));

  if (oauth) {
    avatarPreview.value = metadata.avatar_url || metadata.picture || null;
    displayName.value = metadata.full_name || metadata.name || metadata.preferred_username || '';
    if (metadata.bio || metadata.description) {
      bio.value = String(metadata.bio || metadata.description).substring(0, 500);
    }
  }

  const suggested = normalizeUsernameInput(
    metadata.preferred_username || metadata.user_name || metadata.username || metadata.login ||
    (email ? email.split('@')[0] : '')
  );
  if (suggested.length >= USERNAME_MIN_LENGTH) setUsername(suggested);
}

function triggerAvatarUpload() {
  avatarInput.value?.click();
}

function handleAvatarUpload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > AVATAR_MAX_BYTES) {
    toast.error(t('onboarding.avatarTooLarge'));
    return;
  }
  avatarFile.value = file;
  const reader = new FileReader();
  reader.onload = e => { avatarPreview.value = e.target?.result as string; };
  reader.readAsDataURL(file);
}

function useDefaultAvatar() {
  avatarFile.value = null;
  avatarPreview.value = null;
  if (avatarInput.value) avatarInput.value.value = '';
}

function formatUsername(event: Event) {
  const input = event.target as HTMLInputElement;
  const value = normalizeUsernameInput(input.value);
  if (input.value !== value) input.value = value;
  setUsername(value);
}

function setUsername(value: string) {
  username.value = value;
  usernameAvailable.value = false;
  formError.value = '';
  if (usernameCheckTimeout) clearTimeout(usernameCheckTimeout);

  if (value.length === 0) {
    usernameError.value = '';
    checkingUsername.value = false;
    return;
  }
  if (value.length < USERNAME_MIN_LENGTH) {
    usernameError.value = t('onboarding.usernameTooShort', { min: USERNAME_MIN_LENGTH });
    checkingUsername.value = false;
    return;
  }

  usernameError.value = '';
  checkingUsername.value = true;
  usernameCheckTimeout = setTimeout(() => checkUsernameAvailability(value), 400);
}

async function checkUsernameAvailability(candidate: string) {
  const seq = ++usernameCheckSeq;
  // Uniqueness is (username, domain): a cached remote account with the same
  // name does not block a local one.
  let query = supabase.from('profiles').select('id').eq('username', candidate).eq('is_local', true);
  if (instanceDomain.value) query = query.eq('domain', instanceDomain.value);
  const { data, error } = await query.limit(1);

  if (seq !== usernameCheckSeq) return;
  checkingUsername.value = false;

  if (error) {
    debug.error('Username availability check failed:', error);
    usernameError.value = t('onboarding.usernameCheckFailed');
    return;
  }
  if (data && data.length > 0) {
    usernameError.value = t('onboarding.usernameTaken');
    return;
  }
  usernameAvailable.value = true;
}

async function signOut() {
  await authStore.logout();
}

function isUniqueViolation(error: any): boolean {
  return error?.code === '23505' || error?.details?.code === '23505' ||
    /duplicate key|already exists/i.test(String(error?.message ?? ''));
}

async function createProfile() {
  displayNameTouched.value = true;
  if (!canSubmit.value) return;

  const user = authStore.session?.user;
  if (!user) {
    formError.value = t('onboarding.sessionExpired');
    return;
  }

  isCreatingProfile.value = true;
  formError.value = '';

  try {
    const domain = instanceDomain.value ?? await loadInstanceDomain();
    if (!domain) {
      // The domain is baked into federated_id and the inbox/outbox URLs; a
      // placeholder would be permanent.
      formError.value = t('onboarding.instanceUnavailable');
      return;
    }
    instanceDomain.value = domain;

    const handle = username.value;
    const actor = `https://${domain}/users/${handle}`;
    const profileData = {
      id: user.id,
      auth_user_id: user.id,
      username: handle,
      display_name: displayName.value.trim(),
      bio: bio.value.trim() || undefined,
      color: DEFAULT_PROFILE_COLOR,
      is_local: true,
      domain,
      federated_id: actor,
      inbox_url: `${actor}/inbox`,
      outbox_url: `${actor}/outbox`,
      followers_url: `${actor}/followers`,
      following_url: `${actor}/following`,
    };
    const created = await profileStore.createProfile(profileData);

    await finishSetup(user.id, created);
    await router.replace(consumePostAuthRedirect('/chat'));
  } catch (error: any) {
    debug.error('Profile creation failed:', error);

    if (isUniqueViolation(error)) {
      // Either the username was claimed meanwhile, or an earlier attempt
      // already created this account's profile.
      await profileStore.fetchProfileByAuthUserId(user.id);
      if (profileStore.profile?.username) {
        await router.replace(consumePostAuthRedirect('/chat'));
        return;
      }
      usernameAvailable.value = false;
      usernameError.value = t('onboarding.usernameTaken');
      document.getElementById('np-username')?.focus();
      return;
    }

    formError.value = t('onboarding.createFailed');
  } finally {
    isCreatingProfile.value = false;
  }
}

/** Post-insert steps. None of them block entry to the app. */
async function finishSetup(userId: string, created: unknown) {
  const problems: string[] = [];

  try {
    const res = await fetch(apiUrl('/api/federation/generate-keys'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId }),
    });
    if (!res.ok) debug.warn('Federation key generation deferred:', res.status);
  } catch (err) {
    // The actor endpoint generates keys on first request.
    debug.warn('Federation key generation deferred:', err);
  }

  if (created && (avatarFile.value || avatarPreview.value)) {
    try {
      const result = avatarFile.value
        ? await uploadAvatar(avatarFile.value, userId)
        : await downloadAndUploadImage(avatarPreview.value!, userId, 'avatar');
      if (result.success && result.url) {
        const { normalizeAvatarForStorage } = await import('@/utils/avatarUtils');
        await profileStore.updateProfile({ avatar_url: normalizeAvatarForStorage(result.url) || result.url });
      } else {
        problems.push(t('onboarding.avatarFailed'));
      }
    } catch (err) {
      debug.error('Avatar upload failed:', err);
      problems.push(t('onboarding.avatarFailed'));
    }
  }

  try {
    const { useUserData } = await import('@/composables/useUserData');
    const userData = useUserData();
    await userData.fetchUserProfile(userId, true);
    await userData.initialize(userId, username.value, avatarFile.value ? undefined : '/default_avatar.webp');
    await userData.updateCurrentUserProfile({
      displayName: displayName.value.trim(),
      bio: bio.value.trim() || undefined,
      color: DEFAULT_PROFILE_COLOR,
    });
  } catch (err) {
    debug.warn('User data refresh after profile creation failed:', err);
  }

  if (problems.length > 0) toast.warning(problems.join(' '));
}
</script>

<style scoped>
.new-profile-page {
  min-height: 100vh;
  min-height: 100dvh;
  width: 100%;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: var(--space-12) var(--space-4) var(--space-8);
  background: var(--background-tertiary);
  box-sizing: border-box;
  overflow-y: auto;
}

.profile-card {
  width: 100%;
  max-width: 440px;
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-8);
  background: var(--background-primary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  box-sizing: border-box;
}

.np-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--space-2);
}

.instance-icon {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  object-fit: cover;
  margin-bottom: var(--space-2);
}

.np-title {
  margin: 0;
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.np-subtitle {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.avatar-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.avatar-picker {
  position: relative;
  flex-shrink: 0;
  width: 72px;
  height: 72px;
  padding: 0;
  border-radius: 50%;
  border: 1px dashed var(--border-hover, var(--border-primary));
  background: var(--background-secondary);
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.avatar-picker img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}

.avatar-picker:hover {
  background: var(--background-modifier-hover);
}

.avatar-badge {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--harmony-primary);
  color: var(--text-on-primary, #fff);
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--background-primary);
}

.avatar-copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.field-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.optional {
  font-weight: var(--font-weight-normal);
  color: var(--text-muted);
}

.field-hint {
  margin: 0;
  min-height: 1.25em;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.field-hint .error,
.field-hint.error {
  color: var(--error);
}

.field-hint .success {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--success);
}

.text-input,
.username-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--input-bg, var(--background-secondary));
  border: 1px solid var(--input-border, var(--border-primary));
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: var(--font-size-base);
}

.text-input {
  padding: 10px 12px;
  font-family: inherit;
  resize: vertical;
}

.username-input {
  display: flex;
  align-items: center;
  padding: 0 12px;
}

.username-input input {
  flex: 1;
  min-width: 0;
  padding: 10px 0 10px 2px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
}

.affix {
  color: var(--text-muted);
}

.text-input:focus,
.username-input:focus-within {
  outline: none;
  border-color: var(--harmony-primary);
  box-shadow: 0 0 0 1px var(--harmony-primary);
}

.username-input input:focus {
  outline: none;
}

.text-input.invalid,
.username-input.invalid {
  border-color: var(--error);
}

.np-error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--error) 12%, transparent);
  color: var(--error);
  font-size: var(--font-size-sm);
}

.submit-btn {
  width: 100%;
  min-height: 44px;
  justify-content: center;
  gap: var(--space-2);
}

.np-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: np-spin 0.8s linear infinite;
}

@keyframes np-spin {
  to { transform: rotate(360deg); }
}

.signed-in-as {
  margin: 0;
  text-align: center;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.link-btn {
  padding: 0;
  border: none;
  background: none;
  color: var(--harmony-primary);
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.link-btn:hover {
  text-decoration: underline;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@media (max-width: 480px) {
  .new-profile-page {
    padding: var(--space-6) 0 0;
    background: var(--background-primary);
  }

  .profile-card {
    max-width: none;
    border: none;
    border-radius: 0;
    padding: var(--space-6) var(--space-4) calc(var(--space-6) + env(safe-area-inset-bottom));
  }
}

@media (prefers-reduced-motion: reduce) {
  .np-spinner {
    animation-duration: 2.4s;
  }
}
</style>
