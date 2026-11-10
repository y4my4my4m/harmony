<template>
  <div class="signup-captcha" data-testid="signup-captcha">
    <p :id="noteId" class="signup-captcha__note">{{ note }}</p>
    <iframe
      ref="frame"
      class="signup-captcha__frame"
      data-testid="signup-captcha-frame"
      :src="src"
      :title="t('auth.captcha.frameTitle')"
      :aria-describedby="noteId"
      :style="{ height: `${height}px` }"
      referrerpolicy="strict-origin-when-cross-origin"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * The sign-up check: the widget page (public/embed-player.html?captcha=…) framed from the instance's
 * web origin. Emits the widget's token; `reset` asks for a new one after the hook refused one.
 */
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  captchaFrameSrc,
  captchaPageOrigin,
  readCaptchaEvent,
  type SignupCaptchaConfig,
} from '@/utils/signupCaptcha'

/** `note` replaces the sign-up texts above the widget (the admin test). */
const props = defineProps<{ config: SignupCaptchaConfig; refused?: boolean; note?: string }>()
const emit = defineEmits<{ token: [token: string]; expired: []; error: [code: string] }>()

const { t, locale } = useI18n()
const noteId = `signup-captcha-${useId()}`
const frame = ref<HTMLIFrameElement | null>(null)
const height = ref(props.config.provider === 'turnstile' ? 72 : 84)
const failed = ref('')

const origin = captchaPageOrigin()
const dark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
const src = captchaFrameSrc(props.config, { theme: dark ? 'dark' : 'light', lang: String(locale.value || '') })

const note = computed(() => {
  if (props.note) return props.note
  if (failed.value) return t('auth.captcha.unavailable')
  return props.refused ? t('auth.captcha.refused') : t('auth.captcha.asked')
})

function onMessage(event: MessageEvent) {
  const e = readCaptchaEvent(event, frame.value?.contentWindow, origin)
  if (!e) return
  if (e.ev === 'captcha') {
    failed.value = ''
    emit('token', e.token)
  } else if (e.ev === 'captcha-expired') {
    emit('expired')
  } else if (e.ev === 'captcha-error') {
    failed.value = e.message || 'error'
    emit('error', failed.value)
  } else if (e.ev === 'captcha-size') {
    height.value = e.height
  } else if (e.ev === 'captcha-ready') {
    failed.value = ''
  }
}

function reset() {
  frame.value?.contentWindow?.postMessage({ harmonyPlayer: 1, cmd: 'captcha-reset' }, origin)
}

defineExpose({ reset })

onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => window.removeEventListener('message', onMessage))
</script>

<style scoped>
.signup-captcha {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 4px 0 12px;
}

.signup-captcha__note {
  margin: 0;
  font-size: 0.875rem;
  color: var(--text-secondary, inherit);
}

.signup-captcha__frame {
  width: 100%;
  border: 0;
  background: transparent;
  color-scheme: normal;
}
</style>
