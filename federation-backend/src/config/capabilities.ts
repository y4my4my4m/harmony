/**
 * What this server supports beyond 1.8.12, listed by /instance-info for the native apps: one
 * app binary talks to any instance, and an instance updates only when its admin updates it. Each
 * capability names a feature whose RPCs, columns or routes the app needs; the app hides a feature
 * whose capability is absent. Servers before 1.9.0 list none.
 */
export const CAPABILITIES = [
  // Key relay and per-channel history visibility: fulfill_megolm_key_request,
  // get_relayable_key_requests, set_channel_history_visibility, channel_encryption_settings
  // .history_visibility (20261028100001, 20261028200001).
  'encrypted-history',
  // Outgoing webhooks and the instance's webhook settings: create_outgoing_webhook and the
  // admin_* webhook RPCs (20261028600001).
  'outgoing-webhooks',
  // create_channel's description, slowmode and encryption arguments (20261030700001).
  'channel-create-options',
  // profiles.instance_role, the staff role of a remote account on its own instance
  // (20261030100001).
  'instance-staff-roles',
  // The stickers table and bucket, create_sticker, update_sticker, delete_sticker and
  // create_report's p_reported_sticker_id (20261031200001).
  'custom-stickers',
  // Server directories: servers.federation_discoverable written through update_server,
  // GET /servers/directory, GET /directory/remote and /directory/peers (20261105100001).
  'server-directory',
  // The admin panel's invitations: /admin/invites and the admin_* invitation functions
  // (20261105980001).
  'instance-invites',
] as const;

export type Capability = (typeof CAPABILITIES)[number];
