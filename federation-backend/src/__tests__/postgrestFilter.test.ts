import { describe, it, expect } from 'vitest';
import { pgrstEscape, pgrstOrValue } from '../utils/postgrestFilter.js';

describe('pgrstEscape', () => {
  it('passes plain values through', () => {
    expect(pgrstEscape('https://remote.test/users/alice')).toBe('https://remote.test/users/alice');
  });

  it('escapes double quotes', () => {
    expect(pgrstEscape('a"b')).toBe('a\\"b');
  });

  it('escapes backslashes before quotes', () => {
    expect(pgrstEscape('a\\"b')).toBe('a\\\\\\"b');
  });
});

describe('pgrstOrValue', () => {
  it('wraps values in double quotes', () => {
    expect(pgrstOrValue('https://remote.test/posts/1')).toBe('"https://remote.test/posts/1"');
  });

  it('neutralizes or-tree breakout attempts', () => {
    const hostile = 'x,is_deleted.eq.false)';
    expect(pgrstOrValue(hostile)).toBe('"x,is_deleted.eq.false)"');
  });

  it('neutralizes quote breakout attempts', () => {
    expect(pgrstOrValue('x",url.eq."y')).toBe('"x\\",url.eq.\\"y"');
  });
});
