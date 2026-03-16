/**
 * Color Utilities for OKLCH-based Theme System
 * 
 * Provides utilities for converting between color spaces and generating
 * theme palettes using the perceptually uniform OKLCH color space.
 */
import { debug } from '@/utils/debug'
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
  
  // Secondary / accent brand colors
  secondary: string
  accent: string
  
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
 * Generate theme palette from primary color, accent color, and background settings
 */
export function generateThemePalette(
  accentHex: string, 
  forcedMode?: 'light' | 'dark',
  backgroundHex?: string,
  lightnessOffset: number = 0,
  primaryHex?: string,
  chromaOffset: number = 0
): ThemePalette {
  const isLight = forcedMode === 'light' || (forcedMode === undefined && isLightColor(accentHex))
  const baseOklch = hexToOklch(accentHex)
  
  if (!baseOklch) {
    throw new Error('Invalid accent color')
  }

  // Use primary color if provided, otherwise use accent
  const primaryColor = primaryHex || accentHex
  
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
    // Lightness offset: -50 to +50, negative = darker, positive = lighter
    // Chroma offset: -30 to +30, affects color saturation
    const baseChroma = 0.02
    const bgTintChroma = Math.max(0, Math.min(0.15, baseChroma + (chromaOffset * 0.004)))
    
    // Base lightness levels for light mode (high values)
    // Scale: at 0 = 98, at -50 = 68, at +50 = 100 (capped)
    const baseLightness = 98 + (lightnessOffset * 0.6)
    const bgPrimaryOklch = { l: Math.min(100, Math.max(60, baseLightness)), c: bgTintChroma, h: bgHue }
    const bgSecondaryOklch = { l: Math.min(100, Math.max(58, baseLightness - 2)), c: bgTintChroma, h: bgHue }
    const bgTertiaryOklch = { l: Math.min(100, Math.max(56, baseLightness - 4)), c: bgTintChroma, h: bgHue }
    const sidebarOklch = { l: Math.min(100, Math.max(55, baseLightness - 4)), c: bgTintChroma * 1.5, h: bgHue }
    
    // Generate oklch-based border colors using background hue
    const borderLightness = Math.max(30, baseLightness - 40)
    const borderChroma = bgTintChroma * 0.8
    const borderPrimaryOklch = { l: borderLightness, c: borderChroma, h: bgHue }
    const borderSecondaryOklch = { l: borderLightness + 10, c: borderChroma * 0.6, h: bgHue }
    
    return {
      primary: primaryColor,
      primaryHover: adjustLightness(primaryColor, -10),
      primaryLight: adjustLightness(primaryColor, 20),
      primaryDark: adjustLightness(primaryColor, -15),
      
      secondary: accentHex,
      accent: adjustHue(accentHex, 30),
      
      bgPrimary: oklchToHex(bgPrimaryOklch.l, bgPrimaryOklch.c, bgPrimaryOklch.h),
      bgSecondary: oklchToHex(bgSecondaryOklch.l, bgSecondaryOklch.c, bgSecondaryOklch.h),
      bgTertiary: oklchToHex(bgTertiaryOklch.l, bgTertiaryOklch.c, bgTertiaryOklch.h),
      bgChat: oklchToHex(bgPrimaryOklch.l, bgPrimaryOklch.c, bgPrimaryOklch.h),
      bgSidebar: oklchToHex(sidebarOklch.l, sidebarOklch.c, sidebarOklch.h),
      
      textPrimary: '#1a1c1e',
      textSecondary: '#3d4148',
      textTertiary: '#5c6168',
      
      // Dynamic oklch-based border colors with theme hue
      borderPrimary: `oklch(${borderPrimaryOklch.l.toFixed(1)}% ${borderPrimaryOklch.c.toFixed(3)} ${borderPrimaryOklch.h.toFixed(1)} / 0.20)`,
      borderSecondary: `oklch(${borderSecondaryOklch.l.toFixed(1)}% ${borderSecondaryOklch.c.toFixed(3)} ${borderSecondaryOklch.h.toFixed(1)} / 0.15)`,
      
      isLightTheme: true,
    }
  } else {
    // Dark theme - use background hue with low chroma for UI tone
    // Lightness offset: -50 to +50, negative = darker, positive = lighter
    // Chroma offset: -30 to +30, affects color saturation
    const baseChroma = 0.015
    const bgTintChroma = Math.max(0, Math.min(0.12, baseChroma + (chromaOffset * 0.003)))
    
    // Base lightness levels for dark mode
    // Scale: at 0 = ~20, at -50 = ~5 (very dark), at +50 = ~45 (lighter dark)
    const chatBaseLightness = 19.5 + (lightnessOffset * 0.5)
    const sidebarBaseLightness = 17 + (lightnessOffset * 0.5)
    const systemBaseLightness = 12 + (lightnessOffset * 0.45)
    
    // Chat/content areas (lighter, more visible)
    const bgChatOklch = { l: Math.max(3, Math.min(50, chatBaseLightness)), c: bgTintChroma, h: bgHue }
    const sidebarOklch = { l: Math.max(2, Math.min(45, sidebarBaseLightness)), c: bgTintChroma * 1.5, h: bgHue }
    
    // System backgrounds (darker, for structure)
    const systemBgPrimaryOklch = { l: Math.max(2, Math.min(40, systemBaseLightness)), c: bgTintChroma, h: bgHue }
    const systemBgSecondaryOklch = { l: Math.max(1, Math.min(38, systemBaseLightness - 1.5)), c: bgTintChroma, h: bgHue }
    const systemBgTertiaryOklch = { l: Math.max(1, Math.min(35, systemBaseLightness - 3.5)), c: bgTintChroma, h: bgHue }
    
    // Generate oklch-based border colors using background hue for dark theme
    const borderLightness = Math.min(60, chatBaseLightness + 25)
    const borderChroma = bgTintChroma * 1.2
    const borderPrimaryOklch = { l: borderLightness, c: borderChroma, h: bgHue }
    const borderSecondaryOklch = { l: borderLightness - 5, c: borderChroma * 0.8, h: bgHue }
    
    return {
      primary: primaryColor,
      primaryHover: adjustLightness(primaryColor, -8),
      primaryLight: adjustLightness(primaryColor, 15),
      primaryDark: adjustLightness(primaryColor, -12),
      
      secondary: accentHex,
      accent: adjustHue(accentHex, 30),
      
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
      
      // Dynamic oklch-based border colors with theme hue
      borderPrimary: `oklch(${borderPrimaryOklch.l.toFixed(1)}% ${borderPrimaryOklch.c.toFixed(3)} ${borderPrimaryOklch.h.toFixed(1)} / 0.12)`,
      borderSecondary: `oklch(${borderSecondaryOklch.l.toFixed(1)}% ${borderSecondaryOklch.c.toFixed(3)} ${borderSecondaryOklch.h.toFixed(1)} / 0.08)`,
      
      isLightTheme: false,
    }
  }
}

