<template>
  <BaseModal
    :show="show"
    title="Before you join"
    subtitle="Read and agree to the rules before joining"
    icon="shield-check"
    :compact="true"
    @close="$emit('close')"
  >
    <div class="rules-modal-content">
      <section v-if="instanceRules.length > 0" class="rules-section">
        <h4 class="rules-heading">{{ instanceName }} instance rules</h4>
        <ol class="rules-list">
          <li v-for="(rule, index) in instanceRules" :key="`i-${index}`" class="rules-item">
            {{ rule }}
          </li>
        </ol>
        <p class="rules-note">Shown once — these apply everywhere on this instance.</p>
      </section>

      <section v-if="serverRules.length > 0" class="rules-section">
        <h4 class="rules-heading">{{ serverName }} rules</h4>
        <ol class="rules-list">
          <li v-for="(rule, index) in serverRules" :key="`s-${index}`" class="rules-item">
            {{ rule }}
          </li>
        </ol>
      </section>
    </div>

    <template #footer>
      <div class="rules-footer">
        <button class="rules-btn secondary" type="button" @click="$emit('close')">
          Back
        </button>
        <span class="rules-agreement-note">By joining, you agree to these rules.</span>
        <button class="rules-btn primary" type="button" :disabled="joining" @click="$emit('agree')">
          {{ joining ? 'Joining…' : 'Agree and join' }}
        </button>
      </div>
    </template>
  </BaseModal>
</template>

<script setup lang="ts">
import BaseModal from '@/components/common/BaseModal.vue'

defineProps<{
  show: boolean
  serverName: string
  serverRules: string[]
  instanceRules: string[]
  instanceName: string
  joining?: boolean
}>()

defineEmits<{
  close: []
  agree: []
}>()
</script>

<style scoped>
.rules-modal-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.rules-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rules-heading {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.rules-list {
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: rule;
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
}

.rules-item {
  counter-increment: rule;
  display: flex;
  gap: 12px;
  padding: 12px 16px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.rules-item::before {
  content: counter(rule) ".";
  flex-shrink: 0;
  color: var(--text-muted);
  font-weight: 600;
}

.rules-item + .rules-item {
  border-top: 1px solid var(--border-secondary);
}

.rules-note {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}

.rules-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.rules-agreement-note {
  flex: 1;
  text-align: right;
  font-size: 12px;
  color: var(--text-muted);
}

.rules-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 10px 18px;
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.rules-btn.secondary {
  background: var(--background-modifier-hover);
  border: 1px solid var(--border-primary);
  color: var(--text-secondary);
}

.rules-btn.secondary:hover {
  background: var(--background-modifier-active);
  color: var(--text-primary);
}

.rules-btn.primary {
  background: var(--harmony-primary);
  color: var(--text-on-primary);
}

.rules-btn.primary:hover:not(:disabled) {
  background: var(--harmony-primary-hover);
}

.rules-btn.primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
