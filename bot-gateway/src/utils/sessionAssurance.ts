/**
 * Mirrors public.session_meets_aal() (migration 20261005400001_account_security.sql): an
 * account with a verified factor is served only at aal2. The token has already been
 * verified by GoTrue; only its payload is read here.
 */
export function meetsAssurance(
  user: { factors?: Array<{ status?: string | null }> | null } | null | undefined,
  token: string,
): boolean {
  const enrolled = (user?.factors ?? []).some((factor) => factor?.status === 'verified')
  if (!enrolled) return true
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
    return claims?.aal === 'aal2'
  } catch {
    return false
  }
}
