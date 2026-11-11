/**
 * Custom emoji drawn still, for a viewer who turned their animation off. Every emoji <img> in the
 * document shows its first frame: an image of the same bytes, drawn once to a canvas, replaces the
 * src after load. Display only; messages, reactions and other viewers are unaffected.
 *
 * A host answering without CORS headers taints the canvas, so its emoji keep animating. No image
 * can be read back from such a host; a proxy would be the only way.
 */

import { debug } from '@/utils/debug'

const EMOJI_IMG = 'img[class*="emoji"], img[src*="/emojis/"]'

// Unified pack and vector images have no frames.
const NEVER_ANIMATED = /^(?:data:|blob:)|^\/assets\/|\/assets\/.*\.svg(?:[?#]|$)|\.svg(?:[?#]|$)/i

// Discord's CDN serves the first frame of an animated emoji as its .png.
const DISCORD_ANIMATED = /^(https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/emojis\/\d+)\.(?:gif|webp)(?:[?#].*)?$/

const stills = new Map<string, Promise<string | null>>()
const originals = new WeakMap<HTMLImageElement, string>()

let active = false

function drawStill(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onerror = () => resolve(null)
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const context = canvas.getContext('2d')
        if (!context || !canvas.width || !canvas.height) {
          resolve(null)
          return
        }
        context.drawImage(img, 0, 0)
        canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null), 'image/png')
      } catch (err) {
        debug.warn('Still emoji failed:', err)
        resolve(null)
      }
    }
    img.src = src
  })
}

function stillOf(src: string): Promise<string | null> {
  let still = stills.get(src)
  if (!still) {
    const discord = DISCORD_ANIMATED.exec(src)
    still = discord ? Promise.resolve(`${discord[1]}.png`) : drawStill(src)
    stills.set(src, still)
  }
  return still
}

function isEmojiImage(el: EventTarget | null): el is HTMLImageElement {
  return el instanceof HTMLImageElement && el.matches(EMOJI_IMG)
}

// The element already shows a still; the load event of the swap lands here too.
function isStillSource(src: string): boolean {
  return /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/emojis\/\d+\.png(?:[?#].*)?$/.test(src)
}

async function freeze(img: HTMLImageElement): Promise<void> {
  const src = img.currentSrc || img.src
  if (!src || NEVER_ANIMATED.test(src) || NEVER_ANIMATED.test(img.getAttribute('src') ?? '') || isStillSource(src)) return
  const still = await stillOf(src)
  // The element was reused for another emoji, or the setting changed, while the still was drawn.
  if (!still || !active || (img.currentSrc || img.src) !== src) return
  originals.set(img, src)
  img.src = still
}

const onLoad = (event: Event) => {
  if (isEmojiImage(event.target)) void freeze(event.target)
}

/** On: every emoji image shows its first frame. Off: the images return to their sources. */
export function setEmojiStill(on: boolean): void {
  if (on === active || typeof document === 'undefined') return
  active = on
  if (on) {
    // A load event does not bubble, but it does capture.
    document.addEventListener('load', onLoad, true)
    document.querySelectorAll<HTMLImageElement>(EMOJI_IMG).forEach((img) => {
      if (img.complete) void freeze(img)
    })
    return
  }
  document.removeEventListener('load', onLoad, true)
  document.querySelectorAll<HTMLImageElement>(EMOJI_IMG).forEach((img) => {
    const original = originals.get(img)
    if (original) {
      originals.delete(img)
      img.src = original
    }
  })
}
