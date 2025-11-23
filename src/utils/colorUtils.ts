/**
 * Color Utilities for OKLCH-based Theme System
 * 
 * Provides utilities for converting between color spaces and generating
 * theme palettes using the perceptually uniform OKLCH color space.
 */

/**
 * Convert HEX color to RGB
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null
}

/**
 * Convert RGB to HEX
 */
export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(x => {
    const hex = Math.round(x).toString(16)
    return hex.length === 1 ? '0' + hex : hex
  }).join('')
}

/**
 * Convert sRGB to linear RGB
 */
function srgbToLinear(c: number): number {
  const abs = Math.abs(c)
  if (abs <= 0.04045) {
    return c / 12.92
  }
  return (Math.sign(c) || 1) * Math.pow((abs + 0.055) / 1.055, 2.4)
}

/**
 * Convert linear RGB to sRGB
 */
function linearToSrgb(c: number): number {
  const abs = Math.abs(c)
  if (abs > 0.0031308) {
    return (Math.sign(c) || 1) * (1.055 * Math.pow(abs, 1 / 2.4) - 0.055)
  }
  return 12.92 * c
}

/**
 * Convert RGB to XYZ (D65 illuminant)
 */
function rgbToXyz(r: number, g: number, b: number): { x: number; y: number; z: number } {
  // Convert to 0-1 range
  r = r / 255
  g = g / 255
  b = b / 255

  // Convert to linear RGB
  r = srgbToLinear(r)
  g = srgbToLinear(g)
  b = srgbToLinear(b)

  // Convert to XYZ using D65 illuminant
  const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750
  const z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041

  return { x, y, z }
}

/**
 * Convert XYZ to RGB
 */
function xyzToRgb(x: number, y: number, z: number): { r: number; g: number; b: number } {
  // Convert from XYZ to linear RGB
  let r = x * 3.2404542 + y * -1.5371385 + z * -0.4985314
  let g = x * -0.9692660 + y * 1.8760108 + z * 0.0415560
  let b = x * 0.0556434 + y * -0.2040259 + z * 1.0572252

  // Convert to sRGB
  r = linearToSrgb(r)
  g = linearToSrgb(g)
  b = linearToSrgb(b)

  // Convert to 0-255 range
  return {
    r: Math.max(0, Math.min(255, r * 255)),
    g: Math.max(0, Math.min(255, g * 255)),
    b: Math.max(0, Math.min(255, b * 255)),
  }
}

/**
 * Convert Linear RGB to OKLab
 */
function linearRgbToOklab(r: number, g: number, b: number): { l: number; a: number; b: number } {
  // Convert to OKLab using the correct matrix
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b

  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)

  return {
    l: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  }
}

/**
 * Convert OKLab to Linear RGB
 */
function oklabToLinearRgb(l: number, a: number, b: number): { r: number; g: number; b: number } {
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b

  const l3 = l_ * l_ * l_
  const m3 = m_ * m_ * m_
  const s3 = s_ * s_ * s_

  return {
    r: +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    g: -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    b: -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3,
  }
}

/**
 * Convert RGB to OKLCH (correct implementation)
 */
export function rgbToOklch(r: number, g: number, b: number): { l: number; c: number; h: number } {
  // Normalize to 0-1 range
  const rNorm = r / 255
  const gNorm = g / 255
  const bNorm = b / 255
  
  // Convert to linear RGB
  const rLin = srgbToLinear(rNorm)
  const gLin = srgbToLinear(gNorm)
  const bLin = srgbToLinear(bNorm)
  
  // Convert to OKLab
  const oklab = linearRgbToOklab(rLin, gLin, bLin)
  
  // Convert to OKLCH
  const c = Math.sqrt(oklab.a * oklab.a + oklab.b * oklab.b)
  let h = Math.atan2(oklab.b, oklab.a) * 180 / Math.PI
  if (h < 0) h += 360
  
  return {
    l: oklab.l * 100, // Convert to percentage
    c: c,
    h: h
  }
}

/**
 * Convert OKLCH to RGB (correct implementation)
 */
