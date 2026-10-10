/**
 * Polls over federation.
 *
 * Fediverse polls arrive as ActivityPub Question objects (Mastodon's shape): answers in
 * oneOf (single choice) or anyOf (multiple choice), each a Note with `name` and
 * `replies.totalItems` votes; `votersCount` (toot:votersCount); `endTime`; `closed`, the
 * time it closed. They are kept on posts.metadata:
 *   is_poll, poll_options [{ name, votes }], poll_multiple_choice, poll_end_time,
 *   poll_voters_count, poll_closed
 *
 * Harmony chat polls (message_polls) do not federate: a poll message's `poll` part names a
 * row of this instance only. Its text part spells the poll out for other instances.
 */

export interface QuestionPollMetadata {
  is_poll: true;
  poll_options: Array<{ name: string; votes: number }>;
  poll_multiple_choice: boolean;
  poll_end_time: string | null;
  poll_voters_count: number;
  poll_closed: boolean;
}

const count = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** posts.metadata poll keys for a Question. */
export function questionPollMetadata(object: any, now: number = Date.now()): QuestionPollMetadata {
  const multiple = Array.isArray(object?.anyOf);
  const answers: any[] = (multiple ? object.anyOf : object?.oneOf) ?? [];
  const options = (Array.isArray(answers) ? answers : [])
    .filter((option) => option && typeof option === 'object' && (option.type === 'Note' || option.type === undefined))
    .map((option) => ({
      name: typeof option.name === 'string' ? option.name : '',
      votes: count(option.replies?.totalItems),
    }));

  const closedAt = typeof object?.closed === 'string' ? object.closed : null;
  const endTime = typeof object?.endTime === 'string' ? object.endTime : closedAt;
  const end = endTime ? Date.parse(endTime) : NaN;

  return {
    is_poll: true,
    poll_options: options,
    poll_multiple_choice: multiple,
    poll_end_time: endTime,
    poll_voters_count: count(object?.votersCount),
    poll_closed: object?.closed === true || closedAt !== null || (!Number.isNaN(end) && end <= now),
  };
}

/** existing metadata with the Question's poll keys replaced; every other key is kept. */
export function mergeQuestionPoll(existing: unknown, object: any, now: number = Date.now()): Record<string, any> {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? (existing as Record<string, any>)
    : {};
  return { ...base, ...questionPollMetadata(object, now) };
}

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
