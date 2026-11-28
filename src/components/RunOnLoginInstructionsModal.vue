<template>
  <Transition name="run-on-login-modal">
    <div v-if="modelValue" class="modal-overlay" @click="close">
      <div class="modal-content" @click.stop role="dialog" aria-labelledby="run-on-login-title">
        <button class="close-x" :aria-label="t('common.close')" @click="close">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
          </svg>
        </button>

        <div class="modal-header">
          <div class="header-icon">
            <svg viewBox="0 0 24 24" width="28" height="28">
              <path fill="currentColor" d="M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4M11,16.5L6.5,12L7.91,10.59L11,13.67L16.59,8.09L18,9.5L11,16.5Z"/>
            </svg>
          </div>
          <div>
            <h3 id="run-on-login-title" class="modal-title">{{ t('runOnLogin.modal.title') }}</h3>
            <p class="modal-subtitle">
              {{ t('runOnLogin.modal.subtitle', { browser: browserLabel }) }}
            </p>
          </div>
        </div>

        <ol class="steps">
          <li>
            <span class="step-num">1</span>
            <div class="step-body">
              <p class="step-title">{{ t('runOnLogin.modal.step1') }}</p>
              <div class="step-detail">
                <div class="url-pill">
                  <code>{{ runOnLoginUrl }}</code>
                  <button class="copy-btn" :class="{ copied }" @click="copyUrl">
                    <svg v-if="!copied" viewBox="0 0 24 24" width="16" height="16">
                      <path fill="currentColor" d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z"/>
                    </svg>
                    <svg v-else viewBox="0 0 24 24" width="16" height="16">
                      <path fill="currentColor" d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z"/>
                    </svg>
                    <span>{{ copied ? t('common.copied') : t('common.copy') }}</span>
                  </button>
                </div>
                <p class="step-hint">
                  {{ t('runOnLogin.modal.step1Hint') }}
                </p>
              </div>
            </div>
          </li>

          <li>
            <span class="step-num">2</span>
            <div class="step-body">
              <i18n-t keypath="runOnLogin.modal.step2" tag="p" class="step-title" scope="global">
                <template #option><em>{{ t('runOnLogin.modal.menuStartApp') }}</em></template>
              </i18n-t>
              <div class="menu-mock" aria-hidden="true">
                <div class="menu-mock-header">
                  <img src="/img/app_icon_square.webp" alt="" class="menu-icon" />
                  <span>Harmony</span>
                </div>
                <ul class="menu-mock-items">
                  <li>{{ t('runOnLogin.modal.menuOpen') }}</li>
                  <li>{{ t('runOnLogin.modal.menuOpenWindow') }}</li>
                  <li class="highlight">
                    <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z"/></svg>
                    <span>{{ t('runOnLogin.modal.menuStartApp') }}</span>
                  </li>
                  <li>{{ t('runOnLogin.modal.menuShortcuts') }}</li>
                  <li class="danger">{{ t('runOnLogin.modal.menuRemove', { browser: browserLabel }) }}</li>
                </ul>
              </div>
            </div>
          </li>

          <li>
            <span class="step-num">3</span>
            <div class="step-body">
              <p class="step-title">{{ t('runOnLogin.modal.step3') }}</p>
            </div>
          </li>
        </ol>

        <i18n-t keypath="runOnLogin.modal.footnote" tag="div" class="footnote" scope="global">
          <template #browser>{{ browserLabel }}</template>
          <template #url><code>{{ runOnLoginUrl }}</code></template>
        </i18n-t>

        <div class="modal-actions">
          <button class="btn btn-secondary" @click="close">{{ t('common.close') }}</button>
          <button class="btn btn-primary" @click="markEnabled">{{ t('runOnLogin.modal.enabled') }}</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'
import { getChromiumBrowserLabel, getRunOnLoginUrl } from '@/utils/pwaUtils'
import { useT } from '@/composables/useT'

interface Props {
  modelValue: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'enabled'): void
}>()

const toast = useToast()
const { t } = useT()

const runOnLoginUrl = computed(() => getRunOnLoginUrl())
const browserLabel = computed(() => getChromiumBrowserLabel())

const copied = ref(false)
let copyResetTimer: ReturnType<typeof setTimeout> | null = null

const copyUrl = async () => {
  const url = runOnLoginUrl.value
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url)
    } else {
      // Fallback for older browsers / non-secure contexts
      const textarea = document.createElement('textarea')
      textarea.value = url
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    copied.value = true
    if (copyResetTimer) clearTimeout(copyResetTimer)
    copyResetTimer = setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch (error) {
    debug.warn('Failed to copy run-on-login URL:', error)
    toast.error(t('runOnLogin.modal.copyFailed', { url }))
  }
}

