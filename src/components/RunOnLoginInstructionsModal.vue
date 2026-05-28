<template>
  <Transition name="run-on-login-modal">
    <div v-if="modelValue" class="modal-overlay" @click="close">
      <div class="modal-content" @click.stop role="dialog" aria-labelledby="run-on-login-title">
        <button class="close-x" aria-label="Close" @click="close">
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
            <h3 id="run-on-login-title" class="modal-title">Start Harmony when you sign in</h3>
            <p class="modal-subtitle">
              {{ browserLabel }} can launch Harmony automatically every time you log into your computer.
            </p>
          </div>
        </div>

        <ol class="steps">
          <li>
            <span class="step-num">1</span>
            <div class="step-body">
              <p class="step-title">Open the apps page</p>
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
                    <span>{{ copied ? 'Copied' : 'Copy' }}</span>
                  </button>
                </div>
                <p class="step-hint">
                  Paste it into a new browser tab. The link can't be opened directly from inside the app for security reasons.
                </p>
              </div>
            </div>
          </li>

          <li>
            <span class="step-num">2</span>
            <div class="step-body">
              <p class="step-title">Right-click Harmony, then choose <em>Start app when you sign in</em></p>
              <div class="menu-mock" aria-hidden="true">
                <div class="menu-mock-header">
                  <img src="/img/app_icon_square.webp" alt="" class="menu-icon" />
                  <span>Harmony</span>
                </div>
                <ul class="menu-mock-items">
                  <li>Open</li>
                  <li>Open in window</li>
                  <li class="highlight">
                    <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z"/></svg>
                    <span>Start app when you sign in</span>
                  </li>
                  <li>Create shortcuts...</li>
                  <li class="danger">Remove from {{ browserLabel }}</li>
                </ul>
              </div>
            </div>
          </li>

          <li>
            <span class="step-num">3</span>
            <div class="step-body">
              <p class="step-title">That's it - Harmony will launch the next time you sign in to your computer.</p>
            </div>
          </li>
        </ol>

        <div class="footnote">
          Available in {{ browserLabel }} 91+ on Windows, macOS, Linux and ChromeOS.
          You can change it any time from <code>{{ runOnLoginUrl }}</code>.
        </div>

        <div class="modal-actions">
          <button class="btn btn-secondary" @click="close">Close</button>
          <button class="btn btn-primary" @click="markEnabled">I enabled it</button>
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

interface Props {
  modelValue: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'enabled'): void
}>()

const toast = useToast()

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
    toast.error(`Couldn't copy. Type ${url} into a new browser tab.`)
  }
}

const markEnabled = () => {
  localStorage.setItem('harmony-run-on-login-enabled', 'true')
  localStorage.setItem('harmony-run-on-login-enabled-at', Date.now().toString())
  toast.success('Saved. Harmony will start when you sign in.')
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
  background: var(--h-chat, #2b2d31);
  border: 1px solid var(--h-chat-light, #3f4147);
  border-radius: 14px;
  padding: 24px;
  max-width: 520px;
  width: 100%;
  max-height: 92vh;
  overflow-y: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
  color: var(--text-primary, #fff);
}

.close-x {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 32px;
  height: 32px;
  border: none;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-secondary, #b9bbbe);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.close-x:hover {
  background: rgba(255, 255, 255, 0.12);
  color: var(--text-primary, #fff);
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
  border-radius: 12px;
  background: linear-gradient(135deg, #0EA5E9, #0284C7);
  color: #fff;
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
  color: var(--text-secondary, #b9bbbe);
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
  background: var(--harmony-primary, #5865f2);
  color: #fff;
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
  background: rgba(88, 101, 242, 0.18);
  color: var(--text-primary, #fff);
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
  color: var(--text-muted, #80848e);
  line-height: 1.45;
}

.url-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--h-chat-light, #3f4147);
  border-radius: 8px;
  padding: 4px 4px 4px 12px;
  width: fit-content;
  max-width: 100%;
}

.url-pill code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  color: var(--text-primary, #fff);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--harmony-primary, #5865f2);
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.15s ease;
}

.copy-btn:hover {
  background: #4752c4;
}

.copy-btn.copied {
  background: #3ba55d;
}

.menu-mock {
  margin-top: 4px;
  background: #1e1f22;
  border: 1px solid var(--h-chat-light, #3f4147);
  border-radius: 8px;
  overflow: hidden;
  width: fit-content;
  max-width: 100%;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
}

.menu-mock-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.04);
  border-bottom: 1px solid var(--h-chat-light, #3f4147);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, #b9bbbe);
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
  color: var(--text-secondary, #b9bbbe);
  display: flex;
  align-items: center;
  gap: 8px;
}

.menu-mock-items li.highlight {
  background: rgba(88, 101, 242, 0.18);
  color: var(--text-primary, #fff);
  font-weight: 600;
  position: relative;
}

.menu-mock-items li.highlight svg {
  color: #3ba55d;
}

.menu-mock-items li.danger {
  color: #ed4245;
}

.footnote {
  margin: 8px 0 18px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.03);
  border-left: 3px solid var(--harmony-primary, #5865f2);
  border-radius: 0 6px 6px 0;
  font-size: 12px;
  color: var(--text-muted, #80848e);
  line-height: 1.5;
}

.footnote code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--text-secondary, #b9bbbe);
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
  transition: background 0.15s ease, color 0.15s ease, transform 0.15s ease;
}

.btn-secondary {
  background: transparent;
  color: var(--text-secondary, #b9bbbe);
  border: 1px solid #4f545c;
}

.btn-secondary:hover {
  background: var(--h-chat-light, #3f4147);
  color: var(--text-primary, #fff);
}

.btn-primary {
  background: var(--harmony-primary, #5865f2);
  color: #fff;
}

.btn-primary:hover {
  background: #4752c4;
  transform: translateY(-1px);
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