export function oklchToRgb(l: number, c: number, h: number): { r: number; g: number; b: number } {
  // Convert from percentage
  const lNorm = l / 100
  
  // Convert to OKLab
  const hRad = h * Math.PI / 180
  const a = c * Math.cos(hRad)
  const b = c * Math.sin(hRad)
  
  // Convert to linear RGB
  const rgb = oklabToLinearRgb(lNorm, a, b)
  
  // Convert to sRGB
  const r = linearToSrgb(rgb.r)
  const g = linearToSrgb(rgb.g)
  const b255 = linearToSrgb(rgb.b)
  
  // Clamp and convert to 0-255 range
  return {
    r: Math.max(0, Math.min(255, Math.round(r * 255))),
    g: Math.max(0, Math.min(255, Math.round(g * 255))),
    b: Math.max(0, Math.min(255, Math.round(b255 * 255))),
  }
}

/**
 * Convert HEX to OKLCH
 */
export function hexToOklch(hex: string): { l: number; c: number; h: number } | null {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  return rgbToOklch(rgb.r, rgb.g, rgb.b)
}

/**
 * Convert OKLCH to HEX
 */
export function oklchToHex(l: number, c: number, h: number): string {
  const rgb = oklchToRgb(l, c, h)
  return rgbToHex(rgb.r, rgb.g, rgb.b)
}

/**
 * Format OKLCH as CSS string
 */
export function oklchToString(l: number, c: number, h: number): string {
  return `oklch(${l.toFixed(2)}% ${c.toFixed(3)} ${h.toFixed(1)})`
}

/**
 * Determine if a color is light or dark based on lightness
 */
export function isLightColor(hex: string): boolean {
  const oklch = hexToOklch(hex)
  if (!oklch) return false
  // Lightness above 60% is considered light
  return oklch.l > 60
}

/**
 * Adjust lightness of a color
 */
export function adjustLightness(hex: string, delta: number): string {
  const oklch = hexToOklch(hex)
  if (!oklch) return hex
  
  const newL = Math.max(0, Math.min(100, oklch.l + delta))
  return oklchToHex(newL, oklch.c, oklch.h)
}

/**
 * Adjust chroma (saturation) of a color
 */
export function adjustChroma(hex: string, delta: number): string {
  const oklch = hexToOklch(hex)
  if (!oklch) return hex
  
  const newC = Math.max(0, Math.min(0.4, oklch.c + delta))
  return oklchToHex(oklch.l, newC, oklch.h)
}

/**
 * Adjust hue of a color
 */
export function adjustHue(hex: string, delta: number): string {
  const oklch = hexToOklch(hex)
  if (!oklch) return hex
  
  let newH = oklch.h + delta
  if (newH < 0) newH += 360
  if (newH >= 360) newH -= 360
  
  return oklchToHex(oklch.l, oklch.c, newH)
}

/**
 * Generate a complete theme palette from an accent color
 */
export interface ThemePalette {
  // Primary colors
  primary: string
  primaryHover: string
  primaryLight: string
  primaryDark: string
  
  // Background colors
  bgPrimary: string
  bgSecondary: string
  bgTertiary: string
  bgChat: string
  bgSidebar: string
  
  // Text colors
  textPrimary: string
  textSecondary: string
  textTertiary: string
  
  // Border colors
  borderPrimary: string
  borderSecondary: string
  
  // Metadata
  isLightTheme: boolean
}

/**
 * Generate theme palette from accent color and background color
 */
