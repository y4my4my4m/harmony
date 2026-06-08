/**
 * Klipy ad HTML includes its own `.ad` disclosure badge inside the blob.
 * Harmony renders a clearer label outside the sandboxed iframe instead.
 */

const KLIPY_AD_FRAME_STYLES = `<style>
html,body{margin:0!important;padding:0!important;background:transparent!important;overflow:hidden!important;width:100%!important;height:100%!important}
.ad,[class~="ad"]{display:none!important;visibility:hidden!important;height:0!important;width:0!important;overflow:hidden!important;pointer-events:none!important}
</style>`

/** Strip Klipy's redundant in-html disclosure badge (class contains "ad"). */
function stripKlipyAdBadgeDiv(html: string): string {
  return html.replace(/<div\b[^>]*\bclass=["'][^"']*\bad\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '')
}

/** Prepare Klipy ad HTML for iframe srcdoc. */
export function prepareKlipyAdHtml(content: string): string {
  if (!content) return content
  let html = stripKlipyAdBadgeDiv(content)
  if (!html.includes(KLIPY_AD_FRAME_STYLES)) {
    html = `${KLIPY_AD_FRAME_STYLES}${html}`
  }
  return html
}

/** Resolved pixel dimensions from Klipy's ad object (with sane fallbacks). */
export function resolveKlipyAdDimensions(
  width?: number,
  height?: number,
): { width: number; height: number } {
  const w = width && width >= 50 ? width : 320
  const h = height && height >= 50 ? height : 50
  return { width: w, height: Math.min(h, 250) }
}
