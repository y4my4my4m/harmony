/**
 * Utility functions to strip tracking parameters from URLs
 * Supports: YouTube, X/Twitter, TikTok, Instagram, Facebook
 */

/**
 * Known tracking parameters for each platform
 */
const TRACKING_PARAMS: Record<string, string[]> = {
  // YouTube (youtu.be and youtube.com)
  'youtube.com': ['si', 'feature', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid'],
  'youtu.be': ['si', 'feature', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid'],
  
  // X/Twitter
  'twitter.com': ['s', 't', 'ref_src', 'ref_url', 'utm_source', 'utm_medium', 'utm_campaign'],
  'x.com': ['s', 't', 'ref_src', 'ref_url', 'utm_source', 'utm_medium', 'utm_campaign'],
  
  // TikTok
  'tiktok.com': ['is_from_webapp', 'is_copy_url', 'sender_device', 'sender_web_id', 'share_id', 'share_app_id', 'share_link_id', 'share_item_id', 'share_channel'],
  
  // Instagram
  'instagram.com': ['igshid', 'igsh', 'utm_source', 'utm_medium', 'utm_campaign'],
  
  // Facebook
  'facebook.com': ['fbclid', 'ref', 'refsrc', 'utm_source', 'utm_medium', 'utm_campaign'],
  'fb.com': ['fbclid', 'ref', 'refsrc', 'utm_source', 'utm_medium', 'utm_campaign'],
  'm.facebook.com': ['fbclid', 'ref', 'refsrc', 'utm_source', 'utm_medium', 'utm_campaign'],
}

/**
 * Get the domain from a URL
 */
function getDomain(url: string): string | null {
  try {
    const urlObj = new URL(url)
    return urlObj.hostname.replace('www.', '')
  } catch {
    return null
  }
}

/**
 * Strip tracking parameters from a URL
 * @param url The URL to clean
 * @returns The cleaned URL without tracking parameters
 */
export function stripTrackingParameters(url: string): string {
  try {
    const urlObj = new URL(url)
    const domain = urlObj.hostname.replace('www.', '')
    
    // Find matching domain in tracking params
    const trackingParams = TRACKING_PARAMS[domain] || []
    
    if (trackingParams.length === 0) {
      // No tracking params defined for this domain
      return url
    }
    
    // Remove tracking parameters
    trackingParams.forEach(param => {
      urlObj.searchParams.delete(param)
    })
    
    // Reconstruct URL
    const cleanedUrl = urlObj.toString()
    
    // Remove trailing ? if no params remain
    return cleanedUrl.endsWith('?') ? cleanedUrl.slice(0, -1) : cleanedUrl
  } catch (error) {
    // If URL parsing fails, return original
    return url
  }
}

/**
 * Check if URL stripping is enabled for the current user
 */
export function isUrlTrackingStrippingEnabled(): boolean {
  try {
    const setting = localStorage.getItem('harmony-privacy-strip-url-trackers')
    // Default to true if not set
    return setting === null ? true : setting === 'true'
  } catch {
    // If localStorage fails, default to enabled
    return true
  }
}

/**
 * Set URL tracking stripping preference
 */
export function setUrlTrackingStrippingEnabled(enabled: boolean): void {
  try {
    localStorage.setItem('harmony-privacy-strip-url-trackers', enabled ? 'true' : 'false')
  } catch (error) {
    console.error('Failed to save URL tracking stripping preference:', error)
  }
}

// Hoisted to module scope so it isn't recompiled every call. `.replace` with
// a /g regex does not require a `lastIndex` reset.
const URL_IN_TEXT_REGEX = /(\bhttps?:\/\/\S+)/g

/**
 * Strip tracking parameters from all URLs in a text string
 * This is used before parsing message content to clean URLs in the raw text
 * @param text The text content that may contain URLs
 * @returns The text with all URLs cleaned
 */
export function stripUrlsInText(text: string): string {
  if (!text || !isUrlTrackingStrippingEnabled()) {
    return text
  }
  
  return text.replace(URL_IN_TEXT_REGEX, (match) => {
    return stripTrackingParameters(match)
  })
}

