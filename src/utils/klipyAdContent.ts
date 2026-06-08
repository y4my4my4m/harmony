/**
 * Klipy ad HTML includes its own `.ad` disclosure badge inside the blob.
 * Harmony renders a clearer label outside the sandboxed iframe instead.
 *
 * IMPORTANT: Klipy's loader script queries `.ad` and only then sets `img` opacity
 * to 1. The element must stay in the DOM — do not remove it or `display:none` it.
 */

const KLIPY_AD_FRAME_STYLES = `<style>
html,body{margin:0!important;padding:0!important;background:transparent!important;overflow:hidden!important;width:100%!important;height:100%!important}
.ad{opacity:0!important;pointer-events:none!important;position:absolute!important;left:-9999px!important;top:0!important;width:1px!important;height:1px!important;overflow:hidden!important}
</style>`

/** If Klipy's loader throws (e.g. missing nodes), still reveal the creative. */
const KLIPY_AD_FALLBACK_MARKER = 'harmony-klipy-ad-fallback'
const KLIPY_AD_FALLBACK_SCRIPT = `<!-- ${KLIPY_AD_FALLBACK_MARKER} --><script>
document.addEventListener('DOMContentLoaded',function(){
  var n=0,t=setInterval(function(){
    var img=document.querySelector('img');
    if(img&&img.complete&&img.naturalWidth>0){img.style.opacity='1';clearInterval(t);}
    if(++n>500)clearInterval(t);
  },10);
});
</script>`

/** Prepare Klipy ad HTML for iframe srcdoc. */
export function prepareKlipyAdHtml(content: string): string {
  if (!content) return content
  let html = content
  if (!html.includes(KLIPY_AD_FRAME_STYLES)) {
    html = `${KLIPY_AD_FRAME_STYLES}${html}`
  }
  if (!html.includes(KLIPY_AD_FALLBACK_MARKER)) {
    html = `${html}${KLIPY_AD_FALLBACK_SCRIPT}`
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
