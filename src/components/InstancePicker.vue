<template>
  <div class="instance-picker">
    <div class="instance-picker__card">
      <img src="/icon_3d.webp" alt="" class="instance-picker__logo" />
      <h1>Welcome to Harmony</h1>
      <p class="instance-picker__hint">
        Harmony is federated — anyone can run an instance. Enter the domain of
        the instance you want to connect to.
      </p>

      <form @submit.prevent="connect">
        <div class="instance-picker__field">
          <span class="instance-picker__scheme" aria-hidden="true">https://</span>
          <input
            v-model="domain"
            type="text"
            inputmode="url"
            placeholder="harmony.example.com"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            :disabled="busy"
            autofocus
          />
        </div>
        <button type="submit" :disabled="busy || !domain.trim()">
          {{ busy ? 'Connecting…' : 'Connect' }}
        </button>
      </form>

      <p v-if="error" class="instance-picker__error">{{ error }}</p>
      <p v-if="current" class="instance-picker__current">
        Currently connected to <strong>{{ current.name }}</strong>
        <button class="instance-picker__link" @click="cancel">Keep it</button>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import {
  fetchInstanceInfo,
  getStoredInstance,
  setStoredInstance,
} from '@/services/instanceConfig';

const emit = defineEmits<{ (e: 'close'): void }>();

const current = getStoredInstance();
const domain = ref(current ? new URL(current.origin).hostname : '');
const busy = ref(false);
const error = ref('');

async function connect() {
  busy.value = true;
  error.value = '';
  try {
    const info = await fetchInstanceInfo(domain.value);
    setStoredInstance(info);
    // full reload: supabase.ts reads the instance config at module init
    window.location.reload();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not reach that instance';
    busy.value = false;
  }
}

function cancel() {
  emit('close');
}
</script>

<style scoped>
.instance-picker {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #16161e;
  color: #e6e6ef;
}

.instance-picker__card {
  width: min(420px, 90vw);
  padding: 2rem;
  border-radius: 12px;
  background: #1f1f2b;
  border: 1px solid #33334a;
  text-align: center;
}

.instance-picker__logo {
  width: 56px;
  height: 56px;
  margin-bottom: 0.75rem;
}

.instance-picker__card h1 {
  margin: 0 0 0.5rem;
  font-size: 1.4rem;
}

.instance-picker__hint {
  font-size: 0.9rem;
  opacity: 0.75;
  margin-bottom: 1.25rem;
}

.instance-picker__card form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.instance-picker__field {
  display: flex;
  align-items: center;
  border-radius: 8px;
  border: 1px solid #3c3c55;
  background: #14141c;
  overflow: hidden;
}

.instance-picker__field:focus-within {
  border-color: #6d6df0;
}

.instance-picker__scheme {
  padding-left: 0.9rem;
  color: rgba(255, 255, 255, 0.35);
  font-size: 1rem;
  user-select: none;
  flex-shrink: 0;
}

.instance-picker__card input {
  flex: 1;
  min-width: 0;
  padding: 0.7rem 0.9rem 0.7rem 0.15rem;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 1rem;
}

.instance-picker__card input:focus {
  outline: none;
}

.instance-picker__card button[type='submit'] {
  padding: 0.7rem;
  border-radius: 8px;
  border: none;
  background: #5865f2;
  color: white;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
}

.instance-picker__card button[type='submit']:disabled {
  opacity: 0.5;
  cursor: default;
}

.instance-picker__error {
  margin-top: 1rem;
  color: #f47070;
  font-size: 0.9rem;
}

.instance-picker__current {
  margin-top: 1.25rem;
  font-size: 0.85rem;
  opacity: 0.8;
}

.instance-picker__link {
  background: none;
  border: none;
  color: #8ab4ff;
  cursor: pointer;
  font-size: 0.85rem;
  text-decoration: underline;
  margin-left: 0.4rem;
}
</style>
