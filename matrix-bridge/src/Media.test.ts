import { describe, expect, it } from 'vitest';
import { isInlineImage, mediaContentType, mediaName } from './Media.js';

describe('media metadata', () => {
  it('keeps Unicode display names without paths, controls or malformed surrogate pairs', () => {
    expect(mediaName('  folder/写真\\image\r\n.png\u202e  ')).toBe('folder_写真_image__.png_');
    for (const value of [null, {}, '', '.', '..']) expect(mediaName(value)).toBe('attachment');
    for (const value of ['x'.repeat(199) + '🌊', '\ud800', '🌊'.repeat(200)]) expect(() => encodeURIComponent(mediaName(value))).not.toThrow();
    expect(mediaName('x'.repeat(300))).toHaveLength(200);
  });

  it('normalizes MIME metadata without accepting header injection', () => {
    expect(mediaContentType(' Image/PNG; charset=binary ')).toBe('image/png');
    for (const value of [null, {}, 'image/png\r\nSECRET', 'invalid', 'x/'.repeat(100)]) expect(mediaContentType(value)).toBe('application/octet-stream');
    expect(isInlineImage('image/png')).toBe(true);
    for (const value of ['image/svg+xml', 'audio/ogg', 'video/mp4', 'application/pdf']) expect(isInlineImage(value)).toBe(false);
  });
});
