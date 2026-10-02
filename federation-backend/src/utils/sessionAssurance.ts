/**
 * Assurance checks on a Supabase access token that GoTrue has already verified.
 *
 * Mirrors public.session_meets_aal() and public.enforce_request_assurance() in
 * db_schema/migrations/20261005400001_account_security.sql: an account with a verified
 * factor is served only at aal2. GoTrue keeps a session at aal2 once verified, so an aal1
 * token of an enrolled account is a sign-in that has not completed its challenge.
 */

interface FactorLike {
  status?: string | null;
}

interface UserLike {
  factors?: FactorLike[] | null;
}

/** JWT payload claims; null when the token does not decode. The signature is not checked. */
export function decodeClaims(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

/** False for an account with a verified factor whose token is below aal2. */
export function meetsAssurance(user: UserLike | null | undefined, token: string | null | undefined): boolean {
  const enrolled = (user?.factors ?? []).some((factor) => factor?.status === 'verified');
  if (!enrolled) return true;
  return decodeClaims(token)?.aal === 'aal2';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** auth.sessions id the token belongs to; null for tokens without one (service keys). */
export function sessionIdFromToken(token: string | null | undefined): string | null {
  const sid = decodeClaims(token)?.session_id;
  return typeof sid === 'string' && UUID.test(sid) ? sid : null;
}

/** Token part of an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.substring(7).trim();
  return token || null;
}
