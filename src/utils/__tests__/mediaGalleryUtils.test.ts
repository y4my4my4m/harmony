import { describe, expect, it } from 'vitest';
import type { MessagePart } from '@/types';
import {
  groupMediaGalleryParts,
  mediaGalleryLayoutClass,
} from '@/utils/mediaGalleryUtils';

describe('mediaGalleryLayoutClass', () => {
  it('uses message-media-gallery-count prefix to match component CSS', () => {
    expect(mediaGalleryLayoutClass(3)).toBe('message-media-gallery-count-3');
    expect(mediaGalleryLayoutClass(5)).toBe('message-media-gallery-count-5');
  });
});

describe('groupMediaGalleryParts', () => {
  it('groups consecutive image file parts into media_gallery', () => {
    const parts: MessagePart[] = [
      { type: 'file', url: 'https://cdn/a.png', fileType: 'image' } as MessagePart,
      { type: 'file', url: 'https://cdn/b.png', fileType: 'image' } as MessagePart,
      { type: 'file', url: 'https://cdn/c.png', fileType: 'image' } as MessagePart,
    ];
    const grouped = groupMediaGalleryParts(parts);
    expect(grouped).toHaveLength(1);
    expect((grouped[0] as { type: string }).type).toBe('media_gallery');
    expect((grouped[0] as { parts: MessagePart[] }).parts).toHaveLength(3);
  });

  it('skips whitespace-only text between media parts', () => {
    const parts: MessagePart[] = [
      { type: 'file', url: 'https://cdn/a.png', fileType: 'image' } as MessagePart,
      { type: 'text', text: '\n' } as MessagePart,
      { type: 'file', url: 'https://cdn/b.png', fileType: 'image' } as MessagePart,
    ];
    const grouped = groupMediaGalleryParts(parts);
    expect(grouped).toHaveLength(1);
    expect((grouped[0] as { type: string }).type).toBe('media_gallery');
    expect((grouped[0] as { parts: MessagePart[] }).parts).toHaveLength(2);
  });

  it('keeps a single image as a plain file part', () => {
    const parts: MessagePart[] = [
      { type: 'file', url: 'https://cdn/a.png', fileType: 'image' } as MessagePart,
    ];
    const grouped = groupMediaGalleryParts(parts);
    expect(grouped).toEqual(parts);
  });
});
