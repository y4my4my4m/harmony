/**
 * Discord execute-webhook bodies as channel message text.
 *
 * https://discord.com/developers/docs/resources/webhook#execute-webhook. Read: content,
 * username, avatar_url, embeds, flags, and payload_json (the form-encoded wrapper of the
 * same fields). allowed_mentions, tts, components, attachments, poll and thread_name are
 * ignored: the message builder parses no mention, and files are not accepted. Embeds become
 * text: author, title and URL, description, fields, image URL, footer. Masked links
 * [label](url) become "label (<url>)", since chat text renders no masked link.
 */

/** Discord's MessageFlags.SUPPRESS_EMBEDS. */
export const SUPPRESS_EMBEDS = 1 << 2;

/** Discord embed limits, in characters. */
const LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, footer: 2048, author: 256 };
const MAX_EMBEDS = 10;
const MAX_FIELDS = 25;
/** Discord's limit on the sum of an embed set's text. */
const EMBED_TEXT_TOTAL = 6000;

export interface WebhookMessage {
  content: string;
  username?: string;
  avatarUrl?: string;
  suppressEmbeds: boolean;
}

/** Discord error body: JSON error codes from https://discord.com/developers/docs/topics/opcodes-and-status-codes. */
export interface WebhookError {
  status: number;
  body: { message: string; code?: number | string };
}

export type ParsedPayload = { ok: true; message: WebhookMessage } | { ok: false; error: WebhookError };

const invalid = (message: string): ParsedPayload => ({
  ok: false,
  error: { status: 400, body: { message, code: 50035 } },
});

function cut(value: string, n: number): string {
  const text = value.trim();
  return text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text;
}

function text(value: unknown, n: number): string {
  return typeof value === 'string' ? cut(value, n) : '';
}

function httpUrl(value: unknown): string {
  return typeof value === 'string' && /^https?:\/\/[^\s<>]+$/.test(value) && value.length <= 2048 ? value : '';
}

const MASKED_LINK = /\[([^\]\n]{1,256})\]\((https?:\/\/[^\s()<>]+)\)/g;

export function unmaskLinks(value: string): string {
  return value.replace(MASKED_LINK, (_m, label: string, url: string) =>
    label.trim() === url ? `<${url}>` : `${label} (<${url}>)`);
}

function flattenEmbed(embed: Record<string, any>): string {
  const lines: string[] = [];
  const author = text(embed.author?.name, LIMITS.author);
  if (author) lines.push(`*${author}*`);

  const title = text(embed.title, LIMITS.title);
  const url = httpUrl(embed.url);
  if (title || url) lines.push([title && `**${title}**`, url && `<${url}>`].filter(Boolean).join(' '));

  const description = text(embed.description, LIMITS.description);
  if (description) lines.push(description);

  const fields = Array.isArray(embed.fields) ? embed.fields.slice(0, MAX_FIELDS) : [];
  for (const field of fields) {
    if (!field || typeof field !== 'object') continue;
    const name = text(field.name, LIMITS.fieldName);
    const value = text(field.value, LIMITS.fieldValue);
    if (!name && !value) continue;
    if (field.inline === true && !value.includes('\n')) lines.push([name && `**${name}**:`, value].filter(Boolean).join(' '));
    else lines.push(...[name && `**${name}**`, value].filter(Boolean));
  }

  const image = httpUrl(embed.image?.url);
  if (image) lines.push(image);

  const footer = text(embed.footer?.text, LIMITS.footer);
  if (footer) lines.push(`*${footer}*`);

  return lines.join('\n');
}

/** Embeds as text, separated by blank lines, at most EMBED_TEXT_TOTAL characters. */
export function flattenEmbeds(embeds: unknown): string {
  if (!Array.isArray(embeds)) return '';
  const blocks = embeds
    .slice(0, MAX_EMBEDS)
    .filter((e): e is Record<string, any> => !!e && typeof e === 'object' && !Array.isArray(e))
    .map(flattenEmbed)
    .filter(Boolean);
  return cut(blocks.join('\n\n'), EMBED_TEXT_TOTAL);
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined | null {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : null;
}

/** The message a Discord execute-webhook body asks for. */
export function parseExecutePayload(input: unknown): ParsedPayload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: { status: 400, body: { message: 'Cannot send an empty message', code: 50006 } } };
  }
  let body = input as Record<string, unknown>;
  if (typeof body.payload_json === 'string') {
    try {
      const parsed = JSON.parse(body.payload_json);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid('payload_json is not an object');
      body = parsed as Record<string, unknown>;
    } catch {
      return invalid('payload_json is not valid JSON');
    }
  }

  const content = optionalString(body, 'content');
  const username = optionalString(body, 'username');
  const avatarUrl = optionalString(body, 'avatar_url');
  if (content === null) return invalid('content must be a string');
  if (username === null) return invalid('username must be a string');
  if (avatarUrl === null) return invalid('avatar_url must be a string');
  if (body.embeds !== undefined && body.embeds !== null && !Array.isArray(body.embeds)) {
    return invalid('embeds must be an array');
  }

  const flags = typeof body.flags === 'number' ? body.flags : Number(body.flags ?? 0);
  const combined = [content ?? '', flattenEmbeds(body.embeds)].filter((part) => part.trim() !== '').join('\n');
  if (!combined.trim()) {
    return { ok: false, error: { status: 400, body: { message: 'Cannot send an empty message', code: 50006 } } };
  }

  return {
    ok: true,
    message: {
      content: unmaskLinks(combined),
      username: username || undefined,
      avatarUrl: avatarUrl || undefined,
      suppressEmbeds: Number.isFinite(flags) && (flags & SUPPRESS_EMBEDS) !== 0,
    },
  };
}
