<template>
  <article class="welcome-screen" :aria-labelledby="titleId">
    <div class="ws-banner" :class="{ 'has-image': !!bannerUrl }" :style="bannerStyle" aria-hidden="true"></div>

    <button
      v-if="closable"
      type="button"
      class="ws-close"
      :aria-label="$t('serverWelcome.close')"
      @click="emit('close')"
    >
      <Icon name="x" :size="18" />
    </button>

    <header class="ws-identity">
      <ServerIcon
        class="ws-icon"
        :src="server.icon"
        :alt="server.name"
        size="xl"
        shape="big-rounded"
        :show-title="false"
      />
      <p class="ws-kicker">{{ $t('serverWelcome.kicker') }}</p>
      <h2 :id="titleId" class="ws-title">{{ server.name }}</h2>
    </header>

    <div class="ws-body">
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="renderedMessage" class="ws-message" v-html="renderedMessage"></div>

      <section v-if="rules.length > 0" class="ws-rules" :aria-labelledby="`${titleId}-rules`">
        <h3 :id="`${titleId}-rules`" class="ws-rules-heading">{{ $t('serverWelcome.rulesHeading') }}</h3>
        <ol class="ws-rule-list">
          <li v-for="(rule, index) in rules" :key="index" class="ws-rule">
            <span class="ws-rule-number" aria-hidden="true">{{ index + 1 }}</span>
            <div class="ws-rule-text">
              <p class="ws-rule-title">{{ rule.title }}</p>
              <p v-if="rule.description" class="ws-rule-description">{{ rule.description }}</p>
            </div>
          </li>
        </ol>
      </section>

      <p v-if="!renderedMessage && rules.length === 0" class="ws-empty">{{ $t('serverWelcome.empty') }}</p>
    </div>

    <footer v-if="action !== 'none'" class="ws-footer">
      <p v-if="action === 'accept'" class="ws-note">{{ $t('serverWelcome.acceptNote') }}</p>
      <p v-else-if="acceptedAt" class="ws-note">
        <Icon name="check-circle" :size="14" />
        {{ $t('serverWelcome.acceptedOn', { date: formattedAcceptedAt }) }}
      </p>
      <p v-if="error" class="ws-error" role="alert">{{ error }}</p>
      <button
        type="button"
        class="btn btn-primary ws-action"
        :disabled="busy"
        data-testid="welcome-screen-action"
        @click="action === 'accept' ? emit('accept') : emit('close')"
      >
        {{ action === 'accept'
          ? (busy ? $t('serverWelcome.accepting') : $t('serverWelcome.acceptRules'))
          : $t('serverWelcome.gotIt') }}
      </button>
    </footer>
  </article>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import Icon from '@/components/common/Icon.vue'
import ServerIcon from '@/components/common/ServerIcon.vue'
import { getServerBannerUrl } from '@/utils/serverUtils'
import { withRenderFallback } from '@/utils/renderFallback'
import { renderWelcomeMessage } from '@/utils/welcomeMessage'
import type { WelcomeRule } from '@/services/ServerWelcomeService'

interface Props {
  server: { name: string; icon?: string | null; banner?: string | null }
  message: string
  rules: WelcomeRule[]
  /** accept: the member must accept; ok: a "Got it" button; none: no footer. */
  action?: 'accept' | 'ok' | 'none'
  acceptedAt?: string | null
  busy?: boolean
  error?: string | null
  closable?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  action: 'ok',
  acceptedAt: null,
  busy: false,
  error: null,
  closable: true,
})

const emit = defineEmits<{
  accept: []
  close: []
}>()

const titleId = `ws-${useId()}`

const renderedMessage = computed(() => renderWelcomeMessage(props.message.trim()))

const bannerUrl = computed(() => withRenderFallback(getServerBannerUrl(props.server.banner, { width: 1080, height: 300 })))
const bannerStyle = computed(() => (bannerUrl.value ? { backgroundImage: `url("${bannerUrl.value}")` } : {}))

