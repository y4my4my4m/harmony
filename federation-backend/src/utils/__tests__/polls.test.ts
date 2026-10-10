import { describe, expect, it } from 'vitest';
import { pollPartText, withoutPollParts } from '../polls.js';

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
