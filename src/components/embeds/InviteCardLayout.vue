<template>
  <article
    class="server-invite-card"
    :class="{ 'server-invite-card--loading': state === 'loading', 'server-invite-card--error': state === 'error' }"
    :aria-label="label"
    :aria-busy="state === 'loading' ? 'true' : undefined"
  >
    <div v-if="state === 'loading'" class="server-invite-card__skeleton" :aria-label="t('embeds.invite.loading')">
      <div class="skeleton-icon"></div>
      <div class="skeleton-content">
        <div class="skeleton-title"></div>
        <div class="skeleton-meta"></div>
      </div>
    </div>

    <div v-else-if="state === 'error'" class="server-invite-card__error">
      <Icon name="alert-triangle" :size="24" class="error-icon" />
      <div class="error-content">
        <span class="error-title">{{ errorTitle || t('embeds.invite.invalid') }}</span>
        <span v-if="errorMessage" class="error-message">{{ errorMessage }}</span>
      </div>
    </div>

    <template v-else>
      <div class="server-invite-card__icon">
        <img
          v-if="iconUrl && !iconFailed"
          :src="iconUrl"
          alt=""
          class="server-image"
          referrerpolicy="no-referrer"
          loading="lazy"
          decoding="async"
          @error="iconFailed = true"
        />
        <div v-else class="default-server-icon" aria-hidden="true">{{ initial }}</div>
      </div>

      <div class="server-invite-card__content">
        <h4 class="server-name">{{ name }}</h4>
        <div class="server-meta">
          <span v-if="onlineCount !== null" class="online-count">
            <span class="online-dot"></span>
            {{ t('embeds.invite.online', { count: onlineCount }) }}
          </span>
          <span v-if="memberCount !== null" class="member-count">
            <Icon name="users" :size="12" class="member-icon" />
            {{ t('embeds.invite.members', memberCount) }}
          </span>
        </div>
        <div v-if="description" class="server-description">{{ description }}</div>
      </div>

      <div class="server-invite-card__actions">
        <button v-if="action === 'join'" type="button" class="join-button" @click="emit('join')">
          {{ t('embeds.invite.join') }}
        </button>
        <button v-else-if="action === 'open'" type="button" class="joined-button" @click="emit('open')">
          {{ t('embeds.invite.open') }}
        </button>
        <div v-else class="joining-spinner" role="status">
          <span class="spinner"></span>
          {{ t('embeds.invite.joining') }}
        </div>
        <slot name="below-action" />
      </div>

      <slot />
    </template>
  </article>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'

const props = withDefaults(defineProps<{
  state: 'loading' | 'error' | 'ready'
  label?: string
  name?: string
  iconUrl?: string | null
  description?: string | null
  memberCount?: number | null
  onlineCount?: number | null
  errorTitle?: string
  errorMessage?: string | null
  action?: 'join' | 'open' | 'joining'
}>(), {
  label: undefined,
  name: '',
  iconUrl: null,
  description: null,
  memberCount: null,
  onlineCount: null,
  errorTitle: undefined,
  errorMessage: null,
  action: 'join',
})

const emit = defineEmits<{ join: []; open: [] }>()

const { t } = useI18n()

const iconFailed = ref(false)
watch(() => props.iconUrl, () => { iconFailed.value = false })

const initial = computed(() => Array.from(props.name.trim())[0]?.toUpperCase() || 'S')
</script>

<style scoped>
.server-invite-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: var(--background-secondary);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-primary);
  margin: 8px 0;
  max-width: 420px;
}

/* Icon */
.server-invite-card__icon {
  flex-shrink: 0;
}

.server-image {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-xl);
  object-fit: cover;
}

.default-server-icon {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-xl);
  background: var(--harmony-primary-fill);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  font-weight: 700;
  color: var(--text-on-primary);
}

/* Content */
.server-invite-card__content {
  flex: 1;
  min-width: 0;
}

.server-name {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.server-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 12px;
  margin-top: 4px;
  font-size: 13px;
  color: var(--text-secondary);
}

.online-count {
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.online-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--success);
}

.member-count {
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.server-description {
  margin-top: 6px;
  font-size: 13px;
  color: var(--text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

/* Actions: the button, and the row under it. */
.server-invite-card__actions {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.join-button {
  padding: 10px 20px;
  background: var(--success);
  color: var(--text-on-primary);
  border: none;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.2s ease;
}

.join-button:hover:not(:disabled) {
  background: var(--success-hover);
}

.join-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.joined-button {
  padding: 10px 20px;
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.joined-button:hover {
  background: var(--background-modifier-active);
  border-color: var(--border-hover);
}

.joining-spinner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  color: var(--text-secondary);
  font-size: 14px;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-top-color: var(--success);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Loading skeleton */
.server-invite-card--loading {
  pointer-events: none;
}

.server-invite-card__skeleton {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.skeleton-icon {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-xl);
}

.skeleton-content {
  flex: 1;
}

.skeleton-title {
  width: 140px;
  height: 18px;
  border-radius: 4px;
  margin-bottom: 8px;
}

.skeleton-meta {
  width: 100px;
  height: 14px;
  border-radius: 4px;
}

.skeleton-icon,
.skeleton-title,
.skeleton-meta {
  background-color: var(--background-quaternary);
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.04) 50%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.8s ease-in-out infinite;
}

@keyframes shimmer {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}

/* Error state */
.server-invite-card--error {
  border-color: color-mix(in srgb, var(--error) 30%, transparent);
  background: color-mix(in srgb, var(--error) 5%, var(--background-secondary));
}

.server-invite-card__error {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.error-icon {
  flex-shrink: 0;
  color: var(--text-danger);
}

.error-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.error-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-danger);
}

.error-message {
  font-size: 13px;
  color: var(--text-secondary);
}

@media (prefers-reduced-motion: reduce) {
  .spinner,
  .skeleton-icon,
  .skeleton-title,
  .skeleton-meta {
    animation: none;
  }
}

/* Phones: the actions take their own row under the details, the button its full width. */
@media (max-width: 520px) {
  .server-invite-card {
    flex-wrap: wrap;
  }

  .server-invite-card__actions {
    flex: 1 0 100%;
    align-items: stretch;
  }

  .join-button,
  .joined-button {
    width: 100%;
  }
}
</style>