const formattedAcceptedAt = computed(() => {
  if (!props.acceptedAt) return ''
  const date = new Date(props.acceptedAt)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { dateStyle: 'medium' })
})
</script>

<style scoped>
.welcome-screen {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  color: var(--text-primary);
}

.ws-banner {
  flex-shrink: 0;
  height: 112px;
  background:
    linear-gradient(135deg,
      color-mix(in srgb, var(--harmony-primary) 55%, transparent),
      color-mix(in srgb, var(--harmony-primary) 15%, var(--background-tertiary)));
  background-size: cover;
  background-position: center;
}

.ws-banner.has-image {
  height: 136px;
}

.ws-close {
  position: absolute;
  top: var(--space-3);
  right: var(--space-3);
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-full);
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  cursor: pointer;
}

.ws-close:hover {
  background: rgba(0, 0, 0, 0.65);
}

.ws-close:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.ws-identity {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 0 var(--space-6);
  margin-top: -40px;
}

.ws-icon {
  border: 4px solid var(--background-quinary, var(--background-primary));
  border-radius: 22px;
  background: var(--background-quinary, var(--background-primary));
}

.ws-kicker {
  margin: var(--space-3) 0 0;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.ws-title {
  margin: var(--space-1) 0 0;
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-bold);
  line-height: var(--line-height-tight);
  overflow-wrap: anywhere;
}

.ws-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-5) var(--space-6) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.ws-message {
  font-size: var(--font-size-sm);
  line-height: var(--line-height-relaxed);
  color: var(--text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.ws-message :deep(a) {
  color: var(--text-link, var(--harmony-primary));
}

.ws-message :deep(.md-code),
.ws-message :deep(.md-code-block) {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.9em;
  background: var(--background-tertiary);
  border-radius: var(--radius-sm);
  padding: 1px 4px;
}

.ws-message :deep(.md-code-block) {
  display: block;
  padding: var(--space-2) var(--space-3);
  white-space: pre-wrap;
}

.ws-message :deep(blockquote) {
  margin: 0;
  padding-left: var(--space-3);
  border-left: 3px solid var(--border-primary);
  color: var(--text-secondary);
}

.ws-rules-heading {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.ws-rule-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.ws-rule {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--background-secondary);
}

.ws-rule + .ws-rule {
  border-top: 1px solid var(--border-primary);
}

.ws-rule-number {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  background: color-mix(in srgb, var(--harmony-primary) 18%, transparent);
  color: var(--harmony-primary);
}

.ws-rule-text {
  min-width: 0;
}

.ws-rule-title {
  margin: 2px 0 0;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  overflow-wrap: anywhere;
}

.ws-rule-description {
  margin: var(--space-1) 0 0;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.ws-empty {
  margin: 0;
  text-align: center;
  font-size: var(--font-size-sm);
  color: var(--text-muted);
}

.ws-footer {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-6) var(--space-5);
  border-top: 1px solid var(--border-primary);
}

.ws-note {
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.ws-error {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--error);
}

.ws-action {
  width: 100%;
  justify-content: center;
  min-height: 44px;
}

@media (max-width: 480px) {
  .ws-identity,
  .ws-body,
  .ws-footer {
    padding-left: var(--space-4);
    padding-right: var(--space-4);
  }

  .ws-footer {
    padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom));
  }
}
</style>

<style>
/* Unscoped: BaseModal teleports to body. Pass overlay-class="server-welcome-overlay" to BaseModal.
   Specificity exceeds BaseModal's scoped rules. */
.modal-overlay.server-welcome-overlay .modal-container {
  max-width: 520px;
}

.modal-overlay.server-welcome-overlay .modal-container .modal-content {
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

@media (max-width: 480px) {
  .modal-overlay.server-welcome-overlay {
    padding: 0;
    align-items: flex-end;
  }

  .modal-overlay.server-welcome-overlay .modal-container {
    max-width: none;
    max-height: 100dvh;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  }
}
</style>