export function generateThemePalette(
  accentHex: string, 
  forcedMode?: 'light' | 'dark',
  backgroundHex?: string
): ThemePalette {
  const isLight = forcedMode === 'light' || (forcedMode === undefined && isLightColor(accentHex))
  const baseOklch = hexToOklch(accentHex)
  
  if (!baseOklch) {
    throw new Error('Invalid accent color')
  }

  // If background color is provided, use its hue for the UI backgrounds
  let bgHue = baseOklch.h
  if (backgroundHex) {
    const bgOklch = hexToOklch(backgroundHex)
    if (bgOklch) {
      bgHue = bgOklch.h
    }
  }

  if (isLight) {
    // Light theme - use background hue for subtle tinting
    const bgTintChroma = 0.02 // Very subtle chroma for backgrounds
    
    const bgPrimaryOklch = { l: 98, c: bgTintChroma, h: bgHue }
    const bgSecondaryOklch = { l: 96, c: bgTintChroma, h: bgHue }
    const bgTertiaryOklch = { l: 94, c: bgTintChroma, h: bgHue }
    const sidebarOklch = { l: 94, c: bgTintChroma * 1.5, h: bgHue }
    
    return {
      primary: accentHex,
      primaryHover: adjustLightness(accentHex, -10),
      primaryLight: adjustLightness(accentHex, 20),
      primaryDark: adjustLightness(accentHex, -15),
      
      bgPrimary: oklchToHex(bgPrimaryOklch.l, bgPrimaryOklch.c, bgPrimaryOklch.h),
      bgSecondary: oklchToHex(bgSecondaryOklch.l, bgSecondaryOklch.c, bgSecondaryOklch.h),
      bgTertiary: oklchToHex(bgTertiaryOklch.l, bgTertiaryOklch.c, bgTertiaryOklch.h),
      bgChat: oklchToHex(bgPrimaryOklch.l, bgPrimaryOklch.c, bgPrimaryOklch.h),
      bgSidebar: oklchToHex(sidebarOklch.l, sidebarOklch.c, sidebarOklch.h),
      
      textPrimary: '#2e3338',
      textSecondary: '#4e5058',
      textTertiary: '#6e7178',
      
      borderPrimary: 'rgba(0, 0, 0, 0.12)',
      borderSecondary: 'rgba(0, 0, 0, 0.08)',
      
      isLightTheme: true,
    }
  } else {
    // Dark theme - use background hue with low chroma for UI tone
    const bgTintChroma = 0.015 // Subtle chroma for dark backgrounds
    
    // Chat/content areas (lighter, more visible)
    const bgChatOklch = { l: 19.5, c: bgTintChroma, h: bgHue }  // ~#313338
    const sidebarOklch = { l: 17, c: bgTintChroma * 1.5, h: bgHue }  // ~#2b2d31
    
    // System backgrounds (darker, for structure)
    const systemBgPrimaryOklch = { l: 12, c: bgTintChroma, h: bgHue }  // ~#1a1a1e (BaseLayout)
    const systemBgSecondaryOklch = { l: 10.5, c: bgTintChroma, h: bgHue }  // ~#17181a
    const systemBgTertiaryOklch = { l: 8.5, c: bgTintChroma, h: bgHue }  // ~#121214 (server sidebar)
    
    return {
      primary: accentHex,
      primaryHover: adjustLightness(accentHex, -8),
      primaryLight: adjustLightness(accentHex, 15),
      primaryDark: adjustLightness(accentHex, -12),
      
      // System backgrounds (for BaseLayout, server sidebar, etc.)
      bgPrimary: oklchToHex(systemBgPrimaryOklch.l, systemBgPrimaryOklch.c, systemBgPrimaryOklch.h),
      bgSecondary: oklchToHex(systemBgSecondaryOklch.l, systemBgSecondaryOklch.c, systemBgSecondaryOklch.h),
      bgTertiary: oklchToHex(systemBgTertiaryOklch.l, systemBgTertiaryOklch.c, systemBgTertiaryOklch.h),
      
      // Chat/content backgrounds
      bgChat: oklchToHex(bgChatOklch.l, bgChatOklch.c, bgChatOklch.h),
      bgSidebar: oklchToHex(sidebarOklch.l, sidebarOklch.c, sidebarOklch.h),
      
      textPrimary: '#f2f3f5',
      textSecondary: '#b5bac1',
      textTertiary: '#80848e',
      
      borderPrimary: 'rgba(255, 255, 255, 0.08)',
      borderSecondary: 'rgba(255, 255, 255, 0.06)',
      
      isLightTheme: false,
    }
  }
}

/**
 * Apply theme palette to CSS custom properties using OKLCH
 */
