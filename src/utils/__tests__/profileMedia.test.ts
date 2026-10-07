import { describe, expect, it } from 'vitest'
import {
  buildLightboxSequence,
  formatMediaDuration,
  mergeProfileMediaTiles,
  normalizeAttachment,
  normalizeContentPart,
  profileMediaCursor,
  toLightboxAttachment,
  toProfileMediaTile,
  toProfileMediaTiles,
  type ProfileMediaRow,
  type ProfileMediaTile,
} from '@/utils/profileMedia'

function row(over: Partial<ProfileMediaRow> & { id: string }): ProfileMediaRow {
  return {
    created_at: '2026-09-01T12:00:00Z',
    visibility: 'public',
    content_warning: null,
    is_sensitive: false,
    media_attachments: [],
    content_media: [],
    ...over,
  }
}

describe('normalizeAttachment', () => {
  it('reads composer rows without taking the file name as alt text', () => {
    const item = normalizeAttachment({ type: 'Image', url: 'https://h/a.jpg', mediaType: 'image/jpeg', name: 'IMG_0001.jpg' })
    expect(item).toMatchObject({ kind: 'image', isVideoFile: false, alt: '', mimeType: 'image/jpeg' })
  })

  it('takes description as alt text', () => {
    expect(normalizeAttachment({ type: 'Image', url: 'https://h/a.jpg', mediaType: 'image/jpeg', description: 'a cat' })?.alt).toBe('a cat')
  })

  it('marks image/gif as a GIF rendered as an image', () => {
    expect(normalizeAttachment({ type: 'Image', url: 'https://h/a.gif', mediaType: 'image/gif' })).toMatchObject({ kind: 'gif', isVideoFile: false })
  })

  it('marks Mastodon gifv as a GIF rendered as a video, keeping preview and duration', () => {
    const item = normalizeAttachment({
      type: 'gifv', url: 'https://m/a.mp4', preview_url: 'https://m/a.png', meta: { original: { duration: 3.2 } },
    })
    expect(item).toMatchObject({ kind: 'gif', isVideoFile: true, previewUrl: 'https://m/a.png', duration: 3.2 })
  })

  it('reads video by MIME type on Document rows from outbox imports', () => {
    expect(normalizeAttachment({ type: 'Document', url: 'https://r/v', mediaType: 'video/mp4' })).toMatchObject({ kind: 'video', isVideoFile: true })
  })

  it('falls back to the URL extension for untyped documents', () => {
    expect(normalizeAttachment({ type: 'Document', url: 'https://r/a.JPG?sig=1', mediaType: 'application/octet-stream' })?.kind).toBe('image')
    expect(normalizeAttachment({ type: 'Document', url: 'https://r/a.pdf', mediaType: 'application/octet-stream' })).toBeNull()
  })

  it('drops audio, missing URLs and junk', () => {
    expect(normalizeAttachment({ type: 'Audio', url: 'https://h/a.mp4', mediaType: 'video/mp4' })).toBeNull()
    expect(normalizeAttachment({ type: 'Image', mediaType: 'image/png' })).toBeNull()
    expect(normalizeAttachment(null)).toBeNull()
    expect(normalizeAttachment('https://h/a.png')).toBeNull()
  })
})

describe('normalizeContentPart', () => {
  it('reads federated file parts with alt text', () => {
    expect(normalizeContentPart({ type: 'file', fileType: 'image', url: 'https://r/a.png', mimeType: 'image/png', altText: 'a dog' }))
      .toMatchObject({ kind: 'image', isVideoFile: false, alt: 'a dog' })
  })

  it('marks GIF file parts', () => {
    expect(normalizeContentPart({ type: 'file', fileType: 'image', url: 'https://r/a.gif' })?.kind).toBe('gif')
  })

  it('reads video file parts', () => {
    expect(normalizeContentPart({ type: 'file', fileType: 'video', url: 'https://r/a.webm' })).toMatchObject({ kind: 'video', isVideoFile: true })
  })

  it('ignores audio, plain files and non-file parts', () => {
    expect(normalizeContentPart({ type: 'file', fileType: 'audio', url: 'https://r/a.mp3' })).toBeNull()
    expect(normalizeContentPart({ type: 'file', fileType: 'file', url: 'https://r/a.zip' })).toBeNull()
    expect(normalizeContentPart({ type: 'url', url: 'https://r/a.png' })).toBeNull()
  })
})

