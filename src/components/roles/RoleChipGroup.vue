<template>
  <div class="role-chip-group" role="group" :aria-label="label">
    <button
      v-for="role in roles"
      :key="role.id"
      type="button"
      role="switch"
      class="role-chip"
      :class="{ held: held.has(role.id), busy: pending.has(role.id) }"
      :style="{ '--role-color': role.color || 'var(--text-secondary)' }"
      :aria-checked="held.has(role.id)"
      :aria-busy="pending.has(role.id) || undefined"
      :disabled="disabled"
      :data-testid="`role-chip-${role.id}`"
      @click="emit('toggle', role.id)"
    >
      <span class="role-chip-mark" aria-hidden="true">
        <Icon v-if="held.has(role.id)" name="check" :size="12" />
      </span>
      <span class="role-chip-text">
        <span class="role-chip-name">{{ role.name }}</span>
        <span v-if="role.self_assign_note" class="role-chip-note">{{ role.self_assign_note }}</span>
      </span>
    </button>
  </div>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'
import type { ServerRole } from '@/services/RoleService'

defineProps<{
  roles: ServerRole[]
  held: Set<string>
  pending: Set<string>
  label: string
  disabled?: boolean
}>()

const emit = defineEmits<{ toggle: [roleId: string] }>()
</script>

<style scoped>
.role-chip-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.role-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  min-height: 36px;
  padding: 6px 14px 6px 8px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--role-color) 45%, var(--border-primary));
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
}

.role-chip:hover:not(:disabled) {
  background: color-mix(in srgb, var(--role-color) 10%, var(--bg-secondary));
}

.role-chip:active:not(:disabled) {
  transform: scale(0.97);
}

.role-chip:focus-visible {
  outline: 2px solid var(--accent-primary, var(--role-color));
  outline-offset: 2px;
}

.role-chip.held {
  background: color-mix(in srgb, var(--role-color) 20%, var(--bg-secondary));
  border-color: var(--role-color);
}

.role-chip.busy {
  opacity: 0.7;
  cursor: progress;
}

.role-chip:disabled {
  cursor: default;
  opacity: 0.6;
}

.role-chip-mark {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid var(--role-color);
  color: var(--bg-primary);
}

.role-chip.held .role-chip-mark {
  background: var(--role-color);
}

.role-chip-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.role-chip-name {
  font-weight: 600;
  font-size: var(--font-size-sm, 14px);
  overflow-wrap: anywhere;
}

.role-chip-note {
  font-size: var(--font-size-xs, 12px);
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

@media (prefers-reduced-motion: reduce) {
  .role-chip {
    transition: none;
  }
  .role-chip:active:not(:disabled) {
    transform: none;
  }
}
</style>