export function applyThemePalette(palette: ThemePalette): void {
  const root = document.documentElement
  
  // Primary colors (keep as HEX for compatibility)
  root.style.setProperty('--harmony-primary', palette.primary)
  root.style.setProperty('--harmony-primary-hover', palette.primaryHover)
  root.style.setProperty('--harmony-primary-light', palette.primaryLight)
  root.style.setProperty('--h-primary', palette.primary)
  root.style.setProperty('--h-primary-light', palette.primaryLight)
  root.style.setProperty('--h-primary-dark', palette.primaryDark)
  
  // Convert background colors to OKLCH for proper hue/chroma application
  const bgChatOklch = hexToOklch(palette.bgChat)
  const bgSidebarOklch = hexToOklch(palette.bgSidebar)
  const bgPrimaryOklch = hexToOklch(palette.bgPrimary)
  const bgSecondaryOklch = hexToOklch(palette.bgSecondary)
  const bgTertiaryOklch = hexToOklch(palette.bgTertiary)
  
  if (bgChatOklch) {
    // Chat backgrounds - use OKLCH so custom hue applies
    root.style.setProperty('--h-chat', oklchToString(bgChatOklch.l, bgChatOklch.c, bgChatOklch.h))
    root.style.setProperty('--h-chat-light', oklchToString(bgChatOklch.l + 3, bgChatOklch.c, bgChatOklch.h))
    root.style.setProperty('--h-chat-lighter', oklchToString(bgChatOklch.l + 5, bgChatOklch.c, bgChatOklch.h))
    root.style.setProperty('--h-chat-dark', oklchToString(bgChatOklch.l - 8, bgChatOklch.c, bgChatOklch.h))
    root.style.setProperty('--h-chat-darker', oklchToString(bgChatOklch.l - 12, bgChatOklch.c, bgChatOklch.h))
  }
  
  if (bgSidebarOklch) {
    root.style.setProperty('--h-sidebar', oklchToString(bgSidebarOklch.l, bgSidebarOklch.c, bgSidebarOklch.h))
    root.style.setProperty('--h-sidebar-light', oklchToString(bgSidebarOklch.l + 4, bgSidebarOklch.c, bgSidebarOklch.h))
  }
  
  if (bgTertiaryOklch) {
    root.style.setProperty('--h-black', oklchToString(bgTertiaryOklch.l + 6, bgTertiaryOklch.c, bgTertiaryOklch.h))
    root.style.setProperty('--h-black-light', oklchToString(bgTertiaryOklch.l + 11, bgTertiaryOklch.c, bgTertiaryOklch.h))
    root.style.setProperty('--h-black-lighter', oklchToString(bgTertiaryOklch.l + 14, bgTertiaryOklch.c, bgTertiaryOklch.h))
    root.style.setProperty('--h-black-darker', oklchToString(bgTertiaryOklch.l - 2, bgTertiaryOklch.c, bgTertiaryOklch.h))
  }
  
  // System background colors - use OKLCH for custom hue
  if (bgPrimaryOklch) {
    root.style.setProperty('--background-primary', oklchToString(bgPrimaryOklch.l, bgPrimaryOklch.c, bgPrimaryOklch.h))
  }
  if (bgSecondaryOklch) {
    root.style.setProperty('--background-secondary', oklchToString(bgSecondaryOklch.l, bgSecondaryOklch.c, bgSecondaryOklch.h))
    root.style.setProperty('--background-quaternary', oklchToString(bgSecondaryOklch.l + 2, bgSecondaryOklch.c, bgSecondaryOklch.h))
  }
  if (bgTertiaryOklch) {
    root.style.setProperty('--background-tertiary', oklchToString(bgTertiaryOklch.l, bgTertiaryOklch.c, bgTertiaryOklch.h))
    root.style.setProperty('--background-quinary', oklchToString(bgTertiaryOklch.l + 2, bgTertiaryOklch.c, bgTertiaryOklch.h))
  }
  
  // Text colors
  root.style.setProperty('--text-primary', palette.textPrimary)
  root.style.setProperty('--text-secondary', palette.textSecondary)
  root.style.setProperty('--text-tertiary', palette.textTertiary)
  
  // Border colors
  root.style.setProperty('--border-primary', palette.borderPrimary)
  root.style.setProperty('--border-secondary', palette.borderSecondary)
  
  // Set theme attribute
  root.setAttribute('data-theme', 'custom')
  root.setAttribute('data-theme-type', palette.isLightTheme ? 'light' : 'dark')
  
  console.log('🎨 Applied custom theme palette with OKLCH:', palette)
}

