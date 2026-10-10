/**
 * Binds the live reaction controller to the call transport, the voice roster,
 * the emoji caches and the viewer's settings.
 */

import { webrtcManager } from '@/services/webrtcManager';
import { VoiceSettingsService } from '@/services/VoiceSettingsService';
import { useUnifiedEmoji } from '@/services/unifiedEmojiService';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';
import { getEmojiUrl } from '@/utils/emojiUtils';
import { liveReactions, type LiveReactionDisplay } from './liveReactions';

interface VoiceRoster {
  localState: { userId: string };
  allUsers: ReadonlyArray<{ userId: string }>;
}

/** Requested image size, px; the layer draws custom emoji at 40 CSS px. */
const CUSTOM_EMOJI_SIZE = 96;

function customDisplay(id: string): { src: string; label: string } | null {
  const emoji = useEmojiCacheStore().getEmojiById(id);
  if (!emoji?.url) return null;
  const src = getEmojiUrl(emoji.url, CUSTOM_EMOJI_SIZE);
  return src ? { src, label: emoji.name } : null;
}

export function connectLiveReactions(roster: VoiceRoster): void {
  const { resolveEmoji } = useUnifiedEmoji();
  liveReactions.connect({
    publish: payload => webrtcManager.sendLiveReaction(payload),
    toWireId: userId => webrtcManager.liveReactionWireId(userId),
    fromWireId: wireId => webrtcManager.liveReactionUserId(wireId),
    localUserId: () => roster.localState.userId || null,
    isParticipant: userId => roster.allUsers.some(u => u.userId === userId),
    showOthers: () => VoiceSettingsService.getAll().showLiveReactions !== false,
    resolveUnicode: (value): LiveReactionDisplay => {
      const resolved = resolveEmoji(value);
      const label = resolved.shortcode?.replace(/_/g, ' ') ?? value;
      return resolved.display.type === 'svg'
        ? { kind: 'image', src: resolved.display.content, label }
        : { kind: 'text', text: resolved.display.content, label };
    },
    resolveCustom: customDisplay,
  });
}
