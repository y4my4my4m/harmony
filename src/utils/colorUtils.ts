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
// eslint-disable-next-line unused-imports/no-unused-vars
function rgbToXyz(r: number, g: number, b: number): { x: number; y: number; z: number } {
  r = r / 255
  g = g / 255
  b = b / 255

  r = srgbToLinear(r)
  g = srgbToLinear(g)
  b = srgbToLinear(b)

  const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750
  const z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041

  return { x, y, z }
}

/**
 * Convert XYZ to RGB
 */
// eslint-disable-next-line unused-imports/no-unused-vars
function xyzToRgb(x: number, y: number, z: number): { r: number; g: number; b: number } {
  let r = x * 3.2404542 + y * -1.5371385 + z * -0.4985314
  let g = x * -0.9692660 + y * 1.8760108 + z * 0.0415560
  let b = x * 0.0556434 + y * -0.2040259 + z * 1.0572252

  r = linearToSrgb(r)
  g = linearToSrgb(g)
  b = linearToSrgb(b)

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
  
  const rLin = srgbToLinear(rNorm)
  const gLin = srgbToLinear(gNorm)
  const bLin = srgbToLinear(bNorm)
  
  const oklab = linearRgbToOklab(rLin, gLin, bLin)
  
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
  const lNorm = l / 100
  
  const hRad = h * Math.PI / 180
  const a = c * Math.cos(hRad)
  const b = c * Math.sin(hRad)
  
  const rgb = oklabToLinearRgb(lNorm, a, b)
  
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

function clampTone(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** Reference OKLCH anchors for the background-tone picker ↔ slider sync. */
const TONE_REF = {
  // Anchored near typical dark tone picks so decompose doesn't slam sliders negative.
  dark: { baseL: 40, lStep: 0.6, baseC: 0.07, cStep: 0.004, minL: 18, maxL: 72, maxC: 0.22 },
  light: { baseL: 75, lStep: 0.6, baseC: 0.08, cStep: 0.004, minL: 40, maxL: 98, maxC: 0.28 },
} as const

interface UiSurfaceLevels {
  hue: number
  tintChroma: number
  systemBaseLightness: number
  chatBaseLightness: number
  sidebarBaseLightness: number
}

/**
 * Map background tone into UI surface OKLCH levels.
 * Hue comes from the tone swatch; lightness/saturation intensity comes ONLY from
 * the sliders. Using the swatch's raw OKLCH chroma/lightness (as community
 * presets store vivid marketing hexes) would double-count and oversaturate UI.
 */
function deriveUiSurfacesFromTone(
  backgroundHex: string | undefined,
  accentHue: number,
  isLight: boolean,
  lightnessOffset: number,
  chromaOffset: number,
): UiSurfaceLevels {
  const hue = (backgroundHex ? extractBackgroundHue(backgroundHex) : null) ?? accentHue

  if (isLight) {
    const systemBaseLightness = clampTone(98 + lightnessOffset * 0.6, 60, 100)
    return {
      hue,
      tintChroma: clampTone(0.02 + chromaOffset * 0.004, 0, 0.15),
      systemBaseLightness,
      chatBaseLightness: systemBaseLightness,
      sidebarBaseLightness: clampTone(96 + lightnessOffset * 0.6, 55, 100),
    }
  }

  const systemBaseLightness = clampTone(17 + lightnessOffset * 0.45, 10, 32)
  return {
    hue,
    tintChroma: clampTone(0.015 + chromaOffset * 0.003, 0, 0.12),
    systemBaseLightness,
    chatBaseLightness: clampTone(21 + lightnessOffset * 0.5, 12, 36),
    sidebarBaseLightness: clampTone(18.5 + lightnessOffset * 0.5, 10, 34),
  }
}

/** Keep stored tone hex in sync with hue + slider offsets (picker display only). */
export function canonicalizeBackgroundTone(
  backgroundHex: string,
  lightnessOffset: number,
  chromaOffset: number,
  mode: 'light' | 'dark',
): string {
  const hue = extractBackgroundHue(backgroundHex) ?? 200
  return composeBackgroundToneHex(hue, lightnessOffset, chromaOffset, mode)
}

/**
 * Build the background-tone swatch shown in ColorPicker from hue + slider offsets.
 * Sliders move → picker updates via this.
 */
export function composeBackgroundToneHex(
  hue: number,
  lightnessOffset: number,
  chromaOffset: number,
  mode: 'light' | 'dark',
): string {
  const ref = TONE_REF[mode]
  const l = clampTone(ref.baseL + lightnessOffset * ref.lStep, ref.minL, ref.maxL)
  const c = clampTone(ref.baseC + chromaOffset * ref.cStep, 0, ref.maxC)
  return oklchToHex(l, c, hue)
}

/**
 * Read hue + slider offsets from a background-tone pick.
 * Picker moves → sliders update via this.
 */
export function decomposeBackgroundToneHex(
  hex: string,
  mode: 'light' | 'dark',
): { hue: number; lightnessOffset: number; chromaOffset: number } | null {
  const oklch = hexToOklch(hex)
  if (!oklch) return null
  const ref = TONE_REF[mode]
  return {
    hue: oklch.h,
    lightnessOffset: clampTone(Math.round((oklch.l - ref.baseL) / ref.lStep), -50, 50),
    chromaOffset: clampTone(Math.round((oklch.c - ref.baseC) / ref.cStep), -30, 30),
  }
}

export function extractBackgroundHue(hex: string): number | null {
  return hexToOklch(hex)?.h ?? null
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
  chromaOffset: number = 0,
  sidebarHex?: string
): ThemePalette {
  const isLight = forcedMode === 'light' || (forcedMode === undefined && isLightColor(accentHex))
  const baseOklch = hexToOklch(accentHex)
  
  if (!baseOklch) {
    throw new Error('Invalid accent color')
  }

  // Use primary color if provided, otherwise use accent
  const primaryColor = primaryHex || accentHex
  
  const surfaces = deriveUiSurfacesFromTone(
    backgroundHex,
    baseOklch.h,
    isLight,
    lightnessOffset,
    chromaOffset,
  )
  const bgHue = surfaces.hue

  // Optional separate hue for the structural "sidebar" surfaces (secondary /
  // tertiary tiers). Falls back to the main background hue when not provided,
  // preserving the original single-colour behaviour.
  let sidebarHue = bgHue
  let sidebarHasOwnHue = false
  if (sidebarHex) {
    const sbOklch = hexToOklch(sidebarHex)
    if (sbOklch) {
      sidebarHue = sbOklch.h
      sidebarHasOwnHue = true
    }
  }
  // Give a user-chosen sidebar colour a touch more tint so it's perceptible
  // against the main surface even at low chroma.
  const sidebarChromaBoost = sidebarHasOwnHue ? 2.2 : 1

  if (isLight) {
    const bgTintChroma = surfaces.tintChroma
    const baseLightness = surfaces.systemBaseLightness
    const bgPrimaryOklch = { l: baseLightness, c: bgTintChroma, h: bgHue }
    const bgSecondaryOklch = { l: clampTone(baseLightness - 2, 55, 100), c: bgTintChroma * sidebarChromaBoost, h: sidebarHue }
    const bgTertiaryOklch = { l: clampTone(baseLightness - 4, 55, 100), c: bgTintChroma * sidebarChromaBoost, h: sidebarHue }
    const sidebarOklch = { l: surfaces.sidebarBaseLightness, c: bgTintChroma * 1.5 * sidebarChromaBoost, h: sidebarHue }
    
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
    const bgTintChroma = surfaces.tintChroma
    const chatBaseLightness = surfaces.chatBaseLightness
    const sidebarBaseLightness = surfaces.sidebarBaseLightness
    const systemBaseLightness = surfaces.systemBaseLightness
    
    const bgChatOklch = { l: chatBaseLightness, c: bgTintChroma, h: bgHue }
    const sidebarOklch = { l: sidebarBaseLightness, c: bgTintChroma * 1.5 * sidebarChromaBoost, h: sidebarHue }
    
    const systemBgPrimaryOklch = { l: systemBaseLightness, c: bgTintChroma, h: bgHue }
    const systemBgSecondaryOklch = { l: clampTone(systemBaseLightness - 1.5, 10, 32), c: bgTintChroma * sidebarChromaBoost, h: sidebarHue }
    const systemBgTertiaryOklch = { l: clampTone(systemBaseLightness - 3.5, 8, 30), c: bgTintChroma * sidebarChromaBoost, h: sidebarHue }
    
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
  
  const isLight = mode === 'light'
  const surfaces = deriveUiSurfacesFromTone(backgroundHex, bgOklch.h, isLight, lightnessOffset, chromaOffset)
  const bgHue = surfaces.hue
  const bgTintChroma = surfaces.tintChroma
  
  if (isLight) {
    const baseLightness = surfaces.systemBaseLightness
    return {
      bgMain: oklchToHex(baseLightness, bgTintChroma, bgHue),
      bgSidebar: oklchToHex(surfaces.sidebarBaseLightness, bgTintChroma * 1.5, bgHue),
      bgHeader: oklchToHex(clampTone(baseLightness - 2, 55, 100), bgTintChroma, bgHue),
    }
  } else {
    return {
      bgMain: oklchToHex(surfaces.chatBaseLightness, bgTintChroma, bgHue),
      bgSidebar: oklchToHex(surfaces.sidebarBaseLightness, bgTintChroma * 1.5, bgHue),
      bgHeader: oklchToHex(surfaces.sidebarBaseLightness, bgTintChroma, bgHue),
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
  
  const bgPrimaryOklch = hexToOklch(palette.bgPrimary)
  const bgSecondaryOklch = hexToOklch(palette.bgSecondary)
  const bgTertiaryOklch = hexToOklch(palette.bgTertiary)

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

  // Senary: darkest layer (picker tabs, emoji/gif popup header, overlays) - always set with theme hue when we have any background
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
  
  root.setAttribute('data-theme', 'custom')
  root.setAttribute('data-theme-type', palette.isLightTheme ? 'light' : 'dark')
  
  applyDerivedSurfaceSemanticTokens(palette)

  debug.log('Applied custom theme palette with OKLCH:', palette)
}

/**
 * Derive rail-button and channel-selection colours from the custom palette
 * (legacy --h-black-darker / --h-sidebar-light OKLCH offsets).
 */
function applyDerivedSurfaceSemanticTokens(palette: ThemePalette): void {
  const root = document.documentElement
  const bgPrimaryOklch = hexToOklch(palette.bgPrimary)
  const bgTertiaryOklch = hexToOklch(palette.bgTertiary)
  const bgSidebarOklch = hexToOklch(palette.bgSidebar)

  if (bgTertiaryOklch) {
    let railL = bgTertiaryOklch.l - 2
    if (palette.isLightTheme && bgPrimaryOklch) {
      // Keep pills visibly distinct on pale tints without losing theme hue.
      railL = Math.min(railL, bgPrimaryOklch.l - 8)
      railL = clampTone(railL, 55, 92)
    }
    root.style.setProperty(
      '--nav-rail-button-bg',
      oklchToString(railL, bgTertiaryOklch.c, bgTertiaryOklch.h),
    )
    root.style.setProperty(
      '--nav-rail-button-icon',
      palette.isLightTheme ? palette.textTertiary : '#f2f3f5',
    )
  }

  if (bgSidebarOklch) {
    const channelBg = oklchToString(
      bgSidebarOklch.l + 4,
      bgSidebarOklch.c,
      bgSidebarOklch.h,
    )
    root.style.setProperty('--channel-item-hover-bg', channelBg)
    root.style.setProperty('--channel-item-selected-bg', channelBg)
  }
}

/**
 * Rail-button and channel-selection colours for built-in preset themes only.
 * Custom themes use {@link applyDerivedSurfaceSemanticTokens} instead.
 */
export function applySurfaceSemanticTokens(
  isLight: boolean,
  preset?: 'dark' | 'light' | 'midnight',
): void {
  const root = document.documentElement

  if (preset === 'midnight') {
    root.style.setProperty('--nav-rail-button-bg', '#0a0b0d')
    root.style.setProperty('--nav-rail-button-icon', '#ffffff')
    root.style.setProperty('--channel-item-hover-bg', '#1f2226')
    root.style.setProperty('--channel-item-selected-bg', '#1f2226')
    return
  }

  if (isLight || preset === 'light') {
    root.style.setProperty('--nav-rail-button-bg', '#d0d2d5')
    root.style.setProperty('--nav-rail-button-icon', '#5e6168')
    root.style.setProperty('--channel-item-hover-bg', '#e3e5e8')
    root.style.setProperty('--channel-item-selected-bg', '#e3e5e8')
    return
  }

  // Default dark preset: pure-black rail pills (legacy --h-black-darker).
  root.style.setProperty('--nav-rail-button-bg', '#000000')
  root.style.setProperty('--nav-rail-button-icon', '#ffffff')
  root.style.setProperty('--channel-item-hover-bg', '#35373c')
  root.style.setProperty('--channel-item-selected-bg', '#35373c')
}