/**
 * Generate preview colors for theme card based on background settings
 */
export function generatePreviewColors(
  backgroundHex: string,
  mode: 'light' | 'dark',
  lightnessOffset: number = 0,
  chromaOffset: number = 0
): { bgMain: string; bgSidebar: string; bgHeader: string } {
  const bgOklch = hexToOklch(backgroundHex)
  if (!bgOklch) {
    return mode === 'light' 
      ? { bgMain: '#ffffff', bgSidebar: '#f2f3f5', bgHeader: '#f6f6f6' }
      : { bgMain: '#313338', bgSidebar: '#2b2d31', bgHeader: '#2f3136' }
  }
  
  // Calculate chroma based on mode and offset
  const baseChroma = mode === 'light' ? 0.02 : 0.015
  const bgTintChroma = Math.max(0, Math.min(mode === 'light' ? 0.15 : 0.12, baseChroma + (chromaOffset * (mode === 'light' ? 0.004 : 0.003))))
  
  if (mode === 'light') {
    const baseLightness = 98 + (lightnessOffset * 0.6)
    return {
      bgMain: oklchToHex(Math.min(100, Math.max(60, baseLightness)), bgTintChroma, bgOklch.h),
      bgSidebar: oklchToHex(Math.min(100, Math.max(55, baseLightness - 4)), bgTintChroma * 1.5, bgOklch.h),
      bgHeader: oklchToHex(Math.min(100, Math.max(58, baseLightness - 2)), bgTintChroma, bgOklch.h),
    }
  } else {
    const chatBaseLightness = 19.5 + (lightnessOffset * 0.5)
    const sidebarBaseLightness = 17 + (lightnessOffset * 0.5)
    return {
      bgMain: oklchToHex(Math.max(3, Math.min(50, chatBaseLightness)), bgTintChroma, bgOklch.h),
      bgSidebar: oklchToHex(Math.max(2, Math.min(45, sidebarBaseLightness)), bgTintChroma * 1.5, bgOklch.h),
      bgHeader: oklchToHex(Math.max(2, Math.min(45, sidebarBaseLightness)), bgTintChroma, bgOklch.h),
    }
  }
}

