// Generate a real poster frame for a video. Android: use the native
// MediaMetadataRetriever (WebView can't decode a detached <video> for canvas, and
// this handles remote URLs without CORS). Desktop/web: canvas from a hidden video.
// Cached (incl. failures) so a feed only decodes once per URL.

const isAndroid = /Android/i.test(navigator.userAgent);
const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

export function getCachedVideoPoster(url: string): string | null | undefined {
  return cache.get(url);
}

export function generateVideoPoster(url: string): Promise<string | null> {
  if (!url) return Promise.resolve(null);
  if (cache.has(url)) return Promise.resolve(cache.get(url)!);
  const existing = pending.get(url);
  if (existing) return existing;

  // Native retriever needs a real URL (can't read the webview's blob:).
  const useNative = isAndroid && /^https?:\/\//i.test(url);
  const p = (useNative ? nativeThumbnail(url) : decodeFrame(url)).then((result) => {
    cache.set(url, result);
    pending.delete(url);
    return result;
  });
  pending.set(url, p);
  return p;
}

async function nativeThumbnail(url: string): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const dataUrl = await invoke<string>('android_video_thumbnail', { url });
    return dataUrl && dataUrl.startsWith('data:') ? dataUrl : null;
  } catch {
    return null;
  }
}

// Global poster manager: catches <video> from Vue templates AND v-html content
// (federated posts) which a directive can't reach. Lazy via IntersectionObserver.
function processVideo(video: HTMLVideoElement): void {
  if (video.dataset.vp === '1') return;
  video.dataset.vp = '1';
  if (video.autoplay || video.hasAttribute('autoplay') || video.getAttribute('poster')) return;

  // The native poster is the thumbnail; don't let the webview fetch video data
  // until the user actually plays it.
  video.preload = 'none';

  const io = new IntersectionObserver(async (entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    const src =
      video.getAttribute('src') ||
      video.currentSrc ||
      video.querySelector('source')?.getAttribute('src') ||
      '';
    if (!src || video.getAttribute('poster')) return;
    const poster = await generateVideoPoster(src);
    if (poster && !video.getAttribute('poster')) video.setAttribute('poster', poster);
  }, { rootMargin: '300px' });
  io.observe(video);
}

export function installVideoPosters(): void {
  if (!isAndroid) return; // desktop webviews already paint a first frame
  document.querySelectorAll('video').forEach((v) => processVideo(v as HTMLVideoElement));
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => {
        if (n instanceof HTMLVideoElement) processVideo(n);
        else if (n instanceof HTMLElement) n.querySelectorAll?.('video').forEach((v) => processVideo(v as HTMLVideoElement));
      });
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

function decodeFrame(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous'; // must precede src for a non-tainted canvas
    video.muted = true;
    video.preload = 'auto';
    (video as any).playsInline = true;
    video.src = url;

    let settled = false;
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      try { video.load(); } catch { /* ignore */ }
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), 10000);

    video.addEventListener('loadeddata', () => {
      const seekTo = Math.min(0.1, (video.duration || 1) / 4);
      try { video.currentTime = seekTo; } catch { finish(null); }
    });

    video.addEventListener('seeked', () => {
      try {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) { finish(null); return; }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { finish(null); return; }
        ctx.drawImage(video, 0, 0, w, h);
        canvas.toBlob(
          (blob) => finish(blob ? URL.createObjectURL(blob) : null),
          'image/jpeg',
          0.75,
        );
      } catch {
        finish(null); // tainted canvas (no CORS) or decode failure
      }
    });

    video.addEventListener('error', () => finish(null));
  });
}
