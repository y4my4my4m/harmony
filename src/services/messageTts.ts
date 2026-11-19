/**
 * Speak a chat message aloud, on demand, from its context menu.
 *
 * Two voice sources, chosen per device in Settings > Appearance:
 *  - this browser's Web Speech API (the default); the voice it picks is the
 *    browser's own default, and the browser may use an online service.
 *  - an ElevenLabs-compatible HTTP API, called directly from the page.
 *
 * Nothing here touches a Harmony backend, appearance sync or telemetry. The
 * settings and the optional API key live in user-scoped local storage; the
 * spoken text is sent only to the voice service the person configured, only
 * when they ask for it.
 */

import { ref } from 'vue'
import { supabase } from '@/supabase'
import { userStorage } from '@/utils/userScopedStorage'
import { debug } from '@/utils/debug'

export type TtsProvider = 'browser' | 'elevenlabs'

export interface MessageTtsSettings {
  provider: TtsProvider
  /** Origin or prefix before /v1, e.g. https://api.elevenlabs.io */
  baseUrl: string
  voiceId: string
  /** Optional; empty uses DEFAULT_TTS_MODEL_ID. */
  modelId: string
  /** Sent as xi-api-key when non-empty. A local engine may need none. */
  apiKey: string
}

export const DEFAULT_TTS_BASE_URL = 'https://api.elevenlabs.io'
export const DEFAULT_TTS_MODEL_ID = 'eleven_multilingual_v2'

// Hosts that always require an API key. A key-free local engine is still fine
// everywhere else.
const OFFICIAL_TTS_HOSTS = new Set(['api.elevenlabs.io', 'api.elevenlabs.com'])
export const TTS_SETTINGS_STORAGE_KEY = 'message_tts_settings'

const DEFAULTS: MessageTtsSettings = {
  provider: 'browser',
  baseUrl: DEFAULT_TTS_BASE_URL,
  voiceId: '',
  modelId: '',
  apiKey: '',
}

/** HTTP status (http) or the friendly reason a spoken message failed. */
export type MessageTtsErrorCode =
  | 'unsupported'
  | 'invalid-url'
  | 'missing-voice-id'
  | 'missing-key'
  | 'http'
  | 'network'
  | 'audio'

export class MessageTtsError extends Error {
  readonly code: MessageTtsErrorCode
  readonly status?: number

  constructor(code: MessageTtsErrorCode, status?: number) {
    super(code)
    this.name = 'MessageTtsError'
    this.code = code
    this.status = status
  }
}

/** True while a message is being fetched or played. */
export const isSpeaking = ref(false)
export const speakingMessageId = ref<string | null>(null)

// --- Settings (device-local, per user) -------------------------------------

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * Read the device settings for the signed-in user, or defaults.
 *
 * Deliberately read on each use rather than cached: userStorage forgets a
 * user's data on sign-out and account switch, and a cached copy could carry
 * one account's key into the next.
 */
export function loadMessageTtsSettings(): MessageTtsSettings {
  // With no signed-in user, userStorage would fall back to an instance-global
  // key shared by everyone. Report defaults instead so nothing leaks.
  if (typeof window === 'undefined' || !userStorage.getCurrentUser()) return { ...DEFAULTS }
  try {
    const raw = userStorage.getItem(TTS_SETTINGS_STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS }
    return {
      provider: parsed.provider === 'elevenlabs' ? 'elevenlabs' : 'browser',
      baseUrl: asString(parsed.baseUrl, DEFAULT_TTS_BASE_URL),
      voiceId: asString(parsed.voiceId, ''),
      modelId: asString(parsed.modelId, ''),
      apiKey: asString(parsed.apiKey, ''),
    }
  } catch {
    debug.warn('Could not read message TTS settings; using defaults')
    return { ...DEFAULTS }
  }
}

/**
 * Persist the device settings for the current user. Returns false (and writes
 * nothing) when no user is signed in, so settings never land in the
 * instance-global fallback key.
 */
export function saveMessageTtsSettings(settings: MessageTtsSettings): boolean {
  if (typeof window === 'undefined' || !userStorage.getCurrentUser()) return false
  try {
    userStorage.setItem(TTS_SETTINGS_STORAGE_KEY, JSON.stringify({
      provider: settings.provider === 'elevenlabs' ? 'elevenlabs' : 'browser',
      baseUrl: settings.baseUrl,
      voiceId: settings.voiceId,
      modelId: settings.modelId,
      apiKey: settings.apiKey,
    }))
    return true
  } catch {
    debug.error('Could not save message TTS settings')
    return false
  }
}

