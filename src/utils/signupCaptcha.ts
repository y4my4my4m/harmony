/**
 * Sign-up check (20261111100001_signup_captcha.sql). The sign-up hook answers 428 when it asks for
 * the check; the client shows the widget and sends its token as user_metadata.captcha_token.
 *
 * The widget runs in public/embed-player.html?captcha=… on the instance's web origin: a site key
 * names the hostnames it works on, and the native apps' pages are on tauri://localhost or
 * http://tauri.localhost. The web app is served by its instance, so the page's own origin there.
 */
import { supabase } from '@/supabase'
import { getStoredInstance } from '@/services/instanceConfig'
import { EMBED_RELAY_PATH } from '@/utils/embedDetection'

export type CaptchaProvider = 'turnstile' | 'hcaptcha'

export interface SignupCaptchaConfig {
  provider: CaptchaProvider
  siteKey: string
}

/** HTTP status of the hook's ask; GoTrue relays it as the error's status. */
export const CAPTCHA_ASK_STATUS = 428

export const CAPTCHA_PROVIDERS: readonly CaptchaProvider[] = ['turnstile', 'hcaptcha']

const SITE_KEY = /^[A-Za-z0-9_-]{1,100}$/

/** The hook asked for the check: with no token, or after the provider refused one. */
export function isCaptchaAsk(error: unknown): boolean {
  return (error as { status?: unknown } | null | undefined)?.status === CAPTCHA_ASK_STATUS
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Provider and site key from instance_config; null while the check is off or unusable. */
export function parseSignupCaptchaConfig(rows: Array<{ config_key: string; config_value: unknown }>): SignupCaptchaConfig | null {
  const stored = new Map(rows.map((row) => [row.config_key, row.config_value]))
  const provider = asText(stored.get('signup_captcha_provider'))
  const siteKey = asText(stored.get('signup_captcha_site_key'))
  if (!(CAPTCHA_PROVIDERS as readonly string[]).includes(provider) || !SITE_KEY.test(siteKey)) return null
  return { provider: provider as CaptchaProvider, siteKey }
}

/** Public keys: readable without a session. */
export async function loadSignupCaptchaConfig(): Promise<SignupCaptchaConfig | null> {
  const { data, error } = await supabase
    .from('instance_config')
    .select('config_key, config_value')
    .in('config_key', ['signup_captcha_provider', 'signup_captcha_site_key'])
  if (error) throw error
  return parseSignupCaptchaConfig(data ?? [])
}

/** Origin that serves the widget page: the stored instance in the native apps, else this page. */
export function captchaPageOrigin(): string {
  const stored = getStoredInstance()
  if (stored) {
    try {
      const origin = new URL(stored.origin)
      if (origin.protocol === 'https:') return origin.origin
    } catch {
      // Unparsable: this page's origin below.
    }
  }
  return window.location.origin
}

export function captchaFrameSrc(config: SignupCaptchaConfig, options: { theme?: 'light' | 'dark'; lang?: string } = {}): string {
  const params = new URLSearchParams({ captcha: config.provider, sitekey: config.siteKey })
  if (options.theme) params.set('theme', options.theme)
  if (options.lang) params.set('lang', options.lang)
  return `${captchaPageOrigin()}${EMBED_RELAY_PATH}?${params.toString()}`
}

export type CaptchaFrameEvent =
  | { ev: 'captcha-ready' }
  | { ev: 'captcha'; token: string }
  | { ev: 'captcha-expired' }
  | { ev: 'captcha-error'; message: string }
  | { ev: 'captcha-size'; height: number }

/**
 * An event of the widget page, or null. Only messages from `frame` and the widget page's
 * origin count.
 */
export function readCaptchaEvent(event: MessageEvent, frame: Window | null | undefined, origin: string): CaptchaFrameEvent | null {
  if (!frame || event.source !== frame || event.origin !== origin) return null
  const d = event.data as Record<string, unknown> | null
  if (!d || typeof d !== 'object' || d.harmonyPlayer !== 1 || typeof d.ev !== 'string') return null
  switch (d.ev) {
    case 'captcha-ready':
    case 'captcha-expired':
      return { ev: d.ev }
    case 'captcha':
      return typeof d.token === 'string' && d.token.length > 0 && d.token.length <= 4096 ? { ev: 'captcha', token: d.token } : null
    case 'captcha-error':
      return { ev: 'captcha-error', message: typeof d.message === 'string' ? d.message : '' }
    case 'captcha-size': {
      const height = Number(d.height)
      return Number.isFinite(height) && height > 0 ? { ev: 'captcha-size', height: Math.min(Math.round(height), 800) } : null
    }
    default:
      return null
  }
}
