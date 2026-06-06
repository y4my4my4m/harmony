import { debug } from '@/utils/debug';

export function filenameFromUrl(url: string, fallback = 'download'): string {
  try {
    const u = new URL(url, window.location.origin);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last || fallback;
  } catch {
    return fallback;
  }
}

/** Fetch-and-save when possible; fall back to a direct anchor when CORS blocks fetch. */
export async function downloadMediaFromUrl(url: string, filename?: string): Promise<void> {
  const name = filename || filenameFromUrl(url);

  try {
    const response = await fetch(url);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    debug.error('Failed to fetch media for download; falling back to direct link', error);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}