describe('toProfileMediaTile', () => {
  it('merges attachments and content parts, dedupes by URL and keeps the first alt text found', () => {
    const tile = toProfileMediaTile(row({
      id: 'p1',
      media_attachments: [
        { type: 'Document', url: 'https://r/1.png', mediaType: 'image/png', name: 'alt from name' },
        { type: 'Document', url: 'https://r/2.mp4', mediaType: 'video/mp4' },
      ],
      content_media: [
        { type: 'file', fileType: 'image', url: 'https://r/1.png', altText: 'alt one' },
        { type: 'file', fileType: 'video', url: 'https://r/2.mp4' },
        { type: 'file', fileType: 'image', url: 'https://r/3.png' },
      ],
    }))
    expect(tile?.items.map((i) => i.url)).toEqual(['https://r/1.png', 'https://r/2.mp4', 'https://r/3.png'])
    expect(tile?.items[0].alt).toBe('alt one')
  })

  it('treats a URL differing only by fragment as the same attachment', () => {
    const tile = toProfileMediaTile(row({
      id: 'p1',
      media_attachments: [{ type: 'Image', url: 'https://h/a.png#x', mediaType: 'image/png' }],
      content_media: [{ type: 'file', fileType: 'image', url: 'https://h/a.png' }],
    }))
    expect(tile?.items).toHaveLength(1)
  })

  it('is sensitive when flagged or when a content warning is present', () => {
    const media = [{ type: 'Image', url: 'https://h/a.png', mediaType: 'image/png' }]
    expect(toProfileMediaTile(row({ id: 'a', media_attachments: media, is_sensitive: true }))?.sensitive).toBe(true)
    const cw = toProfileMediaTile(row({ id: 'b', media_attachments: media, content_warning: '  spoilers ' }))
    expect(cw).toMatchObject({ sensitive: true, contentWarning: 'spoilers' })
    expect(toProfileMediaTile(row({ id: 'c', media_attachments: media, content_warning: '   ' }))?.sensitive).toBe(false)
  })

  it('returns null when nothing normalizes', () => {
    expect(toProfileMediaTile(row({ id: 'x', media_attachments: [{ type: 'Audio', url: 'https://h/a.mp3' }] }))).toBeNull()
    expect(toProfileMediaTile(row({ id: 'y', media_attachments: null, content_media: 'nope' }))).toBeNull()
  })
})

describe('paging', () => {
  const rows: ProfileMediaRow[] = [
    row({ id: 'b', created_at: '2026-09-01T12:00:00Z', media_attachments: [{ type: 'Image', url: 'https://h/b.png', mediaType: 'image/png' }] }),
    row({ id: 'a', created_at: '2026-09-01T12:00:00Z', media_attachments: [{ type: 'Image', url: 'https://h/a.png', mediaType: 'image/png' }] }),
    row({ id: 'z', created_at: '2026-09-01T11:00:00Z', media_attachments: [{ type: 'Audio', url: 'https://h/z.mp3' }] }),
  ]

  it('takes the cursor from the last row, including one that produced no tile', () => {
    expect(toProfileMediaTiles(rows).map((t) => t.postId)).toEqual(['b', 'a'])
    expect(profileMediaCursor(rows)).toEqual({ createdAt: '2026-09-01T11:00:00Z', postId: 'z' })
    expect(profileMediaCursor([])).toBeNull()
  })

  it('merges pages without duplicates, newest first with id DESC on ties', () => {
    const first = toProfileMediaTiles(rows.slice(0, 1))
    const second = toProfileMediaTiles([
      rows[1],
      rows[0],
      row({ id: 'c', created_at: '2026-09-01T10:00:00Z', media_attachments: [{ type: 'Image', url: 'https://h/c.png', mediaType: 'image/png' }] }),
    ])
    expect(mergeProfileMediaTiles(first, second).map((t) => t.postId)).toEqual(['b', 'a', 'c'])
  })

  it('returns the same array when a page adds nothing', () => {
    const tiles = toProfileMediaTiles(rows)
    expect(mergeProfileMediaTiles(tiles, tiles)).toBe(tiles)
  })
})