/**
 * Format OKLCH as CSS string with alpha
 */
function oklchToStringAlpha(l: number, c: number, h: number, alpha: number): string {
  return `oklch(${l.toFixed(2)}% ${c.toFixed(3)} ${h.toFixed(1)} / ${alpha.toFixed(2)})`
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
  root.style.setProperty('--h-brand', palette.primary)
  
  // Secondary / accent brand colors
  root.style.setProperty('--harmony-secondary', palette.secondary)
  root.style.setProperty('--harmony-secondary-hover', adjustLightness(palette.secondary, -8))
  root.style.setProperty('--harmony-secondary-light', `${palette.secondary}1a`)
  root.style.setProperty('--harmony-secondary-alpha', `${palette.secondary}26`)
  root.style.setProperty('--harmony-secondary-alpha-light', `${palette.secondary}1a`)
  root.style.setProperty('--harmony-secondary-alpha-strong', `${palette.secondary}40`)
  root.style.setProperty('--harmony-accent', palette.accent)
  root.style.setProperty('--harmony-accent-hover', adjustLightness(palette.accent, -8))
  root.style.setProperty('--harmony-accent-light', `${palette.accent}1a`)
  root.style.setProperty('--harmony-accent-alpha', `${palette.accent}26`)
  root.style.setProperty('--harmony-accent-alpha-light', `${palette.accent}1a`)
  root.style.setProperty('--harmony-accent-alpha-strong', `${palette.accent}40`)
  
  // Primary color alpha variants
  const primaryOklch = hexToOklch(palette.primary)
  if (primaryOklch) {
    root.style.setProperty('--harmony-primary-alpha', oklchToStringAlpha(primaryOklch.l, primaryOklch.c, primaryOklch.h, 0.15))
    root.style.setProperty('--harmony-primary-alpha-light', oklchToStringAlpha(primaryOklch.l, primaryOklch.c, primaryOklch.h, 0.1))
    root.style.setProperty('--harmony-primary-alpha-strong', oklchToStringAlpha(primaryOklch.l, primaryOklch.c, primaryOklch.h, 0.25))
  }
  
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
    // Alpha variants
    root.style.setProperty('--h-chat-alpha', oklchToStringAlpha(bgChatOklch.l, bgChatOklch.c, bgChatOklch.h, 0.67))
    root.style.setProperty('--h-chat-alpha-light', oklchToStringAlpha(bgChatOklch.l, bgChatOklch.c, bgChatOklch.h, 0.5))
  }
  
  if (bgSidebarOklch) {
    root.style.setProperty('--h-sidebar', oklchToString(bgSidebarOklch.l, bgSidebarOklch.c, bgSidebarOklch.h))
    root.style.setProperty('--h-sidebar-light', oklchToString(bgSidebarOklch.l + 4, bgSidebarOklch.c, bgSidebarOklch.h))
    // Alpha variants
    root.style.setProperty('--h-sidebar-alpha', oklchToStringAlpha(bgSidebarOklch.l, bgSidebarOklch.c, bgSidebarOklch.h, 0.67))
  }
  
  if (bgTertiaryOklch) {
    root.style.setProperty('--h-black', oklchToString(bgTertiaryOklch.l + 6, bgTertiaryOklch.c, bgTertiaryOklch.h))
    root.style.setProperty('--h-black-light', oklchToString(bgTertiaryOklch.l + 11, bgTertiaryOklch.c, bgTertiaryOklch.h))
    root.style.setProperty('--h-black-lighter', oklchToString(bgTertiaryOklch.l + 14, bgTertiaryOklch.c, bgTertiaryOklch.h))
    root.style.setProperty('--h-black-darker', oklchToString(bgTertiaryOklch.l - 2, bgTertiaryOklch.c, bgTertiaryOklch.h))
    // Alpha variants
    root.style.setProperty('--h-black-alpha', oklchToStringAlpha(bgTertiaryOklch.l + 6, bgTertiaryOklch.c, bgTertiaryOklch.h, 0.67))
  }
  
  // System background colors - use OKLCH for custom hue
  if (bgPrimaryOklch) {
    root.style.setProperty('--background-primary', oklchToString(bgPrimaryOklch.l, bgPrimaryOklch.c, bgPrimaryOklch.h))
    // Alpha variant (0xaa = 170/255 ≈ 0.67)
    root.style.setProperty('--background-primary-alpha', oklchToStringAlpha(bgPrimaryOklch.l, bgPrimaryOklch.c, bgPrimaryOklch.h, 0.67))
  }
  if (bgSecondaryOklch) {
    root.style.setProperty('--background-secondary', oklchToString(bgSecondaryOklch.l, bgSecondaryOklch.c, bgSecondaryOklch.h))
    root.style.setProperty('--background-quaternary', oklchToString(bgSecondaryOklch.l + 2, bgSecondaryOklch.c, bgSecondaryOklch.h))
    // Alpha variant
    root.style.setProperty('--background-secondary-alpha', oklchToStringAlpha(bgSecondaryOklch.l, bgSecondaryOklch.c, bgSecondaryOklch.h, 0.67))
  }
  if (bgTertiaryOklch) {
    root.style.setProperty('--background-tertiary', oklchToString(bgTertiaryOklch.l, bgTertiaryOklch.c, bgTertiaryOklch.h))
    root.style.setProperty('--background-quinary', oklchToString(bgTertiaryOklch.l + 2, bgTertiaryOklch.c, bgTertiaryOklch.h))
    // Alpha variant
    root.style.setProperty('--background-tertiary-alpha', oklchToStringAlpha(bgTertiaryOklch.l, bgTertiaryOklch.c, bgTertiaryOklch.h, 0.67))
  }

  // Senary: darkest layer (picker tabs, emoji/gif popup header, overlays) – always set with theme hue when we have any background
  const senarySource = bgTertiaryOklch ?? bgPrimaryOklch ?? bgSecondaryOklch
  if (senarySource) {
    const senaryL = palette.isLightTheme
      ? 22  // Light: dark overlay (L22) with theme hue for dropdowns/pickers
      : Math.max(1, senarySource.l - 4)  // Dark: one step darker than source
    root.style.setProperty('--background-senary', oklchToString(senaryL, senarySource.c, senarySource.h))
    root.style.setProperty('--background-senary-alpha', oklchToStringAlpha(senaryL, senarySource.c, senarySource.h, 0.78))
  }
  
  // Text colors
  root.style.setProperty('--text-primary', palette.textPrimary)
  root.style.setProperty('--text-secondary', palette.textSecondary)
  root.style.setProperty('--text-tertiary', palette.textTertiary)
  root.style.setProperty('--text-muted', palette.isLightTheme ? '#5e6168' : '#6d6f78')
  
  // Border colors
  root.style.setProperty('--border-primary', palette.borderPrimary)
  root.style.setProperty('--border-secondary', palette.borderSecondary)
  root.style.setProperty('--border-color', palette.borderPrimary)  // Main border color used by components
  root.style.setProperty('--color-border', palette.borderPrimary)  // Alternative naming
  
  // Set theme attribute
  root.setAttribute('data-theme', 'custom')
  root.setAttribute('data-theme-type', palette.isLightTheme ? 'light' : 'dark')
  
  debug.log('🎨 Applied custom theme palette with OKLCH:', palette)
}

