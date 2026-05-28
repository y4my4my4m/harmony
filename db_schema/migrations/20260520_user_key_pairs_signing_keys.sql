-- ---------------------------------------------------------------------------
-- Per-user ECDSA P-256 signing keys for Megolm sender binding.
--
-- Why: today `messages.encryption_metadata.sender_user_id` is plaintext JSON
-- that any DB writer (or compromised server) can swap. Clients trust it for
-- both display and key lookup, so reattribution is trivial. Adding a signing
-- key per user lets the sender produce an ECDSA signature over a canonical
-- encoding of (room_id, session_id, message_index, ciphertext, sender_user_id,
-- timestamp); recipients verify before decrypt and reject mismatches.
--
-- Storage layout:
--   - identity_signing_public_key:      base64(SPKI(ECDSA P-256 public))
--   - identity_signing_private_key_encrypted: base64(IV || AES-GCM(privKey))
--     where the wrapping key is the user's recovery-key-derived `encryptionKey`
--     (same scheme as identity_private_key_encrypted, so recovery still works).
--
-- Backwards compatibility: columns are nullable. Existing rows have NULL
-- signing keys; the client generates them lazily on next unlock and writes
-- back. Until that happens, those users' new messages will be flagged
-- `unverified` by the client (fail-soft for legacy users, fail-closed for
-- anyone who already has a signing key on record).
-- ---------------------------------------------------------------------------
BEGIN;

ALTER TABLE public.user_key_pairs
    ADD COLUMN IF NOT EXISTS identity_signing_public_key text;
ALTER TABLE public.user_key_pairs
    ADD COLUMN IF NOT EXISTS identity_signing_private_key_encrypted text;

COMMENT ON COLUMN public.user_key_pairs.identity_signing_public_key IS
    'Base64-encoded SPKI of the user''s ECDSA P-256 signing public key. Used to verify per-message sender signatures. NULL means the device has not yet enrolled a signing key (legacy).';
COMMENT ON COLUMN public.user_key_pairs.identity_signing_private_key_encrypted IS
    'Base64(IV || AES-GCM(PKCS#8 ECDSA P-256 private key)) wrapped with the user''s recovery-derived encryption key. Server cannot read; only the user with the recovery key can unwrap.';

-- The existing `idx_user_key_pairs_active` partial index covers
-- (user_id, is_active) which is exactly the lookup we need for batch signing
-- public key fetches; no new index required.

-- Re-export schema to PostgREST so the new columns are queryable.
NOTIFY pgrst, 'reload schema';

COMMIT;
