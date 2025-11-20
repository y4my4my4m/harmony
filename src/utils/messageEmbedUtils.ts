import type { Message } from '@/types';
import { normalizeEmbedUrl } from '@/utils/embedDetection';

export function ensureMessageEmbeds(target: Message | Message[]): void {
  const messages = Array.isArray(target) ? target : [target];

  for (const message of messages) {
    if (!Array.isArray(message.content) || message.content.length === 0) {
      continue;
    }

    const embeds = message.metadata?.embeds;
    if (!embeds || typeof embeds !== 'object') {
      continue;
    }

    for (const part of message.content) {
      if (!part || typeof part !== 'object' || part.type !== 'url' || part.preview === false) {
        continue;
      }

      const normalized = normalizeEmbedUrl(part.url);
      if (!normalized) {
        continue;
      }

      if ((embeds as Record<string, unknown>)[normalized]) {
        part.embedId = normalized;
      }
    }
  }
}

