/** Reject reasons for public.consume_invite's refusal codes. */
export const INVITE_REFUSALS: Record<string, string> = {
  not_found: 'Invalid invite code',
  expired: 'Invite code has expired',
  exhausted: 'Invite code has reached maximum uses',
  revoked: 'Invite code has been revoked',
};
