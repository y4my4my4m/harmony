import { ref, type Ref } from 'vue'
import { debug } from '@/utils/debug'

export interface VoiceRecordingState {
  isRecording: boolean
  isPaused: boolean
  duration: number
  waveformData: number[]
}

export interface VoiceRecordingResult {
  blob: Blob
  duration: number
  waveform: number[]
  mimeType: string
}

const WAVEFORM_SAMPLES = 64
const WAVEFORM_UPDATE_INTERVAL = 50
export const MAX_RECORDING_DURATION = 15 * 60 // 15 minutes in seconds

function getSupportedMimeType(): string {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ]
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return 'audio/webm'
}

export function useVoiceRecording() {
  const state: Ref<VoiceRecordingState> = ref({
    isRecording: false,
    isPaused: false,
    duration: 0,
    waveformData: [],
  })

  let mediaRecorder: MediaRecorder | null = null
  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let mediaStream: MediaStream | null = null
  let chunks: Blob[] = []
  let durationTimer: ReturnType<typeof setInterval> | null = null
  let waveformTimer: ReturnType<typeof setInterval> | null = null
  let startTime = 0
  let autoStopResolver: ((result: VoiceRecordingResult) => void) | null = null

  const liveWaveform = ref<number[]>(new Array(WAVEFORM_SAMPLES).fill(0))
  const allAmplitudes: number[] = []

  const startRecording = async (): Promise<void> => {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })

      audioContext = new AudioContext()
      const source = audioContext.createMediaStreamSource(mediaStream)
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.6
      source.connect(analyser)

      const mimeType = getSupportedMimeType()
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType })
      chunks = []
      allAmplitudes.length = 0

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }

      mediaRecorder.start(100)
      startTime = Date.now()

      state.value = {
        isRecording: true,
        isPaused: false,
        duration: 0,
        waveformData: [],
      }

      durationTimer = setInterval(() => {
        const elapsed = (Date.now() - startTime) / 1000
        state.value.duration = elapsed

        if (elapsed >= MAX_RECORDING_DURATION) {
          debug.log('Max recording duration reached, auto-stopping')
          autoStop()
        }
      }, 100)

      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      waveformTimer = setInterval(() => {
        if (!analyser) return
        analyser.getByteTimeDomainData(dataArray)

        let sum = 0
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / dataArray.length)
        const normalized = Math.min(1, rms * 3)
        allAmplitudes.push(normalized)

        const bars = new Array(WAVEFORM_SAMPLES)
        for (let i = 0; i < WAVEFORM_SAMPLES; i++) {
          const idx = Math.floor((i / WAVEFORM_SAMPLES) * dataArray.length)
          const v = Math.abs(dataArray[idx] - 128) / 128
          bars[i] = Math.max(0.05, v)
        }
        liveWaveform.value = bars
      }, WAVEFORM_UPDATE_INTERVAL)

      debug.log('Voice recording started')
    } catch (err) {
      debug.error('Failed to start recording:', err)
      cleanup()
      throw err
    }
  }

  const stopRecording = (): Promise<VoiceRecordingResult> => {
    return new Promise((resolve, reject) => {
      if (!mediaRecorder || mediaRecorder.state === 'inactive') {
        reject(new Error('No active recording'))
        return
      }

      mediaRecorder.onstop = () => {
        const duration = (Date.now() - startTime) / 1000
        const mimeType = mediaRecorder?.mimeType || 'audio/webm'
        const blob = new Blob(chunks, { type: mimeType })

        const waveform = downsampleWaveform(allAmplitudes, WAVEFORM_SAMPLES)

        cleanup()

        resolve({
          blob,
          duration,
          waveform,
          mimeType,
        })
      }

      mediaRecorder.stop()
    })
  }

  const autoStop = () => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return

    mediaRecorder.onstop = () => {
      const duration = (Date.now() - startTime) / 1000
      const mimeType = mediaRecorder?.mimeType || 'audio/webm'
      const blob = new Blob(chunks, { type: mimeType })
      const waveform = downsampleWaveform(allAmplitudes, WAVEFORM_SAMPLES)
      cleanup()

      const result: VoiceRecordingResult = { blob, duration, waveform, mimeType }
      if (autoStopResolver) {
        autoStopResolver(result)
        autoStopResolver = null
      }
    }

    mediaRecorder.stop()
  }

  const onAutoStop = (): Promise<VoiceRecordingResult> => {
    return new Promise((resolve) => {
      autoStopResolver = resolve
    })
  }

  const cancelRecording = () => {
    autoStopResolver = null
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.onstop = null
      mediaRecorder.stop()
    }
    cleanup()
    debug.log('Voice recording cancelled')
  }

  const cleanup = () => {
    if (durationTimer) clearInterval(durationTimer)
    if (waveformTimer) clearInterval(waveformTimer)
    durationTimer = null
    waveformTimer = null

    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop())
      mediaStream = null
    }

    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close().catch(() => {})
    }
    audioContext = null
    analyser = null
    mediaRecorder = null
    chunks = []
    allAmplitudes.length = 0
    liveWaveform.value = new Array(WAVEFORM_SAMPLES).fill(0)

    state.value = {
      isRecording: false,
      isPaused: false,
      duration: 0,
      waveformData: [],
    }
  }

  return {
    state,
    liveWaveform,
    maxDuration: MAX_RECORDING_DURATION,
    startRecording,
    stopRecording,
    cancelRecording,
    onAutoStop,
  }
}

function downsampleWaveform(amplitudes: number[], targetLength: number): number[] {
  if (amplitudes.length === 0) return new Array(targetLength).fill(0)
  if (amplitudes.length <= targetLength) {
    const result = [...amplitudes]
    while (result.length < targetLength) result.push(0)
    return result
  }

  const result: number[] = []
  const ratio = amplitudes.length / targetLength
  for (let i = 0; i < targetLength; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.floor((i + 1) * ratio)
    let max = 0
    for (let j = start; j < end; j++) {
      if (amplitudes[j] > max) max = amplitudes[j]
    }
    result.push(max)
  }
  return result
}
