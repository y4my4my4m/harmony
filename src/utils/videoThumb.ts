const isAndroid = /Android/i.test(navigator.userAgent);

// Android WebView won't paint a first-frame poster from preload="metadata" alone.
// A media fragment (#t) forces a seek so a frame renders as the thumbnail.
// No-op elsewhere and when the URL already carries a fragment.
export function videoFrameSrc(url: string | null | undefined): string {
  if (!url) return url || '';
  if (!isAndroid || url.includes('#t=')) return url;
  return `${url}#t=0.1`;
}
