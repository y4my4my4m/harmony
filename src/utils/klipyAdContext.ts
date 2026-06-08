/**
 * Klipy ad request context — device and slot dimensions for the ads API.
 *
 * Klipy recommends passing ad-min/max-width/height plus device targeting params
 * to maximize fill. See https://docs.klipy.com/advertisements/receiving-an-ad
 *
 * Note: Klipy documents ad delivery as mobile-only; desktop browsers may see
 * low or zero fill even with correct parameters.
 */

/** Max ad height per Klipy spec (device width × 250px). */
export const KLIPY_AD_MAX_HEIGHT = 250

/** Min ad dimension per Klipy spec. */
export const KLIPY_AD_MIN_SIZE = 50

/** Typical media-picker content width (popup is 400px minus padding). */
export const KLIPY_PICKER_SLOT_WIDTH = 384

export interface KlipyAdContext {
  /** Query params forwarded to the federation GIF proxy (underscore keys). */
  params: Record<string, string>
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function primaryLanguage(): string {
  const raw = navigator.language || 'en'
  const code = raw.split('-')[0]?.toLowerCase()
  return code && /^[a-z]{2}$/.test(code) ? code.toUpperCase() : 'EN'
}

/** OpenRTB-style connection type from the Network Information API. */
function connectionType(): number | undefined {
  const conn = (navigator as Navigator & { connection?: { type?: string; effectiveType?: string } })
    .connection
  if (!conn) return undefined
  if (conn.type === 'ethernet') return 1
  if (conn.type === 'wifi') return 2
  if (conn.type === 'cellular') {
    switch (conn.effectiveType) {
      case 'slow-2g':
      case '2g':
        return 4
      case '3g':
        return 5
      case '4g':
        return 6
      case '5g':
        return 7
      default:
        return 3
    }
  }
  return 0
}

function detectDevice(): { os?: string; osv?: string; make?: string; model?: string } {
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/i.test(ua)) {
    const osv = ua.match(/OS (\d+[._]\d+)/)?.[1]?.replace('_', '.')
    return {
      os: 'ios',
      osv,
      make: 'apple',
      model: /iPad/i.test(ua) ? 'ipad' : 'iphone',
    }
  }
  if (/Android/i.test(ua)) {
    const osv = ua.match(/Android (\d+(?:\.\d+)?)/)?.[1]
    const model = ua.match(/;\s*([^;)]+)\s+Build\//)?.[1]?.trim()
    return { os: 'android', osv, make: 'android', model: model || 'android' }
  }
  if (/Windows/i.test(ua)) return { os: 'windows', make: 'microsoft', model: 'pc' }
  if (/Macintosh|Mac OS/i.test(ua)) return { os: 'macos', make: 'apple', model: 'mac' }
  if (/Linux/i.test(ua)) return { os: 'linux', model: 'pc' }
  return {}
}

/**
 * Build Klipy ad query params for GIF feed requests.
 *
 * @param slotWidth - Width available for rendering an ad tile (picker column or
 *   full strip). Defaults to picker content width or viewport, whichever is smaller.
 */
export function collectKlipyAdContext(slotWidth?: number): KlipyAdContext {
  const deviceW = clampInt(window.screen?.width ?? window.innerWidth, 50, 4096)
  const deviceH = clampInt(window.screen?.height ?? window.innerHeight, 50, 4096)
  const viewportW = clampInt(window.innerWidth, KLIPY_AD_MIN_SIZE, deviceW)
  const resolvedSlot = clampInt(
    slotWidth ?? Math.min(KLIPY_PICKER_SLOT_WIDTH, viewportW),
    KLIPY_AD_MIN_SIZE,
    viewportW,
  )

  const params: Record<string, string> = {
    ad_min_width: String(KLIPY_AD_MIN_SIZE),
    // Request sizes we can actually render; Klipy matches inventory to these bounds.
    ad_max_width: String(resolvedSlot),
    ad_min_height: String(KLIPY_AD_MIN_SIZE),
    ad_max_height: String(KLIPY_AD_MAX_HEIGHT),
    ad_device_w: String(deviceW),
    ad_device_h: String(deviceH),
    ad_pxratio: String(window.devicePixelRatio || 1),
    ad_language: primaryLanguage(),
  }

  const device = detectDevice()
  if (device.os) params.ad_os = device.os
  if (device.osv) params.ad_osv = device.osv
  if (device.make) params.ad_make = device.make
  if (device.model) params.ad_model = device.model.slice(0, 64)

  const conn = connectionType()
  if (conn !== undefined) params.ad_connection_type = String(conn)

  return { params }
}
