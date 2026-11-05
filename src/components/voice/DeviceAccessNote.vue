<!-- Under a device select whose devices are unnamed (no capture permission yet): why, a button
     that asks for access, and the refusal when there is one. `id` names the text, for the
     select's aria-describedby. -->
<template>
  <div class="device-access">
    <div class="device-access__row">
      <small :id="id" class="device-access__text">{{ text }}</small>
      <button type="button" class="device-access__btn" :disabled="busy" @click="emit('allow')">{{ action }}</button>
    </div>
    <p v-if="problem" class="device-access__problem" role="alert">{{ problem }}</p>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  id: string;
  text: string;
  action: string;
  busy?: boolean;
  problem?: string | null;
}>();

const emit = defineEmits<{ (e: 'allow'): void }>();
</script>

<style scoped>
.device-access {
  margin-top: 8px;
}

.device-access__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.device-access__text {
  flex: 1 1 200px;
  min-width: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.device-access__btn {
  flex: none;
  max-width: 100%;
  padding: 6px 12px;
  border: 1px solid var(--harmony-primary);
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.device-access__btn:hover:not(:disabled) {
  background: var(--harmony-primary-alpha);
}

.device-access__btn:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.device-access__btn:disabled {
  cursor: progress;
  opacity: 0.6;
}

.device-access__problem {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-danger);
}
</style>
