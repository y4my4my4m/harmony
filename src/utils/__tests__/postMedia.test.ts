import { describe, expect, it } from 'vitest'
import { galleryMedia, withoutGalleryMedia } from '@/utils/postMedia'

const imagePart = {
  type: 'file', url: 'https://files.remote.test/a.png', fileType: 'image', mimeType: 'image/png',
  fileName: 'a red square', altText: 'a red square', width: 640, height: 480,
}
const pdfPart = { type: 'file', url: 'https://files.remote.test/doc.pdf', fileType: 'file', mimeType: 'application/pdf' }
const text = { type: 'text', text: 'hello' }

describe('galleryMedia', () => {
  it('resolves federated Document rows by MIME type, audio included', () => {
    const media = galleryMedia({
      media_attachments: [
        { type: 'Document', mediaType: 'image/png', url: 'https://f.test/a.png', description: 'alt' },
        { type: 'Document', mediaType: 'audio/mpeg', url: 'https://f.test/b.mp3' },
        { type: 'Document', mediaType: 'application/octet-stream', url: 'https://f.test/c.webm' },
        { type: 'Image', mediaType: 'image/jpeg', url: 'https://f.test/d.jpg', name: 'd.jpg' },
      ],
    })
    expect(media.map((m) => m.type)).toEqual(['image', 'audio', 'video', 'image'])
    expect(media[0]).toMatchObject({ id: 'm-0', description: 'alt' })
  })

  it('takes media file parts of the content when media_attachments is empty', () => {
    expect(galleryMedia({ media_attachments: [], content: [text, imagePart, pdfPart] })).toEqual([
      expect.objectContaining({
        id: 'm-0', type: 'image', url: imagePart.url, mediaType: 'image/png', description: 'a red square',
        width: 640, height: 480,
      }),
    ])
  })

  it('prefers media_attachments over content parts', () => {
    const media = galleryMedia({
      media_attachments: [{ type: 'Document', mediaType: 'image/png', url: 'https://f.test/x.png' }],
      content: [imagePart],
    })
    expect(media.map((m) => m.url)).toEqual(['https://f.test/x.png'])
  })

  it('is empty for a post without media', () => {
    expect(galleryMedia({ content: [text, pdfPart] })).toEqual([])
    expect(galleryMedia(null)).toEqual([])
  })
})

describe('withoutGalleryMedia', () => {
  it('drops the parts the gallery shows and keeps the rest', () => {
    const content = [text, imagePart, pdfPart]
    expect(withoutGalleryMedia(content, galleryMedia({ content }))).toEqual([text, pdfPart])
  })

  it('drops a part whose URL path is a gallery URL on another host', () => {
    const media = galleryMedia({ media_attachments: [{ type: 'Image', url: 'https://cdn.test/files/a.png?x=1' }] })
    const link = { type: 'url', url: 'https://files.remote.test/files/a.png' }
    expect(withoutGalleryMedia([text, link], media)).toEqual([text])
  })

  it('returns the content unchanged without gallery media', () => {
    const content = [text, imagePart]
    expect(withoutGalleryMedia(content, [])).toBe(content)
  })
})