// --- URL validation --------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The origin/prefix before `/v1`, or null when the URL is not allowed.
 *
 * Only HTTPS, or plain HTTP on the loopback hosts where a local engine
 * commonly runs. Embedded credentials, a query, a fragment and every other
 * scheme are refused, so a typo cannot leak the key or the message somewhere
 * unexpected.
 */
export function normalizeTtsBaseUrl(input: string): string | null {
  const raw = (input ?? '').trim()
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.username || url.password) return null
  if (url.search || url.hash) return null
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) return null
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}`
}

/** `{base}/v1/text-to-speech/{voiceId}`; a base already ending in /v1 is trimmed. */
export function buildTtsEndpoint(baseUrl: string, voiceId: string): string {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')
  return `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}`
}

/** Whether this base URL is the official ElevenLabs API, which needs a key. */
function isOfficialElevenLabsHost(baseUrl: string): boolean {
  try {
    return OFFICIAL_TTS_HOSTS.has(new URL(baseUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

/** Whether this browser can speak with its built-in voice. */
export function isMessageTtsSupported(): boolean {
  return typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && typeof window.SpeechSynthesisUtterance === 'function'
}

// --- Playback state --------------------------------------------------------

let generation = 0
let audioEl: HTMLAudioElement | null = null
let objectUrl: string | null = null
let abortController: AbortController | null = null
// Resolves the promise of the playback in progress, so a stop settles it.
let settlePlayback: (() => void) | null = null
// The user whose message is being spoken, so a sign-in as someone else stops it.
let spokenForUserId: string | null = null
let authGuardStarted = false

function finishSpeech(): void {
  isSpeaking.value = false
  speakingMessageId.value = null
  spokenForUserId = null
}

/** Detach the audio element and revoke its blob URL, on end, error or stop. */
function releaseAudio(): void {
  if (audioEl) {
    audioEl.onended = null
    audioEl.onerror = null
    try { audioEl.pause() } catch { /* not started */ }
    try { audioEl.removeAttribute('src') } catch { /* not attached */ }
    audioEl = null
  }
  if (objectUrl) {
    try { URL.revokeObjectURL(objectUrl) } catch { /* already revoked */ }
    objectUrl = null
  }
}

/**
 * Stop the pending fetch and any audio now playing, and revoke its blob URL.
 * Safe to call at any time; the in-flight promise of the stopped playback
 * resolves rather than rejecting, so its caller shows no error.
 */
export function stopMessageSpeech(): void {
  generation += 1
  const settle = settlePlayback
  settlePlayback = null
  if (settle) settle()
  if (abortController) {
    try { abortController.abort() } catch { /* already settled */ }
    abortController = null
  }
  releaseAudio()
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try { window.speechSynthesis.cancel() } catch { /* unsupported */ }
  }
  finishSpeech()
}

// Subscribed lazily the first time something is spoken, never an auth rewrite.
function ensureAuthGuard(): void {
  if (authGuardStarted || typeof window === 'undefined') return
  authGuardStarted = true
  try {
    supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        stopMessageSpeech()
        return
      }
      if (event === 'SIGNED_IN' && spokenForUserId && session?.user?.id && session.user.id !== spokenForUserId) {
        stopMessageSpeech()
      }
    })
  } catch {
    // No auth client available (tests, non-app contexts): nothing to guard.
  }
}

// --- Speaking --------------------------------------------------------------

export interface SpeakMessageOptions {
  messageId: string
  text: string
  /** Defaults to the device settings; passed in tests and previews. */
  settings?: MessageTtsSettings
}

/**
 * Speak `text` for `messageId`, replacing any playback already under way.
 * Rejects with a MessageTtsError code for the caller to translate; a
 * playback stopped by a newer one or by stopMessageSpeech resolves.
 */
export async function speakMessage({ messageId, text, settings }: SpeakMessageOptions): Promise<void> {
  ensureAuthGuard()
  stopMessageSpeech()
  const myGeneration = generation
  spokenForUserId = userStorage.getCurrentUser()
  const resolved = settings ?? loadMessageTtsSettings()
  if (resolved.provider === 'elevenlabs') {
    await speakExternal(text, resolved, messageId, myGeneration)
    return
  }
  await speakBrowser(text, messageId, myGeneration)
}

function speakBrowser(text: string, messageId: string, gen: number): Promise<void> {
  if (!isMessageTtsSupported()) {
    finishSpeech()
    return Promise.reject(new MessageTtsError('unsupported'))
  }
  return new Promise<void>((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text)
    isSpeaking.value = true
    speakingMessageId.value = messageId
    let settled = false
    const cleanup = () => {
      if (settled) return
      settled = true
      settlePlayback = null
    }
    settlePlayback = () => { cleanup(); resolve() }
    utterance.onend = () => {
      if (gen === generation) finishSpeech()
      cleanup()
      resolve()
    }
    utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
      // cancel()/interrupt is our own replacement, never an error to report.
      const replaced = event.error === 'canceled' || event.error === 'interrupted'
      if (gen === generation) finishSpeech()
      cleanup()
      if (replaced || gen !== generation) resolve()
      else reject(new MessageTtsError('audio'))
    }
    try {
      window.speechSynthesis.speak(utterance)
    } catch {
      if (gen === generation) finishSpeech()
      cleanup()
      reject(new MessageTtsError('audio'))
    }
  })
}

async function speakExternal(
  text: string,
  settings: MessageTtsSettings,
  messageId: string,
  gen: number,
): Promise<void> {
  const base = normalizeTtsBaseUrl(settings.baseUrl)
  if (!base) throw new MessageTtsError('invalid-url')
  const voiceId = settings.voiceId.trim()
  if (!voiceId) throw new MessageTtsError('missing-voice-id')
  // The official service answers a keyless request with a 401; report the real
  // reason here instead, while a local engine may legitimately need no key.
  if (!settings.apiKey && isOfficialElevenLabsHost(base)) throw new MessageTtsError('missing-key')

  const controller = new AbortController()
  abortController = controller
  isSpeaking.value = true
  speakingMessageId.value = messageId

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'audio/*',
  }
  if (settings.apiKey) headers['xi-api-key'] = settings.apiKey

  let response: Response
  try {
    response = await fetch(buildTtsEndpoint(base, voiceId), {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, model_id: settings.modelId || DEFAULT_TTS_MODEL_ID }),
      // A user-triggered call to their own voice service: send no cookies to
      // it, follow no redirect, keep no cache, and send no referrer.
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: controller.signal,
    })
  } catch {
    if (gen !== generation) return
    finishSpeech()
    throw new MessageTtsError('network')
  }

  if (gen !== generation) return
  if (!response.ok) {
    finishSpeech()
    throw new MessageTtsError('http', response.status)
  }

  let blob: Blob
  try {
    blob = await response.blob()
  } catch {
    if (gen !== generation) return
    finishSpeech()
    throw new MessageTtsError('audio')
  }

  // A successful response must carry playable binary: audio/* or the generic
  // octet-stream a local engine may send. Anything else (an HTML error page,
  // JSON) is not audio.
  if (gen !== generation) return
  const contentType = (response.headers.get('content-type') || '').toLowerCase().split(';')[0].trim()
  if (blob.size === 0 || !(contentType.startsWith('audio/') || contentType === 'application/octet-stream')) {
    finishSpeech()
    throw new MessageTtsError('audio')
  }

  // URL.createObjectURL or the Audio constructor can throw on a locked-down
  // engine; release whatever was made and report a plain audio failure.
  let url: string
  try {
    url = URL.createObjectURL(blob)
  } catch {
    if (gen !== generation) return
    finishSpeech()
    throw new MessageTtsError('audio')
  }
  objectUrl = url

  let audio: HTMLAudioElement
  try {
    audio = new Audio(url)
  } catch {
    try { URL.revokeObjectURL(url) } catch { /* already revoked */ }
    if (objectUrl === url) objectUrl = null
    if (gen === generation) finishSpeech()
    throw new MessageTtsError('audio')
  }
  audioEl = audio

  await new Promise<void>((resolve, reject) => {
    const stale = () => gen !== generation
    let settled = false
    const cleanup = () => {
      if (settled) return
      settled = true
      settlePlayback = null
    }
    const fail = () => {
      if (stale()) { cleanup(); resolve(); return }
      releaseAudio()
      finishSpeech()
      cleanup()
      reject(new MessageTtsError('audio'))
    }
    settlePlayback = () => { cleanup(); resolve() }
    audio.onended = () => {
      if (!stale()) { releaseAudio(); finishSpeech() }
      cleanup()
      resolve()
    }
    audio.onerror = fail
    try {
      const started = audio.play()
      // Some engines return undefined from play(); only a thenable can reject.
      if (started && typeof (started as Promise<void>).catch === 'function') started.catch(fail)
    } catch {
      // A synchronous throw from play() must not escape as a raw error.
      fail()
    }
  })
}
