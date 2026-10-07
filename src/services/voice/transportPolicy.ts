/**
 * Call transport of a local room (voice channel, stage, DM call).
 *
 * An SFU client and a P2P client in one room neither hear nor see each other,
 * so the transport depends only on the instance's voice config
 * (GET /api/livekit/config), which every client reads alike. A client that
 * cannot use the selected transport fails its join.
 *
 *   mode     LiveKit configured   transport
 *   sfu      yes                  sfu
 *   sfu      no                   none (instance misconfigured)
 *   hybrid   yes                  sfu
 *   hybrid   no                   p2p
 *   p2p      either               p2p
 */

import type { LiveKitConfig } from '../livekitTokens';

export type CallTransport = 'sfu' | 'p2p';

export type TransportDecision =
  | { ok: true; transport: CallTransport }
  | { ok: false; reason: string };

export function isLiveKitConfigured(config: Pick<LiveKitConfig, 'enabled' | 'wsUrl'>): boolean {
  return config.enabled && !!config.wsUrl;
}

export function selectCallTransport(
  config: LiveKitConfig | null,
  opts: { requireE2EE: boolean },
): TransportDecision {
  if (!config) {
    return { ok: false, reason: 'The voice server settings could not be loaded. Try again in a moment.' };
  }

  let transport: CallTransport;
  if (config.mode === 'p2p') {
    transport = 'p2p';
  } else if (isLiveKitConfigured(config)) {
    transport = 'sfu';
  } else if (config.mode === 'sfu') {
    return { ok: false, reason: 'This instance requires its voice server (SFU), which is not configured.' };
  } else {
    transport = 'p2p';
  }

  if (transport === 'p2p' && opts.requireE2EE) {
    return { ok: false, reason: 'This channel requires end-to-end encrypted voice, which needs the voice server (SFU).' };
  }
  return { ok: true, transport };
}
