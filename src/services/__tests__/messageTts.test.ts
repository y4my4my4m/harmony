/**
 * Speaking a message: settings stay device-local and per user, the browser and
 * external voice paths behave, URLs are locked down, and a replaced or stopped
 * playback is torn down without a spurious error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

const auth = vi.hoisted(() => ({ cb: null as null | ((event: string, session: unknown) => void) }))
vi.mock('@/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        auth.cb = cb
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      },
    },
  },
}))

import { userStorage } from '@/utils/userScopedStorage'
import {
  buildTtsEndpoint,
  DEFAULT_TTS_BASE_URL,
  DEFAULT_TTS_MODEL_ID,
  isMessageTtsSupported,
  isSpeaking,
  loadMessageTtsSettings,
  normalizeTtsBaseUrl,
  saveMessageTtsSettings,
  speakMessage,
  stopMessageSpeech,
  TTS_SETTINGS_STORAGE_KEY,
  type MessageTtsSettings,
} from '@/services/messageTts'

const browserSettings: MessageTtsSettings = {
  provider: 'browser', baseUrl: DEFAULT_TTS_BASE_URL, voiceId: '', modelId: '', apiKey: '',
}

const externalSettings = (over: Partial<MessageTtsSettings> = {}): MessageTtsSettings => ({
  provider: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io', voiceId: 'voice one', modelId: '', apiKey: '', ...over,
})

function audioResponse(): Response {
  return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } })
}

let utterances: Array<{ text: string; onend: (() => void) | null; onerror: ((event: unknown) => void) | null }> = []
let speakCalls: ReturnType<typeof vi.fn>
let cancelCalls: ReturnType<typeof vi.fn>
let audios: Array<{ src: string; onended: (() => void) | null; onerror: (() => void) | null; paused: boolean; playRejects?: boolean }> = []
let revokeObjectURL: ReturnType<typeof vi.fn>

function installBrowserSpeech(): void {
  utterances = []
  speakCalls = vi.fn()
  cancelCalls = vi.fn()
  class FakeUtterance {
    text: string
    onend: (() => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    constructor(text: string) {
      this.text = text
      utterances.push(this)
    }
  }
  speakCalls.mockImplementation((utterance: { text: string }) => { void utterance })
  vi.stubGlobal('speechSynthesis', { speak: speakCalls, cancel: cancelCalls })
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
}

interface AudioSetup {
  playRejects?: boolean
  playThrows?: boolean
  audioCtorThrows?: boolean
  createObjectUrlThrows?: boolean
}

function installAudio(options: AudioSetup = {}): void {
  audios = []
  if (options.createObjectUrlThrows) {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('blocked') })
  } else {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:tts-1')
  }
  class FakeAudio {
    src: string
    onended: (() => void) | null = null
    onerror: (() => void) | null = null
    paused = false
    playRejects = options.playRejects ?? false
    playThrows = options.playThrows ?? false
    constructor(src: string) {
      if (options.audioCtorThrows) throw new Error('no audio element')
      this.src = src
      audios.push(this)
    }
    play() {
      if (this.playThrows) throw new Error('play threw')
      return this.playRejects ? Promise.reject(new Error('blocked')) : Promise.resolve()
    }
    pause() {
      this.paused = true
    }
    removeAttribute() {
      this.src = ''
    }
  }
  vi.stubGlobal('Audio', FakeAudio)
  revokeObjectURL = vi.fn()
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectURL)
}

beforeEach(() => {
  localStorage.clear()
  userStorage.clearCurrentUser()
  stopMessageSpeech()
})

afterEach(() => {
  stopMessageSpeech()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('normalizeTtsBaseUrl', () => {
  it('accepts https and loopback http, trimming trailing slashes', () => {
    expect(normalizeTtsBaseUrl('https://api.elevenlabs.io')).toBe('https://api.elevenlabs.io')
    expect(normalizeTtsBaseUrl('https://api.elevenlabs.io/')).toBe('https://api.elevenlabs.io')
    expect(normalizeTtsBaseUrl('  https://tts.example.com/prefix/  ')).toBe('https://tts.example.com/prefix')
    expect(normalizeTtsBaseUrl('http://localhost:8080')).toBe('http://localhost:8080')
    expect(normalizeTtsBaseUrl('http://127.0.0.1:5000/')).toBe('http://127.0.0.1:5000')
    expect(normalizeTtsBaseUrl('http://[::1]:5000')).toBe('http://[::1]:5000')
  })

  it('refuses credentials, query, fragment, other schemes and remote http', () => {
    expect(normalizeTtsBaseUrl('https://user:pass@api.example.com')).toBeNull()
    expect(normalizeTtsBaseUrl('https://api.example.com/?token=x')).toBeNull()
    expect(normalizeTtsBaseUrl('https://api.example.com/#x')).toBeNull()
    expect(normalizeTtsBaseUrl('ftp://api.example.com')).toBeNull()
    expect(normalizeTtsBaseUrl('http://api.example.com')).toBeNull()
    expect(normalizeTtsBaseUrl('not a url')).toBeNull()
    expect(normalizeTtsBaseUrl('')).toBeNull()
  })
})

describe('buildTtsEndpoint', () => {
  it('appends /v1/text-to-speech and never doubles a /v1 base', () => {
    expect(buildTtsEndpoint('https://api.elevenlabs.io', 'abc')).toBe('https://api.elevenlabs.io/v1/text-to-speech/abc')
    expect(buildTtsEndpoint('https://api.elevenlabs.io/', 'abc')).toBe('https://api.elevenlabs.io/v1/text-to-speech/abc')
    expect(buildTtsEndpoint('https://api.elevenlabs.io/v1', 'abc')).toBe('https://api.elevenlabs.io/v1/text-to-speech/abc')
    expect(buildTtsEndpoint('https://api.elevenlabs.io/v1/', 'a b')).toBe('https://api.elevenlabs.io/v1/text-to-speech/a%20b')
  })
})

describe('device settings', () => {
  it('round-trips and falls back to defaults for malformed values', () => {
    userStorage.setCurrentUser('u1')
    expect(loadMessageTtsSettings()).toEqual(browserSettings)
    expect(saveMessageTtsSettings(externalSettings({ apiKey: 'k' }))).toBe(true)
    expect(loadMessageTtsSettings()).toEqual(externalSettings({ apiKey: 'k' }))

    userStorage.setItem(TTS_SETTINGS_STORAGE_KEY, 'not json')
    expect(loadMessageTtsSettings()).toEqual(browserSettings)

    userStorage.setItem(TTS_SETTINGS_STORAGE_KEY, JSON.stringify({ provider: 'weird', baseUrl: 5, voiceId: null }))
    const s = loadMessageTtsSettings()
    expect(s.provider).toBe('browser')
    expect(s.baseUrl).toBe(DEFAULT_TTS_BASE_URL)
    expect(s.voiceId).toBe('')
  })

  it('isolates one account from another and refuses to persist without a user', () => {
    userStorage.setCurrentUser('u1')
    saveMessageTtsSettings(externalSettings({ voiceId: 'u1-voice' }))
    userStorage.setCurrentUser('u2')
    expect(loadMessageTtsSettings().voiceId).toBe('')

    userStorage.clearCurrentUser()
    expect(loadMessageTtsSettings().voiceId).toBe('')
    expect(saveMessageTtsSettings(externalSettings({ voiceId: 'nobody' }))).toBe(false)
    expect(localStorage.length).toBe(0)
  })
})

describe('browser voice', () => {
  it('is detected and speaks the message text', async () => {
    installBrowserSpeech()
    expect(isMessageTtsSupported()).toBe(true)

    const done = speakMessage({ messageId: 'm1', text: 'hi there', settings: browserSettings })
    await flushPromises()
    expect(speakCalls).toHaveBeenCalledTimes(1)
    expect(utterances[0].text).toBe('hi there')
    expect(isSpeaking.value).toBe(true)

    utterances[0].onend?.()
    await done
    expect(isSpeaking.value).toBe(false)
  })

  it('reports a browser without speech support', async () => {
    await expect(speakMessage({ messageId: 'm1', text: 'hi', settings: browserSettings }))
      .rejects.toMatchObject({ code: 'unsupported' })
  })
})

describe('external voice', () => {
  it('posts the message with locked-down fetch flags and plays the audio', async () => {
    const fetcher = vi.fn(async (..._args: unknown[]) => audioResponse())
    vi.stubGlobal('fetch', fetcher)
    installAudio()

    const done = speakMessage({
      messageId: 'm1', text: 'hello', settings: externalSettings({ apiKey: 'secret-key' }),
    })
    await vi.waitFor(() => { if (audios.length !== 1) throw new Error('no audio yet') })

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice%20one')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('omit')
    expect(init.redirect).toBe('error')
    expect(init.referrerPolicy).toBe('no-referrer')
    expect(init.cache).toBe('no-store')
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('secret-key')
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hello', model_id: DEFAULT_TTS_MODEL_ID })
    expect(audios[0].src).toBe('blob:tts-1')

    audios[0].onended?.()
    await done
    expect(isSpeaking.value).toBe(false)
    // Audio finished on its own: its blob URL is released.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:tts-1')
  })

  it('omits the key header when no key is set on a non-official engine', async () => {
    const fetcher = vi.fn(async (..._args: unknown[]) => audioResponse())
    vi.stubGlobal('fetch', fetcher)
    installAudio()
    const done = speakMessage({
      messageId: 'm1', text: 'hi', settings: externalSettings({ baseUrl: 'http://localhost:8080' }),
    })
    await vi.waitFor(() => { if (audios.length !== 1) throw new Error('no audio yet') })
    expect((fetcher.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty('xi-api-key')
    audios[0].onended?.()
    await done
  })

  it('fails locally when the official API has no key', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(speakMessage({ messageId: 'm1', text: 'hi', settings: externalSettings() }))
      .rejects.toMatchObject({ code: 'missing-key' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('accepts octet-stream from a local engine and rejects a non-audio body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'Content-Type': 'application/octet-stream' },
    })))
    installAudio()
    const done = speakMessage({
      messageId: 'm1', text: 'hi', settings: externalSettings({ baseUrl: 'http://localhost:8080' }),
    })
    await vi.waitFor(() => { if (audios.length !== 1) throw new Error('no audio yet') })
    audios[0].onended?.()
    await done

    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'Content-Type': 'image/png' },
    })))
    await expect(speakMessage({
      messageId: 'm2', text: 'hi', settings: externalSettings({ baseUrl: 'http://localhost:8080' }),
    })).rejects.toMatchObject({ code: 'audio' })
    expect(isSpeaking.value).toBe(false)
  })

  it('refuses an invalid base URL without touching the network', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(speakMessage({
      messageId: 'm1', text: 'hi', settings: externalSettings({ baseUrl: 'http://remote.example' }),
    })).rejects.toMatchObject({ code: 'invalid-url' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('requires a voice id', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await expect(speakMessage({
      messageId: 'm1', text: 'hi', settings: externalSettings({ voiceId: '  ' }),
    })).rejects.toMatchObject({ code: 'missing-voice-id' })
  })

  it('reports HTTP, non-audio and network failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 401 })))
    await expect(speakMessage({ messageId: 'm1', text: 'hi', settings: externalSettings({ apiKey: 'k' }) }))
      .rejects.toMatchObject({ code: 'http', status: 401 })
    expect(isSpeaking.value).toBe(false)

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })))
    await expect(speakMessage({ messageId: 'm1', text: 'hi', settings: externalSettings({ apiKey: 'k' }) }))
      .rejects.toMatchObject({ code: 'audio' })

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed') }))
    await expect(speakMessage({ messageId: 'm1', text: 'hi', settings: externalSettings({ apiKey: 'k' }) }))
      .rejects.toMatchObject({ code: 'network' })
  })

  it('reports a playback that will not start', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()))
    installAudio({ playRejects: true })
    await expect(speakMessage({ messageId: 'm1', text: 'hi', settings: externalSettings({ apiKey: 'k' }) }))
      .rejects.toMatchObject({ code: 'audio' })
    expect(isSpeaking.value).toBe(false)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:tts-1')
  })

  it('recovers when the audio element cannot be set up', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()))
    installAudio({ createObjectUrlThrows: true })
    await expect(speakMessage({ messageId: 'm1', text: 'hi', settings: externalSettings({ apiKey: 'k' }) }))
      .rejects.toMatchObject({ code: 'audio' })
    expect(isSpeaking.value).toBe(false)

    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()))
    installAudio({ audioCtorThrows: true })
    await expect(speakMessage({ messageId: 'm1', text: 'hi', settings: externalSettings({ apiKey: 'k' }) }))
      .rejects.toMatchObject({ code: 'audio' })
    expect(isSpeaking.value).toBe(false)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:tts-1')
  })

  it('turns a synchronous play() throw into an audio failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()))
    installAudio({ playThrows: true })
    await expect(speakMessage({ messageId: 'm1', text: 'hi', settings: externalSettings({ apiKey: 'k' }) }))
      .rejects.toMatchObject({ code: 'audio' })
    expect(isSpeaking.value).toBe(false)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:tts-1')
  })
})

describe('replacement, cancellation and cleanup', () => {
  it('aborts the previous request and ignores its late response', async () => {
    let resolveFirst!: (response: Response) => void
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve }))
      .mockImplementation(async () => audioResponse())
    vi.stubGlobal('fetch', fetcher)
    installAudio()

    const first = speakMessage({ messageId: 'm1', text: 'one', settings: externalSettings({ apiKey: 'k' }) })
    await vi.waitFor(() => { if (fetcher.mock.calls.length !== 1) throw new Error('no first request') })
    const firstSignal = (fetcher.mock.calls[0][1] as RequestInit).signal as AbortSignal

    const second = speakMessage({ messageId: 'm2', text: 'two', settings: externalSettings({ apiKey: 'k' }) })
    await vi.waitFor(() => { if (audios.length !== 1) throw new Error('no audio yet') })
    expect(firstSignal.aborted).toBe(true)

    resolveFirst(audioResponse())
    await expect(first).resolves.toBeUndefined()
    // Only the second message's audio exists; the late response added none.
    expect(audios).toHaveLength(1)

    audios[0].onended?.()
    await second
  })

  it('pauses the audio and revokes its blob URL when stopped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse()))
    installAudio()
    const done = speakMessage({ messageId: 'm1', text: 'hi', settings: externalSettings({ apiKey: 'k' }) })
    await vi.waitFor(() => { if (audios.length !== 1) throw new Error('no audio yet') })

    stopMessageSpeech()
    expect(audios[0].paused).toBe(true)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:tts-1')
    await done
    expect(isSpeaking.value).toBe(false)
  })

  it('cancels the browser voice when a new message replaces it', async () => {
    installBrowserSpeech()
    const first = speakMessage({ messageId: 'm1', text: 'one', settings: browserSettings })
    await flushPromises()
    const second = speakMessage({ messageId: 'm2', text: 'two', settings: browserSettings })
    await flushPromises()
    expect(cancelCalls).toHaveBeenCalled()
    utterances[1].onend?.()
    await second
    await first
  })

  it('stops speaking when the account signs out', async () => {
    installBrowserSpeech()
    userStorage.setCurrentUser('u1')
    const done = speakMessage({ messageId: 'm1', text: 'hi', settings: browserSettings })
    await flushPromises()
    expect(isSpeaking.value).toBe(true)
    auth.cb?.('SIGNED_OUT', null)
    expect(isSpeaking.value).toBe(false)
    expect(cancelCalls).toHaveBeenCalled()
    await done
  })

  it('aborts a pending external request when a different account signs in', async () => {
    let resolveFirst!: (response: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { resolveFirst = resolve }))
    vi.stubGlobal('fetch', fetcher)
    installAudio()
    userStorage.setCurrentUser('u1')

    const pending = speakMessage({
      messageId: 'm1', text: 'hi', settings: externalSettings({ apiKey: 'k' }),
    })
    await vi.waitFor(() => { if (fetcher.mock.calls.length !== 1) throw new Error('no request') })
    const signal = (fetcher.mock.calls[0][1] as RequestInit).signal as AbortSignal

    auth.cb?.('SIGNED_IN', { user: { id: 'u2' } })
    expect(signal.aborted).toBe(true)
    expect(isSpeaking.value).toBe(false)

    resolveFirst(audioResponse())
    await expect(pending).resolves.toBeUndefined()
  })
})
