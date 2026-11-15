import { supabase } from '@/supabase'
import { adminService } from '@/services/AdminService'

/** Admin settings of the sign-up check (20261111100001_signup_captcha.sql). */
export interface SignupCaptchaSettings {
  provider: 'off' | 'turnstile' | 'hcaptcha'
  siteKey: string
  mode: 'suspect' | 'always'
  /** A secret key is stored. Its value is never put in the form. */
  secretSet: boolean
}

export interface SignupCaptchaCounts {
  asked: number
  passed: number
  failed: number
  unverified: number
}

const KEYS = {
  provider: 'signup_captcha_provider',
  siteKey: 'signup_captcha_site_key',
  secret: 'signup_captcha_secret',
  mode: 'signup_captcha_mode',
} as const

export const SIGNUP_CAPTCHA_DEFAULTS: Readonly<SignupCaptchaSettings> = {
  provider: 'off',
  siteKey: '',
  mode: 'suspect',
  secretSet: false,
}

const SITE_KEY = /^[A-Za-z0-9_-]{1,100}$/
/** Printable ASCII without spaces: both providers' secrets. */
const SECRET = /^[\x21-\x7e]{1,200}$/

export function isValidSiteKey(value: string): boolean {
  return SITE_KEY.test(value.trim())
}

export function isValidSecret(value: string): boolean {
  return SECRET.test(value.trim())
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export async function loadSignupCaptchaSettings(): Promise<SignupCaptchaSettings> {
  const { data, error } = await supabase
    .from('instance_config')
    .select('config_key, config_value')
    .in('config_key', Object.values(KEYS))
  if (error) throw error
  const stored = new Map((data ?? []).map((row) => [row.config_key, row.config_value as unknown]))
  const provider = asText(stored.get(KEYS.provider))
  const mode = asText(stored.get(KEYS.mode))
  return {
    provider: provider === 'turnstile' || provider === 'hcaptcha' ? provider : 'off',
    siteKey: asText(stored.get(KEYS.siteKey)),
    mode: mode === 'always' ? 'always' : 'suspect',
    secretSet: asText(stored.get(KEYS.secret)) !== '',
  }
}

/**
 * Writes only what differs from `saved`, and the secret only when `secret` is non-empty: a value
 * another admin stored meanwhile stays.
 */
export async function saveSignupCaptchaSettings(
  next: SignupCaptchaSettings,
  saved: SignupCaptchaSettings,
  secret: string,
  adminId: string,
): Promise<void> {
  const changes: Record<string, unknown> = {}
  if (next.provider !== saved.provider) changes[KEYS.provider] = next.provider
  if (next.siteKey.trim() !== saved.siteKey) changes[KEYS.siteKey] = next.siteKey.trim()
  if (next.mode !== saved.mode) changes[KEYS.mode] = next.mode
  if (secret.trim() !== '') changes[KEYS.secret] = secret.trim()
  await adminService.setInstanceConfigs(changes, adminId)
}

/** signup_captcha_check's answer (20261111100001). */
export interface SignupCaptchaCheck {
  verdict: 'pass' | 'fail' | 'error'
  codes: string[]
  detail: 'answer' | 'provider' | 'token' | 'no_http' | 'network' | 'no_secret'
  http_status?: number
  message?: string
}

/** What a failed test means, as an i18n key under adminSignupCaptcha.problem. */
export type SignupCaptchaProblem =
  | 'hostname'
  | 'siteKey'
  | 'widgetNetwork'
  | 'widget'
  | 'secret'
  | 'mismatch'
  | 'token'
  | 'network'
  | 'noHttp'
  | 'status'
  | 'noSecret'
  | 'unknown'

/** Verifies a widget token with `secret`, or the stored secret when `secret` is empty. */
export async function testSignupCaptcha(
  provider: 'turnstile' | 'hcaptcha',
  token: string,
  secret: string,
): Promise<SignupCaptchaCheck> {
  const { data, error } = await supabase.rpc('admin_test_signup_captcha', {
    p_provider: provider,
    p_token: token,
    p_secret: secret.trim() || null,
  })
  if (error) throw error
  const answer = (data ?? {}) as Partial<SignupCaptchaCheck>
  return {
    verdict: answer.verdict === 'pass' || answer.verdict === 'fail' ? answer.verdict : 'error',
    codes: Array.isArray(answer.codes) ? answer.codes.filter((c): c is string => typeof c === 'string') : [],
    detail: (answer.detail ?? 'answer') as SignupCaptchaCheck['detail'],
    http_status: answer.http_status,
    message: answer.message,
  }
}

/** The problem a siteverify answer names; null when the test passed. */
export function checkProblem(check: SignupCaptchaCheck): SignupCaptchaProblem | null {
  if (check.verdict === 'pass') return null
  if (check.detail === 'no_secret') return 'noSecret'
  if (check.detail === 'no_http') return 'noHttp'
  if (check.detail === 'network') return 'network'
  if (check.codes.includes('invalid-input-secret') || check.codes.includes('missing-input-secret')) return 'secret'
  if (check.codes.includes('sitekey-secret-mismatch')) return 'mismatch'
  if (check.detail === 'answer' && check.http_status !== undefined && check.http_status !== 200) return 'status'
  if (check.verdict === 'fail') return 'token'
  return 'unknown'
}

/**
 * The problem a widget error names. Turnstile's codes: 110100 and 110110 an unknown site key, 110200
 * a hostname the widget does not list, 200500 the widget's frame did not load. hCaptcha reports
 * names (network-error and the like) and shows key problems in the widget itself.
 */
export function widgetProblem(code: string): SignupCaptchaProblem {
  const c = code.trim()
  if (c === '110200') return 'hostname'
  if (c === '110100' || c === '110110') return 'siteKey'
  if (c === '200500' || c === 'network-error') return 'widgetNetwork'
  return 'widget'
}

/** Sums over the last `days` UTC days, today included. */
export async function loadSignupCaptchaCounts(days = 7): Promise<SignupCaptchaCounts> {
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('signup_captcha_counts')
    .select('asked, passed, failed, unverified')
    .gte('day', since)
  if (error) throw error
  const totals: SignupCaptchaCounts = { asked: 0, passed: 0, failed: 0, unverified: 0 }
  for (const row of data ?? []) {
    totals.asked += Number(row.asked) || 0
    totals.passed += Number(row.passed) || 0
    totals.failed += Number(row.failed) || 0
    totals.unverified += Number(row.unverified) || 0
  }
  return totals
}
