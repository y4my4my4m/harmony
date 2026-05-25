const BADGE_SIZE_RATIO = 0.45
const BADGE_FONT_RATIO = 0.55
const BADGE_COLOR = '#ED4245'
const BADGE_TEXT_COLOR = '#FFFFFF'

let originalFaviconHref: string | null = null
let originalFaviconElement: HTMLLinkElement | null = null
let cachedImage: HTMLImageElement | null = null
let currentCount = 0

function getMainFavicon(): HTMLLinkElement | null {
  return document.querySelector('link[rel="icon"][sizes="32x32"]')
    || document.querySelector('link[rel="icon"]')
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

function drawBadge(img: HTMLImageElement, count: number): string {
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!

  ctx.drawImage(img, 0, 0, size, size)

  if (count <= 0) return canvas.toDataURL('image/png')

  const badgeRadius = (size * BADGE_SIZE_RATIO) / 2
  const label = count > 99 ? '99+' : String(count)
  const fontSize = Math.round(badgeRadius * BADGE_FONT_RATIO * 2)
  const isWide = label.length > 2

  const pillWidth = isWide ? badgeRadius * 2.4 : badgeRadius * 2
  const pillHeight = badgeRadius * 2
  const cx = size - (pillWidth / 2) - 1
  const cy = pillHeight / 2 + 1

  ctx.beginPath()
  if (isWide) {
    const r = pillHeight / 2
    ctx.moveTo(cx - pillWidth / 2 + r, cy - r)
    ctx.arcTo(cx + pillWidth / 2, cy - r, cx + pillWidth / 2, cy + r, r)
    ctx.arcTo(cx + pillWidth / 2, cy + r, cx - pillWidth / 2, cy + r, r)
    ctx.arcTo(cx - pillWidth / 2, cy + r, cx - pillWidth / 2, cy - r, r)
    ctx.arcTo(cx - pillWidth / 2, cy - r, cx + pillWidth / 2, cy - r, r)
  } else {
    ctx.arc(cx, cy, badgeRadius, 0, 2 * Math.PI)
  }
  ctx.fillStyle = BADGE_COLOR
  ctx.fill()

  ctx.fillStyle = BADGE_TEXT_COLOR
  ctx.font = `bold ${fontSize}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, cx, cy + 1)

  return canvas.toDataURL('image/png')
}

export async function updateFaviconBadge(count: number): Promise<void> {
  if (typeof document === 'undefined') return
  if (count === currentCount) return
  currentCount = count

  try {
    const favicon = getMainFavicon()
    if (!favicon) return

    if (!originalFaviconHref) {
      originalFaviconHref = favicon.href
      originalFaviconElement = favicon
    }

    if (count <= 0) {
      favicon.href = originalFaviconHref
      cachedImage = null
      return
    }

    if (!cachedImage) {
      cachedImage = await loadImage(originalFaviconHref)
    }

    favicon.href = drawBadge(cachedImage, count)
  } catch {
    // Silently fail - favicon badge is non-critical
  }
}
