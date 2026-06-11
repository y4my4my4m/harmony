import { describe, expect, it } from 'vitest';
import type { MessagePart } from '@/types';
import {
  hasSubstantiveMessageContent,
  removeFilePartByUrl,
} from '@/utils/messageContentUtils';

describe('removeFilePartByUrl', () => {
  it('removes only the matching file part', () => {
    const parts: MessagePart[] = [
      { type: 'text', text: 'hello' } as MessagePart,
      { type: 'file', url: 'https://cdn/a.png', fileType: 'image' } as MessagePart,
      { type: 'file', url: 'https://cdn/b.png', fileType: 'image' } as MessagePart,
    ];
    const result = removeFilePartByUrl(parts, 'https://cdn/a.png');
    expect(result).toHaveLength(2);
    expect(result.some((p) => p.type === 'file' && (p as { url: string }).url.includes('a.png'))).toBe(false);
  });
});

describe('hasSubstantiveMessageContent', () => {
  it('returns false for empty text-only content', () => {
    expect(hasSubstantiveMessageContent([{ type: 'text', text: '   ' } as MessagePart])).toBe(false);
  });

  it('returns true when text or files remain', () => {
    expect(hasSubstantiveMessageContent([{ type: 'text', text: 'hi' } as MessagePart])).toBe(true);
    expect(hasSubstantiveMessageContent([{ type: 'file', url: 'x', fileType: 'image' } as MessagePart])).toBe(true);
  });
});
