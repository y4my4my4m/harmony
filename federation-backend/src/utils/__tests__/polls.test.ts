import { describe, expect, it } from 'vitest';
import { mergeQuestionPoll, pollPartText, questionPollMetadata, withoutPollParts } from '../polls.js';

const NOW = Date.parse('2026-10-10T12:00:00Z');

const question = (over: Record<string, unknown> = {}) => ({
  type: 'Question',
  id: 'https://mastodon.test/users/alice/statuses/1',
  content: '<p>Tea or coffee?</p>',
  endTime: '2026-10-11T12:00:00Z',
  votersCount: 7,
  oneOf: [
    { type: 'Note', name: 'Tea', replies: { type: 'Collection', totalItems: 4 } },
    { type: 'Note', name: 'Coffee', replies: { type: 'Collection', totalItems: 3 } },
  ],
  ...over,
});

describe('questionPollMetadata', () => {
  it('reads a single-choice Question', () => {
    expect(questionPollMetadata(question(), NOW)).toEqual({
      is_poll: true,
      poll_options: [{ name: 'Tea', votes: 4 }, { name: 'Coffee', votes: 3 }],
      poll_multiple_choice: false,
      poll_end_time: '2026-10-11T12:00:00Z',
      poll_voters_count: 7,
      poll_closed: false,
    });
  });

  it('reads anyOf as multiple choice', () => {
    const meta = questionPollMetadata(question({
      oneOf: undefined,
      anyOf: [{ type: 'Note', name: 'A', replies: { totalItems: 2 } }, { type: 'Note', name: 'B' }],
    }), NOW);
    expect(meta.poll_multiple_choice).toBe(true);
    expect(meta.poll_options).toEqual([{ name: 'A', votes: 2 }, { name: 'B', votes: 0 }]);
  });

  it('is closed once `closed` is set or the end has passed', () => {
    expect(questionPollMetadata(question({ endTime: undefined, closed: '2026-10-10T11:00:00Z' }), NOW))
      .toMatchObject({ poll_closed: true, poll_end_time: '2026-10-10T11:00:00Z' });
    expect(questionPollMetadata(question({ endTime: '2026-10-10T11:59:00Z' }), NOW).poll_closed).toBe(true);
  });
});

describe('mergeQuestionPoll', () => {
  it('replaces the poll keys and keeps the rest', () => {
    const merged = mergeQuestionPoll(
      { embeds: { x: 1 }, custom_emojis: [{ name: 'blob' }], poll_voters_count: 1, poll_closed: false },
      question({ closed: '2026-10-10T11:00:00Z' }),
      NOW,
    );
    expect(merged).toMatchObject({
      embeds: { x: 1 },
      custom_emojis: [{ name: 'blob' }],
      poll_voters_count: 7,
      poll_closed: true,
    });
  });

  it('starts from nothing when there is no metadata', () => {
    expect(mergeQuestionPoll(null, question(), NOW).is_poll).toBe(true);
  });
});

describe('withoutPollParts', () => {
  const POLL = { type: 'poll', pollId: 'p1', question: 'Lunch?', options: ['Pizza', 'Sushi'] };

  it('drops poll parts and keeps the spelled-out text', () => {
    const text = { type: 'text', text: '📊 Lunch?\n1. Pizza\n2. Sushi' };
    expect(withoutPollParts([POLL, text])).toEqual([text]);
  });

  it('spells out a poll that has no text beside it', () => {
    expect(withoutPollParts([POLL])).toEqual([{ type: 'text', text: '📊 Lunch?\n1. Pizza\n2. Sushi' }]);
    expect(pollPartText({ question: 'Q' })).toBe('📊 Q');
  });

  it('leaves other content alone', () => {
    const content = [{ type: 'text', text: 'hi' }];
    expect(withoutPollParts(content)).toBe(content);
    expect(withoutPollParts('plain')).toBe('plain');
  });
});
