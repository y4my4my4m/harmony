import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const leveled = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('../voice/voiceMessageLevel', () => ({ levelChain: vi.fn(() => leveled) }))

import { useVoiceRecording } from '../voiceRecordingService'
import { levelChain } from '../voice/voiceMessageLevel'

const micStream = { id: 'mic', getTracks: () => [{ stop: vi.fn() }] }
const destinationStream = { id: 'leveled' }
let contextState: AudioContextState = 'running'
let recordedFrom: unknown = null

class FakeAudioContext {
  state: AudioContextState = contextState
  async resume() { this.state = contextState }
  async close() { this.state = 'closed' }
  createMediaStreamSource() { return { connect: vi.fn() } }
  createAnalyser() { return { fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 128, getByteTimeDomainData() {} } }
  createMediaStreamDestination() { return { stream: destinationStream } }
}

class FakeMediaRecorder {
  static isTypeSupported() { return true }
  state = 'inactive'
  mimeType = 'audio/webm;codecs=opus'
  ondataavailable: ((e: unknown) => void) | null = null
  constructor(stream: unknown) { recordedFrom = stream }
  start() { this.state = 'recording' }
  stop() { this.state = 'inactive' }
}

beforeEach(() => {
  recordedFrom = null
  leveled.connect.mockClear()
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => micStream) } })
})
afterEach(() => vi.unstubAllGlobals())

describe('voice recording level', () => {
  it('records the leveled signal when the audio context runs', async () => {
    contextState = 'running'
    const rec = useVoiceRecording()
    await rec.startRecording()
    expect(levelChain).toHaveBeenCalled()
    expect(recordedFrom).toBe(destinationStream)
    rec.cancelRecording()
  })

  it('records the raw microphone when the context stays suspended', async () => {
    contextState = 'suspended'
    vi.mocked(levelChain).mockClear()
    const rec = useVoiceRecording()
    await rec.startRecording()
    expect(levelChain).not.toHaveBeenCalled()
    expect(recordedFrom).toBe(micStream)
    rec.cancelRecording()
  })
})
