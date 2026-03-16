import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

/**
 * Group Icon Utilities
 * 
 * Follows the same pattern as server icons:
 * - Store relative path in database
 * - Fetch from bucket with transforms for optimization
 * - Support resizing and quality optimization
 */

const BUCKET_NAME = 'group-icons'
const DEFAULT_QUALITY = 80
const DEFAULT_SIZE = 128

/**
 * Get the raw public URL for a group icon (no imgproxy transform).
 * Use when the transform endpoint returns 400 (e.g. imgproxy not enabled on self-hosted).
 */
export function getGroupIconUrlRaw(
  conversationId: string,
  iconPath: string | null | undefined
): string {
  if (!iconPath) {
    return getDefaultGroupIcon(conversationId, DEFAULT_SIZE)
  }
  try {
    const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(iconPath)
    return data?.publicUrl ? data.publicUrl : getDefaultGroupIcon(conversationId, DEFAULT_SIZE)
  } catch {
    return getDefaultGroupIcon(conversationId, DEFAULT_SIZE)
  }
}

/**
 * Get the full URL for a group icon with optional transformations (imgproxy).
 * Prefer this for bandwidth/UX; use getGroupIconUrlRaw or component fallback when transform returns 400.
 */
export function getGroupIconUrl(
  conversationId: string,
  iconPath: string | null | undefined,
  options: {
    size?: number
    quality?: number
  } = {}
): string {
  if (!iconPath) {
    return getDefaultGroupIcon(conversationId, options.size)
  }

  const { size = DEFAULT_SIZE, quality = DEFAULT_QUALITY } = options

  try {
    const { data } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(iconPath, {
        transform: {
          width: size,
          height: size,
          quality: quality,
          resize: 'cover'
        }
      })

    // Ensure we have a valid URL before returning
    if (!data.publicUrl) {
      debug.warn('No public URL returned for icon path:', iconPath)
      return getDefaultGroupIcon(conversationId, size)
    }

    return data.publicUrl
  } catch (error) {
    debug.error('Failed to get group icon URL:', error)
    return getDefaultGroupIcon(conversationId, options.size)
  }
}

/**
 * Generate a default group icon (similar to Discord's algorithm)
 */
