<template>
  <section class="no-servers" aria-labelledby="no-servers-title">
    <div class="panel">
      <header class="panel-header">
        <h1 id="no-servers-title" class="panel-title">{{ $t('emptyServers.title') }}</h1>
        <p class="panel-subtitle">{{ $t('emptyServers.subtitle', { instance: instanceName }) }}</p>
      </header>

      <form class="invite-form" @submit.prevent="joinWithInvite">
        <label class="field-label" for="invite-input">{{ $t('emptyServers.inviteLabel') }}</label>
        <div class="invite-row">
          <input
            id="invite-input"
            v-model="inviteValue"
            type="text"
            class="text-input"
            :placeholder="$t('emptyServers.invitePlaceholder')"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            :aria-invalid="!!inviteError"
            aria-describedby="invite-hint"
          />
          <button type="submit" class="btn btn-primary" :disabled="!inviteValue.trim()">
            {{ $t('emptyServers.join') }}
          </button>
        </div>
        <p id="invite-hint" class="field-hint" :class="{ error: !!inviteError }" aria-live="polite">
          {{ inviteError || $t('emptyServers.inviteHint') }}
        </p>
      </form>

      <div class="divider" role="presentation"><span>{{ $t('emptyServers.or') }}</span></div>

      <ul class="actions">
        <li>
          <button type="button" class="action" data-testid="empty-create-server" @click="showCreateServerForm = true">
            <span class="action-icon"><Icon name="plus" :size="20" /></span>
            <span class="action-text">
              <span class="action-title">{{ $t('emptyServers.createTitle') }}</span>
              <span class="action-desc">{{ $t('emptyServers.createDesc') }}</span>
            </span>
            <Icon name="chevron-right" :size="18" class="action-chevron" />
          </button>
        </li>
        <li>
          <button type="button" class="action" @click="emit('showPublicServers')">
            <span class="action-icon"><Icon name="compass" :size="20" /></span>
            <span class="action-text">
              <span class="action-title">{{ $t('emptyServers.browseTitle') }}</span>
              <span class="action-desc">{{ $t('emptyServers.browseDesc', { instance: instanceName }) }}</span>
            </span>
            <Icon name="chevron-right" :size="18" class="action-chevron" />
          </button>
        </li>
      </ul>

      <p class="secondary-links">
        <router-link to="/social/local">{{ $t('emptyServers.findPeople') }}</router-link>
        <span aria-hidden="true">·</span>
        <router-link to="/dm">{{ $t('emptyServers.messages') }}</router-link>
      </p>
    </div>

    <CreateServerForm v-if="showCreateServerForm" @close="showCreateServerForm = false" />
    <JoinFederatedServer
      v-if="remoteInviteUrl"
      :initial-url="remoteInviteUrl"
      @close="remoteInviteUrl = null"
    />
  </section>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import CreateServerForm from './CreateServer.vue';
import JoinFederatedServer from './JoinFederatedServer.vue';
import Icon from '@/components/common/Icon.vue';
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings';
import { parseInviteInput } from '@/utils/inviteInput';

const emit = defineEmits<{
  showPublicServers: []
}>();

const { t } = useI18n();
const router = useRouter();
const instanceSettings = useInstanceSettingsStore();

const showCreateServerForm = ref(false);
const remoteInviteUrl = ref<string | null>(null);
const inviteValue = ref('');
const inviteError = ref('');

const instanceName = computed(() => instanceSettings.settings.instanceName || 'Harmony');

watch(inviteValue, () => { inviteError.value = ''; });

function joinWithInvite() {
  const parsed = parseInviteInput(inviteValue.value, window.location.origin);
  if (parsed.kind === 'local') {
    router.push(`/invite/${encodeURIComponent(parsed.code)}`);
  } else if (parsed.kind === 'remote') {
    remoteInviteUrl.value = parsed.url;
  } else {
    inviteError.value = t('emptyServers.inviteInvalid');
  }
}
</script>

<style scoped>
.no-servers {
  flex: 1;
  width: 100%;
  min-height: 100%;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: var(--space-16) var(--space-4) var(--space-8);
  box-sizing: border-box;
  overflow-y: auto;
  background: var(--background-primary);
}

.panel {
  width: 100%;
  max-width: 480px;
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.panel-title {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.panel-subtitle {
  margin: 0;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
}

.invite-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.field-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.invite-row {
  display: flex;
  gap: var(--space-2);
}

.text-input {
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  background: var(--input-bg, var(--background-secondary));
  border: 1px solid var(--input-border, var(--border-primary));
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-base);
}

.text-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
  box-shadow: 0 0 0 1px var(--harmony-primary);
}

.field-hint {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.field-hint.error {
  color: var(--error);
}

.divider {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}

.divider::before,
.divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border-primary);
}

.actions {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.actions li + li {
  border-top: 1px solid var(--border-primary);
}

.action {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  border: none;
  background: var(--background-secondary);
  color: var(--text-primary);
  text-align: left;
  font: inherit;
  cursor: pointer;
}

.action:hover {
  background: var(--background-modifier-hover);
}

.action:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: -2px;
}

.action-icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--harmony-primary-alpha, var(--background-tertiary));
  color: var(--harmony-primary);
}

.action-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.action-title {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}

.action-desc {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.action-chevron {
  flex-shrink: 0;
  color: var(--text-muted);
}

.secondary-links {
  margin: 0;
  display: flex;
  justify-content: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--text-muted);
}

.secondary-links a {
  color: var(--harmony-primary);
  text-decoration: none;
}

.secondary-links a:hover {
  text-decoration: underline;
}

@media (max-width: 480px) {
  .no-servers {
    padding-top: var(--space-8);
  }

  .invite-row {
    flex-direction: column;
  }
}
</style>
