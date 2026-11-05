// Authenticator-app codes for journey users with two-factor on.

import { createHmac } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Page } from '@playwright/test'
import { userClient, type SpecUser } from './harness'

const STEP_MS = 30_000

// RFC 4648 base32.
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    const v = alphabet.indexOf(ch)
    if (v < 0) continue
    bits += v.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

export function currentStep(): number {
  return Math.floor(Date.now() / STEP_MS)
}

/** RFC 6238 TOTP: SHA-1, 30 s step, 6 digits, as GoTrue issues. */
export function totp(secret: string, step = currentStep()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = hmac[hmac.length - 1] & 0xf
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return code.toString().padStart(6, '0')
}

/** GoTrue refuses a code from a step that already verified; waits for the next one. */
export async function nextUnusedStep(page: Page, usedStep: number): Promise<number> {
  while (currentStep() <= usedStep) await page.waitForTimeout(1000)
  return currentStep()
}

export interface TotpUser {
  /** Signed in and verified: an aal2 session with a fresh TOTP step-up. */
  client: SupabaseClient
  factorId: string
  secret: string
  /** Last step whose code was accepted. */
  usedStep: number
}

/**
 * Enrols and verifies a TOTP factor for `user`. GoTrue (v2.196.0) keeps a unique index on
 * auth.mfa_factors.last_challenged_at; concurrent challenges of different users can collide
 * there (23505, answered 500), so a 500 is retried.
 */
export async function enrolTotp(user: SpecUser): Promise<TotpUser> {
  const client = await userClient(user)
  const { data: enrolled, error: enrollError } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'e2e' })
  if (enrollError || !enrolled) throw new Error(`mfa enroll ${user.username}: ${enrollError?.message}`)
  for (let attempt = 1; ; attempt++) {
    const usedStep = currentStep()
    const { error } = await client.auth.mfa.challengeAndVerify({
      factorId: enrolled.id,
      code: totp(enrolled.totp.secret, usedStep),
    })
    if (!error) return { client, factorId: enrolled.id, secret: enrolled.totp.secret, usedStep }
    if (error.status !== 500 || attempt === 3) throw new Error(`mfa verify ${user.username}: ${error.message}`)
    await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 300))
  }
}
