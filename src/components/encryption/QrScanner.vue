<template>
  <div class="qr-scanner">
    <div v-if="state === 'scanning'" class="qs-live">
      <div class="qs-viewport">
        <video ref="videoRef" class="qs-video" autoplay playsinline muted data-testid="qr-scanner-video"></video>
        <div class="qs-frame" aria-hidden="true"></div>
      </div>
      <p class="qs-hint">{{ hint }}</p>
      <button type="button" class="btn btn-secondary btn-sm" @click="stopCamera">Stop camera</button>
    </div>

    <div v-else class="qs-idle">
      <Icon :name="problem ? 'camera-off' : 'camera'" :size="28" class="qs-idle-icon" />
      <p v-if="problemText" class="qs-problem" role="status">{{ problemText }}</p>
      <p v-else class="qs-hint">{{ hint }}</p>
      <button
        v-if="canTryCamera"
        type="button"
        class="btn btn-primary btn-sm"
        :disabled="state === 'starting'"
        data-testid="qr-scanner-start"
        @click="startCamera"
      >
        {{ state === 'starting' ? 'Starting camera…' : problem === 'denied' ? 'Try the camera again' : 'Use camera' }}
      </button>
    </div>

    <div class="qs-alternatives">
      <label class="btn btn-secondary btn-sm qs-file">
        <Icon name="image" :size="14" />
        {{ decodingFile ? 'Reading image…' : 'Scan from an image' }}
        <input
          type="file"
          accept="image/*"
          class="qs-file-input"
          data-testid="qr-scanner-file"
          :disabled="decodingFile"
          @change="onFile"
        />
      </label>
      <p v-if="fileError" class="qs-problem" role="status">{{ fileError }}</p>
    </div>

    <div v-if="allowPaste" class="qs-paste">
      <label :for="pasteId">{{ pasteLabel }}</label>
      <textarea :id="pasteId" v-model="pasted" rows="2" spellcheck="false" placeholder="Paste the code here"></textarea>
      <button type="button" class="btn btn-secondary btn-sm" :disabled="!pasted.trim()" @click="submitPasted">
        Use pasted code
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import Icon from '@/components/common/Icon.vue'
import {
  VideoQrDecoder,
  cameraPrecheck,
  classifyCameraError,
  decodeQrFromImageFile,
  hasVideoInput,
  openQrCamera,
  type CameraProblem,
} from '@/utils/qrCode'

const props = withDefaults(defineProps<{
  hint?: string
  autoStart?: boolean
  allowPaste?: boolean
  pasteLabel?: string
}>(), {
  hint: 'Point the camera at the QR code.',
  autoStart: false,
  allowPaste: true,
  pasteLabel: 'Or paste the code',
})

const emit = defineEmits<{ decoded: [text: string] }>()

const state = ref<'idle' | 'starting' | 'scanning'>('idle')
const problem = ref<CameraProblem | null>(cameraPrecheck())
const fileError = ref('')
const decodingFile = ref(false)
const pasted = ref('')
const videoRef = ref<HTMLVideoElement | null>(null)
const pasteId = `qs-paste-${Math.random().toString(36).slice(2, 8)}`

let stream: MediaStream | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let decoder: VideoQrDecoder | null = null
let alive = true

const canTryCamera = computed(() => !problem.value || problem.value === 'denied' || problem.value === 'in-use' || problem.value === 'failed')

const problemText = computed(() => {
  switch (problem.value) {
    case 'unsupported':
      return 'This app has no camera access here. Scan from an image or paste the code instead.'
    case 'insecure':
      return 'The camera needs a secure (https) connection. Scan from an image or paste the code instead.'
    case 'denied':
      return 'Camera access is blocked. Allow it in your browser or system settings, or scan from an image.'
    case 'no-camera':
      return 'No camera found. Scan from an image or paste the code instead.'
    case 'in-use':
      return 'The camera is in use by another app. Close it and try again, or scan from an image.'
    case 'failed':
      return 'The camera could not start. Scan from an image or paste the code instead.'
    default:
      return ''
  }
})

function deliver(text: string) {
  stopCamera()
  emit('decoded', text.trim())
}

async function startCamera() {
  if (state.value !== 'idle') return
  const pre = cameraPrecheck()
  if (pre) {
    problem.value = pre
    return
  }
  state.value = 'starting'
  if ((await hasVideoInput()) === false) {
    problem.value = 'no-camera'
    state.value = 'idle'
    return
  }
  try {
    stream = await openQrCamera()
  } catch (err) {
    problem.value = classifyCameraError(err)
    state.value = 'idle'
    return
  }
  if (!alive) {
    stopCamera()
    return
  }
  problem.value = null
  state.value = 'scanning'
  await nextTick()
  const video = videoRef.value
  if (!video) {
    stopCamera()
    return
  }
  video.srcObject = stream
  try {
    await video.play()
  } catch { /* autoplay with muted video is allowed; frames still arrive */ }
  decoder = new VideoQrDecoder()
  scheduleScan(0)
}

function scheduleScan(delay: number) {
  timer = setTimeout(async () => {
    timer = null
    const video = videoRef.value
    if (state.value !== 'scanning' || !video || !decoder) return
    const text = await decoder.decode(video).catch(() => null)
    if (text) deliver(text)
    else if (state.value === 'scanning') scheduleScan(120)
  }, delay)
}

function stopCamera() {
  if (timer) clearTimeout(timer)
  timer = null
  stream?.getTracks().forEach(t => t.stop())
  stream = null
  if (videoRef.value) videoRef.value.srcObject = null
  if (state.value !== 'idle') state.value = 'idle'
}

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  fileError.value = ''
  decodingFile.value = true
  try {
    const text = await decodeQrFromImageFile(file)
    if (text) deliver(text)
    else fileError.value = 'No QR code found in that image. Try a sharper, closer picture.'
  } catch {
    fileError.value = 'That file could not be read as an image.'
  } finally {
    decodingFile.value = false
  }
}

function submitPasted() {
  const text = pasted.value.trim()
  if (!text) return
  pasted.value = ''
  deliver(text)
}

onMounted(() => {
  if (props.autoStart && !problem.value) void startCamera()
})

onUnmounted(() => {
  alive = false
  stopCamera()
})

defineExpose({ startCamera, stopCamera })
</script>

<style scoped>
.qr-scanner {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.qs-live,
.qs-idle {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
}

.qs-idle {
  padding: 24px 16px;
  background: var(--bg-secondary);
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-lg);
}

.qs-idle-icon {
  color: var(--text-secondary);
}

.qs-viewport {
  position: relative;
  width: 100%;
  max-width: 300px;
  aspect-ratio: 1;
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: #000;
}

.qs-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.qs-frame {
  position: absolute;
  inset: 14%;
  border: 2px solid color-mix(in srgb, #fff 80%, transparent);
  border-radius: var(--radius-md);
  box-shadow: 0 0 0 999px color-mix(in srgb, #000 35%, transparent);
}

.qs-hint,
.qs-problem {
  margin: 0;
  font-size: var(--font-size-sm);
  line-height: 1.45;
}

.qs-hint {
  color: var(--text-secondary);
}

.qs-problem {
  color: var(--warning);
}

.qs-alternatives {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.qs-file {
  position: relative;
  overflow: hidden;
}

.qs-file-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.qs-paste {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.qs-paste label {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.qs-paste textarea {
  width: 100%;
  padding: 8px 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-family: 'JetBrains Mono', monospace;
  font-size: var(--font-size-xs);
  resize: vertical;
}

.qs-paste textarea:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.qs-paste .btn {
  align-self: flex-start;
}
</style>
