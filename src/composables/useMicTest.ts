import { getCurrentInstance, onBeforeUnmount, ref } from 'vue'
import { debug } from '@/utils/debug'
import { VoiceSettingsService } from '@/services/VoiceSettingsService'
import { inputGain, levelPercentFromRms, rmsOf } from '@/services/voice/micGain'

// Test runs stop on their own after this long, ms.
const TEST_DURATION_MS = 10_000
// setTargetAtTime time constant, seconds.
const GAIN_SMOOTHING_S = 0.02

/**
 * Microphone test for the voice settings: the selected device with the
 * stored echo cancellation / noise suppression / AGC, scaled by the input
 * volume, metered post-gain on a log scale. What the meter shows is what a
 * call would send.
 */
export function useMicTest() {
  const isTesting = ref(false)
  const testLevel = ref(0)

  let stream: MediaStream | null = null
  let context: AudioContext | null = null
  let gainNode: GainNode | null = null
  let rafId: number | null = null
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  // Bumped by every start and stop; a getUserMedia resolving after its run
  // was superseded discards its stream.
  let generation = 0

  function stop(): void {
    generation++
    isTesting.value = false
    testLevel.value = 0
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    stream?.getTracks().forEach(track => track.stop())
    stream = null
    gainNode = null
    if (context) {
      const ctx = context
      context = null
      if (ctx.state !== 'closed') void ctx.close()
    }
  }

  async function start(deviceId: string | null, inputVolume: number): Promise<void> {
    stop()
    const run = ++generation
    isTesting.value = true
    try {
      const constraints = VoiceSettingsService.getAudioConstraints()
      const captured = await navigator.mediaDevices.getUserMedia({
        audio: { ...constraints, ...(deviceId ? { deviceId } : {}) },
      })
      if (run !== generation || !isTesting.value) {
        captured.getTracks().forEach(track => track.stop())
        return
      }
      stream = captured

      const ctx = new AudioContext()
      context = ctx
      const source = ctx.createMediaStreamSource(captured)
      gainNode = ctx.createGain()
      gainNode.gain.value = inputGain(inputVolume)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(gainNode)
      gainNode.connect(analyser)
      const samples = new Float32Array(analyser.fftSize)

      const tick = () => {
        if (run !== generation) return
        analyser.getFloatTimeDomainData(samples)
        testLevel.value = levelPercentFromRms(rmsOf(samples))
        rafId = requestAnimationFrame(tick)
      }
      tick()

      timeoutId = setTimeout(() => {
        timeoutId = null
        stop()
      }, TEST_DURATION_MS)
    } catch (error) {
      debug.error('Error testing microphone:', error)
      stop()
    }
  }

  async function toggle(deviceId: string | null, inputVolume: number): Promise<void> {
    if (isTesting.value) {
      stop()
      return
    }
    await start(deviceId, inputVolume)
  }

  /** Follows the input volume slider while a test runs. */
  function setInputVolume(percent: number): void {
    if (gainNode && context) {
      gainNode.gain.setTargetAtTime(inputGain(percent), context.currentTime, GAIN_SMOOTHING_S)
    }
  }

  if (getCurrentInstance()) onBeforeUnmount(stop)

  return { isTesting, testLevel, start, stop, toggle, setInputVolume }
}
