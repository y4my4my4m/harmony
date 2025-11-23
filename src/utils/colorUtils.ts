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
 * Convert XYZ to LAB
 */
function xyzToLab(x: number, y: number, z: number): { l: number; a: number; b: number } {
  // D65 white point
  const xn = 0.95047
  const yn = 1.00000
  const zn = 1.08883

  x = x / xn
  y = y / yn
  z = z / zn

  const f = (t: number) => {
    const delta = 6 / 29
    return t > Math.pow(delta, 3)
      ? Math.pow(t, 1 / 3)
      : t / (3 * delta * delta) + 4 / 29
  }

  const fx = f(x)
  const fy = f(y)
  const fz = f(z)

  const l = 116 * fy - 16
  const a = 500 * (fx - fy)
  const b = 200 * (fy - fz)

  return { l, a, b }
}

/**
 * Convert LAB to XYZ
 */
function labToXyz(l: number, a: number, b: number): { x: number; y: number; z: number } {
  // D65 white point
  const xn = 0.95047
  const yn = 1.00000
  const zn = 1.08883

  const fy = (l + 16) / 116
  const fx = a / 500 + fy
  const fz = fy - b / 200

  const f = (t: number) => {
    const delta = 6 / 29
    return t > delta
      ? Math.pow(t, 3)
      : 3 * delta * delta * (t - 4 / 29)
  }

  return {
    x: xn * f(fx),
    y: yn * f(fy),
    z: zn * f(fz),
  }
}

/**
 * Convert LAB to LCH
 */
function labToLch(l: number, a: number, b: number): { l: number; c: number; h: number } {
  const c = Math.sqrt(a * a + b * b)
  let h = Math.atan2(b, a) * 180 / Math.PI
  if (h < 0) h += 360

  return { l, c, h }
}

/**
 * Convert LCH to LAB
 */
function lchToLab(l: number, c: number, h: number): { l: number; a: number; b: number } {
  const hRad = h * Math.PI / 180
  const a = c * Math.cos(hRad)
  const b = c * Math.sin(hRad)

  return { l, a, b }
}

/**
 * Convert RGB to OKLCH
 */
export function rgbToOklch(r: number, g: number, b: number): { l: number; c: number; h: number } {
  const xyz = rgbToXyz(r, g, b)
  const lab = xyzToLab(xyz.x, xyz.y, xyz.z)
  return labToLch(lab.l, lab.a, lab.b)
}

/**
 * Convert OKLCH to RGB
 */
export function oklchToRgb(l: number, c: number, h: number): { r: number; g: number; b: number } {
  const lab = lchToLab(l, c, h)
  const xyz = labToXyz(lab.l, lab.a, lab.b)
  return xyzToRgb(xyz.x, xyz.y, xyz.z)
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
    
    const bgChatOklch = { l: 20, c: bgTintChroma, h: bgHue }
    const bgSecondaryOklch = { l: 18, c: bgTintChroma, h: bgHue }
    const bgTertiaryOklch = { l: 16, c: bgTintChroma, h: bgHue }
    const sidebarOklch = { l: 17, c: bgTintChroma * 1.5, h: bgHue }
    
    return {
      primary: accentHex,
      primaryHover: adjustLightness(accentHex, -8),
      primaryLight: adjustLightness(accentHex, 15),
      primaryDark: adjustLightness(accentHex, -12),
      
      bgPrimary: oklchToHex(bgChatOklch.l, bgChatOklch.c, bgChatOklch.h),
      bgSecondary: oklchToHex(bgSecondaryOklch.l, bgSecondaryOklch.c, bgSecondaryOklch.h),
      bgTertiary: oklchToHex(bgTertiaryOklch.l, bgTertiaryOklch.c, bgTertiaryOklch.h),
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
 * Apply theme palette to CSS custom properties
 */
export function applyThemePalette(palette: ThemePalette): void {
  const root = document.documentElement
  
  // Primary colors
  root.style.setProperty('--harmony-primary', palette.primary)
  root.style.setProperty('--harmony-primary-hover', palette.primaryHover)
  root.style.setProperty('--harmony-primary-light', palette.primaryLight)
  root.style.setProperty('--h-primary', palette.primary)
  root.style.setProperty('--h-primary-light', palette.primaryLight)
  root.style.setProperty('--h-primary-dark', palette.primaryDark)
  
  // Background colors - Apply to ALL background variables
  root.style.setProperty('--h-chat', palette.bgChat)
  root.style.setProperty('--h-chat-light', adjustLightness(palette.bgChat, 3))
  root.style.setProperty('--h-chat-lighter', adjustLightness(palette.bgChat, 5))
  root.style.setProperty('--h-chat-dark', adjustLightness(palette.bgChat, -3))
  root.style.setProperty('--h-chat-darker', adjustLightness(palette.bgChat, -8))
  
  root.style.setProperty('--h-sidebar', palette.bgSidebar)
  root.style.setProperty('--h-sidebar-light', adjustLightness(palette.bgSidebar, 4))
  
  root.style.setProperty('--h-black', palette.bgTertiary)
  root.style.setProperty('--h-black-light', adjustLightness(palette.bgTertiary, 5))
  root.style.setProperty('--h-black-lighter', adjustLightness(palette.bgTertiary, 8))
  root.style.setProperty('--h-black-darker', adjustLightness(palette.bgTertiary, -5))
  
  // Background system colors
  root.style.setProperty('--background-primary', palette.bgPrimary)
  root.style.setProperty('--background-secondary', palette.bgSecondary)
  root.style.setProperty('--background-tertiary', palette.bgTertiary)
  root.style.setProperty('--background-quaternary', adjustLightness(palette.bgSecondary, 2))
  root.style.setProperty('--background-quinary', adjustLightness(palette.bgTertiary, 2))
  
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
  
  console.log('🎨 Applied custom theme palette:', palette)
}

