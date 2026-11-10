export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

export interface MediaFile { bytes: Buffer; name: string; contentType: string }
export interface MatrixFile { mxc: string; name: string; contentType: string; size: number }

/** Display names are never paths, headers, or bidirectional control sequences. */
export function mediaName(value: unknown): string {
  const name = typeof value === 'string' ? Buffer.from(value, 'utf8').toString('utf8')
    .replace(/[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_').trim().slice(0, 200).replace(/[\ud800-\udbff]$/, '') : '';
  return !name || name === '.' || name === '..' ? 'attachment' : name;
}

export function mediaContentType(value: unknown): string {
  const type = typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
  return type.length <= 127 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : 'application/octet-stream';
}

export function isInlineImage(contentType: string): boolean {
  return ['image/png', 'image/apng', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(contentType);
}