const markEnabled = () => {
  localStorage.setItem('harmony-run-on-login-enabled', 'true')
  localStorage.setItem('harmony-run-on-login-enabled-at', Date.now().toString())
  toast.success(t('runOnLogin.modal.saved'))
  emit('enabled')
  emit('update:modelValue', false)
}

const close = () => {
  emit('update:modelValue', false)
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open && copyResetTimer) {
      clearTimeout(copyResetTimer)
      copyResetTimer = null
      copied.value = false
    }
  },
)
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  z-index: 10001;
  backdrop-filter: blur(2px);
}

.modal-content {
  position: relative;
  background: var(--background-secondary);
  border: 1px solid var(--background-quaternary);
  border-radius: var(--radius-lg);
  padding: 24px;
  max-width: 520px;
  width: 100%;
  max-height: calc(92 * var(--app-vh));
  overflow-y: auto;
  box-shadow: var(--shadow-modal);
  color: var(--text-primary);
}

.close-x {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 32px;
  height: 32px;
  border: none;
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.close-x:hover {
  background: var(--background-modifier-active);
  color: var(--text-primary);
}

.modal-header {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  margin-bottom: 20px;
  padding-right: 28px;
}

.header-icon {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--harmony-primary) 15%, transparent);
  color: var(--text-link);
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-title {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 700;
}

.modal-subtitle {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.45;
}

.steps {
  list-style: none;
  padding: 0;
  margin: 0 0 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.steps > li {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.step-num {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  margin-top: 1px;
}

.step-body {
  flex: 1;
  min-width: 0;
}

.step-title {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}

.step-title em {
  font-style: normal;
  background: color-mix(in srgb, var(--harmony-primary) 18%, transparent);
  color: var(--text-primary);
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 700;
}

.step-detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.step-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.45;
}

.url-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--background-modifier-hover);
  border: 1px solid var(--background-quaternary);
  border-radius: var(--radius-md);
  padding: 4px 4px 4px 12px;
  width: fit-content;
  max-width: 100%;
}

.url-pill code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
  border: none;
  border-radius: var(--radius-base);
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease;
}

.copy-btn:hover {
  background: var(--harmony-primary-fill-hover);
}

.copy-btn.copied {
  background: var(--success);
}

.menu-mock {
  margin-top: 4px;
  background: var(--background-floating);
  border: 1px solid var(--background-quaternary);
  border-radius: var(--radius-md);
  overflow: hidden;
  width: fit-content;
  max-width: 100%;
}

.menu-mock-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--background-modifier-hover);
  border-bottom: 1px solid var(--background-quaternary);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.menu-icon {
  width: 18px;
  height: 18px;
  border-radius: 4px;
}

.menu-mock-items {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  font-size: 13px;
}

.menu-mock-items li {
  padding: 6px 14px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 8px;
}

.menu-mock-items li.highlight {
  background: color-mix(in srgb, var(--harmony-primary) 18%, transparent);
  color: var(--text-primary);
  font-weight: 600;
  position: relative;
}

.menu-mock-items li.highlight svg {
  color: var(--text-success);
}

.menu-mock-items li.danger {
  color: var(--text-danger);
}

.footnote {
  margin: 8px 0 18px;
  padding: 10px 12px;
  background: var(--background-modifier-hover);
  border-left: 3px solid var(--harmony-primary);
  border-radius: 0 6px 6px 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}

.footnote code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--text-secondary);
}

.modal-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.btn {
  padding: 9px 18px;
  border-radius: 6px;
  border: none;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.btn-secondary {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-hover);
}

.btn-secondary:hover {
  background: var(--background-quaternary);
  color: var(--text-primary);
}

.btn-primary {
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
}

.btn-primary:hover {
  background: var(--harmony-primary-fill-hover);
}

.run-on-login-modal-enter-active,
.run-on-login-modal-leave-active {
  transition: opacity 0.2s ease;
}

.run-on-login-modal-enter-active .modal-content,
.run-on-login-modal-leave-active .modal-content {
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease;
}

.run-on-login-modal-enter-from,
.run-on-login-modal-leave-to {
  opacity: 0;
}

.run-on-login-modal-enter-from .modal-content,
.run-on-login-modal-leave-to .modal-content {
  transform: scale(0.95) translateY(8px);
  opacity: 0;
}

@media (max-width: 480px) {
  .modal-content {
    padding: 20px;
  }

  .modal-header {
    flex-direction: column;
    gap: 10px;
    padding-right: 20px;
  }

  .modal-actions {
    flex-direction: column-reverse;
  }

  .btn {
    width: 100%;
  }
}
</style>
