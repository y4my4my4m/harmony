/**
 * Harmony chat polls (message_polls) do not federate: a poll message's `poll` part names a
 * row of this instance only. Its text part spells the poll out for other instances.
 */

const isPollPart = (part: unknown): boolean =>
  !!part && typeof part === 'object' && (part as any).type === 'poll';

/** The text create_message_poll writes beside a poll part: "📊 question\n1. answer\n2. answer". */
export function pollPartText(part: any): string {
  const question = typeof part?.question === 'string' ? part.question : '';
  const answers: string[] = Array.isArray(part?.options) ? part.options.filter((o: unknown) => typeof o === 'string') : [];
  return [`📊 ${question}`, ...answers.map((a, i) => `${i + 1}. ${a}`)].join('\n');
}

/**
 * Content without `poll` parts. Content that would be left empty keeps the polls as text
 * parts; messages_content_not_empty refuses an empty array.
 */
export function withoutPollParts<T>(content: T): T {
  if (!Array.isArray(content) || !content.some(isPollPart)) return content;
  const rest = content.filter((part) => !isPollPart(part));
  if (rest.length > 0) return rest as T;
  return content.map((part) => ({ type: 'text', text: pollPartText(part) })) as T;
}
