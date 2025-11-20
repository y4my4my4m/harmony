import type { EmbedPayload, Message, UrlContent } from '@/types';
import { linkPreviewService } from '@/services/LinkPreviewService';
import { normalizeEmbedUrl } from '@/utils/embedDetection';

type EmbedMetadata = Record<string, EmbedPayload>;

const processedMessages = new WeakSet<Message>();

interface EmbedOptions {
  force?: boolean;
}

export async function ensureMessageEmbeds(target: Message | Message[], options: EmbedOptions = {}): Promise<void> {
  const messages = Array.isArray(target) ? target : [target];
  const tasks: Promise<void>[] = [];

  for (const message of messages) {
    if (!Array.isArray(message.content) || message.content.length === 0) {
      continue;
    }

    if (!options.force && processedMessages.has(message)) {
      continue;
    }

    processedMessages.add(message);
    tasks.push(processMessageEmbeds(message));
  }

  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}

function ensureEmbedMetadata(message: Message): EmbedMetadata {
  if (!message.metadata) {
    message.metadata = {};
  }
  if (!message.metadata.embeds) {
    message.metadata.embeds = {};
  }
  return message.metadata.embeds as EmbedMetadata;
}

function isExpired(payload: EmbedPayload): boolean {
  if (!payload?.expiresAt) {
    return true;
  }
  return Date.now() >= new Date(payload.expiresAt).getTime();
}

async function processMessageEmbeds(message: Message): Promise<void> {
  const embedParts = message.content.filter(
    (part): part is UrlContent => part && typeof part === 'object' && part.type === 'url' && part.preview !== false,
  );

  if (embedParts.length === 0) {
    return;
  }

  const embeds = ensureEmbedMetadata(message);
  const activeEmbeds = new Set<string>();
  const fetchTasks: Promise<void>[] = [];

  for (const part of embedParts) {
    const normalizedUrl = normalizeEmbedUrl(part.url);
    if (!normalizedUrl) {
      continue;
    }

    const embedId = normalizedUrl;
    part.embedId = embedId;
    activeEmbeds.add(embedId);

    const existing = embeds[embedId];
    if (existing && !isExpired(existing)) {
      linkPreviewService.primeCache(existing);
      continue;
    }

    fetchTasks.push(
      linkPreviewService
        .getPreview(part.url)
        .then((payload) => {
          const finalId = payload.normalizedUrl || embedId;
          embeds[finalId] = payload;
          part.embedId = finalId;
          activeEmbeds.add(finalId);
          if (finalId !== embedId) {
            delete embeds[embedId];
          }
        })
        .catch((error) => {
          console.warn('Failed to load link preview:', error);
        }),
    );
  }

  if (fetchTasks.length > 0) {
    await Promise.allSettled(fetchTasks);
  }

  Object.keys(embeds).forEach(key => {
    if (!activeEmbeds.has(key)) {
      delete embeds[key];
    }
  });
}