describe('buildLightboxSequence', () => {
  const tiles: ProfileMediaTile[] = toProfileMediaTiles([
    row({
      id: 'p1',
      media_attachments: [
        { type: 'Image', url: 'https://h/1a.png', mediaType: 'image/png' },
        { type: 'Image', url: 'https://h/1b.png', mediaType: 'image/png' },
      ],
    }),
    row({ id: 'p2', is_sensitive: true, media_attachments: [{ type: 'Image', url: 'https://h/2.png', mediaType: 'image/png' }] }),
    row({ id: 'p3', media_attachments: [{ type: 'gifv', url: 'https://h/3.mp4' }] }),
  ])

  it('flattens every item across tiles in grid order and skips hidden tiles', () => {
    const { entries, startByPostId } = buildLightboxSequence(tiles, (t) => t.sensitive)
    expect(entries.map((e) => e.item.url)).toEqual(['https://h/1a.png', 'https://h/1b.png', 'https://h/3.mp4'])
    expect(startByPostId.get('p1')).toBe(0)
    expect(startByPostId.get('p3')).toBe(2)
    expect(startByPostId.has('p2')).toBe(false)
  })

  it('includes a sensitive tile once revealed', () => {
    const { entries, startByPostId } = buildLightboxSequence(tiles, () => false)
    expect(entries).toHaveLength(4)
    expect(startByPostId.get('p2')).toBe(2)
  })

  it('maps entries to lightbox attachments', () => {
    const { entries } = buildLightboxSequence(tiles, () => false)
    expect(toLightboxAttachment(entries[3], 3)).toMatchObject({ id: 'p3:3', type: 'gifv', url: 'https://h/3.mp4' })
    expect(toLightboxAttachment(entries[0], 0)).toMatchObject({ type: 'image', description: undefined })
  })
})

describe('formatMediaDuration', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatMediaDuration(7.4)).toBe('0:07')
    expect(formatMediaDuration(65)).toBe('1:05')
    expect(formatMediaDuration(3725)).toBe('1:02:05')
  })

  it('returns null for missing or invalid values', () => {
    expect(formatMediaDuration(null)).toBeNull()
    expect(formatMediaDuration(0)).toBeNull()
    expect(formatMediaDuration(Number.NaN)).toBeNull()
    expect(formatMediaDuration(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('focal points', () => {
  it('positions tiles from composer meta.focus and from content part focalPoint', () => {
    expect(normalizeAttachment({ type: 'Image', url: 'https://h/a.jpg', mediaType: 'image/jpeg', meta: { focus: { x: 0.5, y: 0.5 } } })?.objectPosition)
      .toBe('75% 25%')
    expect(normalizeContentPart({ type: 'file', fileType: 'image', url: 'https://r/1.png', focalPoint: [-0.5, -1] })?.objectPosition)
      .toBe('25% 100%')
    expect(normalizeAttachment({ type: 'Image', url: 'https://h/a.jpg', mediaType: 'image/jpeg' })?.objectPosition).toBeNull()
  })

  it('takes the focal point from a duplicate when the first entry has none', () => {
    const tile = toProfileMediaTile(row({
      id: 'p1',
      media_attachments: [{ type: 'Document', url: 'https://r/1.png', mediaType: 'image/png' }],
      content_media: [{ type: 'file', fileType: 'image', url: 'https://r/1.png', focalPoint: [1, 1] }],
    }))
    expect(tile?.items[0].objectPosition).toBe('100% 0%')
  })
})