export function getDefaultGroupIcon(conversationId: string, size: number = DEFAULT_SIZE): string {
  // Create a simple hash from conversation ID for consistent colors
  const hash = conversationId.split('').reduce((a, b) => {
    a = ((a << 5) - a) + b.charCodeAt(0)
    return a & a
  }, 0)

  const colors = [
    '#0EA5E9', // Discord Blue
    '#57F287', // Green
    '#FEE75C', // Yellow
    '#ED4245', // Red
    '#EB459E', // Pink
    '#9C59B6', // Purple
    '#E67E22', // Orange
    '#1ABC9C', // Teal
  ]

  const color = colors[Math.abs(hash) % colors.length]
  
  // Create SVG with group icon
  const svg = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" fill="${color}" rx="${size * 0.2}"/>
      <g transform="translate(${size * 0.25}, ${size * 0.25})">
        <svg width="${size * 0.5}" height="${size * 0.5}" viewBox="0 0 24 24" fill="white">
          <path d="M16,4C18.22,4 20,5.78 20,8C20,10.22 18.22,12 16,12C13.78,12 12,10.22 12,8C12,5.78 13.78,4 16,4M16,5.9C14.84,5.9 13.9,6.84 13.9,8C13.9,9.16 14.84,10.1 16,10.1C17.16,10.1 18.1,9.16 18.1,8C18.1,6.84 17.16,5.9 16,5.9M8,4C10.22,4 12,5.78 12,8C12,10.22 10.22,12 8,12C5.78,12 4,10.22 4,8C4,5.78 5.78,4 8,4M8,5.9C6.84,5.9 5.9,6.84 5.9,8C5.9,9.16 6.84,10.1 8,10.1C9.16,10.1 10.1,9.16 10.1,8C10.1,6.84 9.16,5.9 8,5.9M16,13.5C18.67,13.5 24,14.83 24,17.5V20H8V17.5C8,14.83 13.33,13.5 16,13.5M8,13.5C11.33,13.5 16,14.83 16,17.5V20H0V17.5C0,14.83 4.67,13.5 8,13.5Z"/>
        </svg>
      </g>
    </svg>
  `.trim()

  return `data:image/svg+xml;base64,${btoa(svg)}`
}

/**
 * Upload a group icon file
 */
export async function uploadGroupIcon(
  conversationId: string,
  file: File,
  onProgress?: (progress: number) => void
): Promise<{ success: boolean; iconPath?: string; error?: string }> {
  try {
    // Validate file
    if (!file.type.startsWith('image/')) {
      return { success: false, error: 'File must be an image' }
    }

    // Check file size (max 5MB)
    const maxSize = 5 * 1024 * 1024
    if (file.size > maxSize) {
      return { success: false, error: 'File size must be less than 5MB' }
    }

    // Generate unique filename
    const fileExt = file.name.split('.').pop()
    const fileName = `${Date.now()}-${Math.random().toString(36).substring(2)}.${fileExt}`
    const filePath = `${conversationId}/${fileName}`

    // Upload to storage
    const { data, error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: true // Allow overwriting existing group icons
      })

    if (uploadError) {
      debug.error('Upload error:', uploadError)
      return { success: false, error: uploadError.message }
    }

    // Get current user profile ID
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      throw new Error('User not authenticated')
    }

    // Get profile ID from auth user
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single()

    if (profileError || !profile) {
      throw new Error('User profile not found')
    }

    // Update conversation metadata with new icon path
    const { data: updateResult, error: updateError } = await supabase.rpc('update_group_icon', {
      conversation_uuid: conversationId,
      user_profile_id: profile.id,
      icon_path: filePath
    })

    if (updateError) {
      debug.error('Database update error:', updateError)
      // Clean up uploaded file if database update fails
      await supabase.storage.from(BUCKET_NAME).remove([filePath])
      return { success: false, error: 'Failed to update group settings' }
    }

    return { success: true, iconPath: filePath }

  } catch (error: any) {
    debug.error('Group icon upload failed:', error)
    return { success: false, error: error.message || 'Upload failed' }
  }
}

/**
 * Delete a group icon
 */
export async function deleteGroupIcon(conversationId: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Get current icon path from conversation
    const { data: conversation, error: fetchError } = await supabase
      .from('conversations')
      .select('metadata')
      .eq('id', conversationId)
      .single()

    if (fetchError || !conversation?.metadata?.icon_url) {
      return { success: false, error: 'No icon to delete' }
    }

    const iconPath = conversation.metadata.icon_url

    // Get current user profile ID
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      throw new Error('User not authenticated')
    }

    // Get profile ID from auth user
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single()

    if (profileError || !profile) {
      throw new Error('User profile not found')
    }

    // Remove icon from conversation metadata
    const { error: updateError } = await supabase.rpc('remove_group_icon', {
      conversation_uuid: conversationId,
      user_profile_id: profile.id
    })

    if (updateError) {
      debug.error('Database update error:', updateError)
      return { success: false, error: 'Failed to update group settings' }
    }

    // Delete file from storage
    const { error: deleteError } = await supabase.storage
      .from(BUCKET_NAME)
      .remove([iconPath])

    if (deleteError) {
      debug.warn('Failed to delete icon file from storage:', deleteError)
      // Don't fail the operation since database was updated successfully
    }

    return { success: true }

  } catch (error: any) {
    debug.error('Group icon deletion failed:', error)
    return { success: false, error: error.message || 'Deletion failed' }
  }
}

/**
 * Get optimized group icon URL for different contexts
 */
export const GroupIconPresets = {
  /** Small icons for sidebar/lists (32px) */
  small: (conversationId: string, iconPath?: string) => 
    getGroupIconUrl(conversationId, iconPath, { size: 32, quality: 75 }),
  
  /** Medium icons for headers (48px) */
  medium: (conversationId: string, iconPath?: string) => 
    getGroupIconUrl(conversationId, iconPath, { size: 48, quality: 80 }),
  
  /** Large icons for modals/settings (128px) */
  large: (conversationId: string, iconPath?: string) => 
    getGroupIconUrl(conversationId, iconPath, { size: 128, quality: 85 }),
  
  /** Profile display (256px) */
  profile: (conversationId: string, iconPath?: string) => 
    getGroupIconUrl(conversationId, iconPath, { size: 256, quality: 90 })
}