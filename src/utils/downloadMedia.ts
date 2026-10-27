export function filenameFromUrl(url: string, fallback = 'download'): string {
  try {
    const u = new URL(url, window.location.origin);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : fallback;
  } catch {
    return fallback;
  }
}

/** Saves the media at `url` as `filename`, else as the URL's last path segment (services/downloads.ts). */
export async function downloadMediaFromUrl(url: string, filename?: string): Promise<void> {
  const { saveFile } = await import('@/services/downloads');
  return saveFile(url, filename || filenameFromUrl(url));
}
