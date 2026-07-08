<template>
  <BaseModal
    :show="show"
    title="One last step!"
    subtitle="Read & agree to the rules before joining"
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
          {{ joining ? 'Joining…' : 'Agree & Join' }}
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
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
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
  border-top: 1px solid var(--border-primary, rgba(255, 255, 255, 0.06));
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
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.rules-btn.secondary {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: var(--text-secondary);
}

.rules-btn.secondary:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}

.rules-btn.primary {
  background: linear-gradient(135deg, var(--harmony-primary, #0ea5e9), var(--harmony-primary-hover, #0284c7));
  color: var(--text-primary);
}

.rules-btn.primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(14, 165, 233, 0.3);
}

.rules-btn.primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
