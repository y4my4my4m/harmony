// emojiService.ts
import { supabase } from '@/supabase';
import { v4 as uuidv4 } from 'uuid';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';
import type { Emoji } from '@/types';
import { debug } from '@/utils/debug'
import { removeFrequentEmoji } from '@/composables/useFrequentEmojis';
import { EmojiFavoriteService } from '@/services/EmojiFavoriteService';
import { invalidateEmojiResolverCache } from '@/services/emojiShortcodeResolver';

const cleanFileName = (originalName: string) => {
    // Remove unwanted characters and trim leading/trailing spaces
    let name = originalName.replace(/[^\w\s.-]/gi, '').trim();

    // Remove leading/trailing periods and extra spaces
    name = name.replace(/^[.]+|[.]+$/g, "").replace(/\s+/g, ' ');

    // Handle multiple extensions: keep the last part after splitting by '.'
    const parts = name.split('.');
    const extension = parts.pop(); // Extract the extension
    let fileNameWithoutExtension = parts.join('.').trim();

    // Remove ALL spaces from the emoji name
    fileNameWithoutExtension = fileNameWithoutExtension.replace(/\s+/g, '');

    // Limit to 20 characters
    if (fileNameWithoutExtension.length > 20) {
        fileNameWithoutExtension = fileNameWithoutExtension.substring(0, 20);
    }

    // Avoid empty filenames
    if (!fileNameWithoutExtension) {
        fileNameWithoutExtension = 'emoji';
    }

    return { name: fileNameWithoutExtension, extension };
};

// Helper to check if a string is a valid UUID
function isValidUUID(str: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
}

async function cleanupEmojiReferences(emoji: Emoji): Promise<void> {
    removeFrequentEmoji(emoji.id);
    await EmojiFavoriteService.getInstance().removeFavorite(emoji.id);
    const emojiCache = useEmojiCacheStore();
    await emojiCache.handleEmojiDelete(emoji);
    invalidateEmojiResolverCache(emoji.name);
}

// Enhanced emoji usage tracking with context
async function recordEmojiUsage(
    emojiId: string, 
    userId: string, 
    serverId: string, 
    contextType: 'message' | 'reaction', 
    contextId?: string
): Promise<void> {
    try {
        // Skip recording for native Unicode emojis (non-UUID emoji IDs)
        // Native emojis use the unicode character as their ID
        if (!isValidUUID(emojiId)) {
            debug.log('📊 Skipping emoji usage tracking for native emoji:', emojiId);
            return;
        }
        
        const { error } = await supabase.rpc('record_emoji_usage', {
            p_emoji_id: emojiId,
            p_user_id: userId,
            p_server_id: serverId,
            p_context_type: contextType,
            p_context_id: contextId || null
        });
        
        if (error) {
            debug.error('Error recording emoji usage:', error);
        }
    } catch (error) {
        debug.error('Error calling record_emoji_usage:', error);
    }
}

// Get detailed emoji analytics for a server
async function getDetailedEmojiAnalytics(serverId: string, userId?: string, limit = 10) {
    try {
        const { data, error } = await supabase.rpc('get_emoji_usage_analytics', {
            p_server_id: serverId,
            p_user_id: userId || null,
            p_limit: limit
        });
        
        if (error) {
            debug.error('Error fetching emoji analytics:', error);
            return [];
        }
        
        return data;
    } catch (error) {
        debug.error('Error in getDetailedEmojiAnalytics:', error);
        return [];
    }
}

// Get user's personal emoji statistics
async function getUserEmojiStats(userId: string, serverId?: string, limit = 20) {
    try {
        const { data, error } = await supabase.rpc('get_user_emoji_stats', {
            p_user_id: userId,
            p_server_id: serverId || null,
            p_limit: limit
        });
        
        if (error) {
            debug.error('Error fetching user emoji stats:', error);
            return [];
        }
        
        return data;
    } catch (error) {
        debug.error('Error in getUserEmojiStats:', error);
        return [];
    }
}

// Enhanced emoji retrieval with context-aware usage tracking
async function getEmoji(emojiId: string, trackUsage?: {
    userId: string;
    serverId: string;
    contextType: 'message' | 'reaction';
    contextId?: string;
}): Promise<Emoji | null> {
    const emojiCache = useEmojiCacheStore();
    
    // Try cache first
    const cachedEmoji = emojiCache.getEmojiById(emojiId);
    if (cachedEmoji) {
        // Record usage if tracking info provided
        if (trackUsage) {
            await recordEmojiUsage(
                emojiId,
                trackUsage.userId,
                trackUsage.serverId,
                trackUsage.contextType,
                trackUsage.contextId
            );
        }
        return cachedEmoji;
    }
    
    // Fall back to database
    try {
        const { data, error } = await supabase
            .from('emojis')
            .select()
            .eq('id', emojiId)
            .single();

        if (error) {
            debug.error('Error getting emoji:', error);
            return null;
        }
        
        // Record usage if tracking info provided
        if (trackUsage && data) {
            await recordEmojiUsage(
                emojiId,
                trackUsage.userId,
                trackUsage.serverId,
                trackUsage.contextType,
                trackUsage.contextId
            );
        }
        
        // Cache the result for future use
        if (data) {
            await emojiCache.invalidate({ emojiId });
        }
        
        return data;
    } catch (error) {
        debug.error('Error fetching emoji:', error);
        return null;
    }
}

const PIXEL_ART_THRESHOLD = 20;
const PIXEL_ART_UPSCALE_SIZE = 128;

/**
 * Upscale tiny images (likely pixel art) using nearest-neighbor interpolation
 * so imgproxy won't blur them with smooth scaling later.
 */
async function upscalePixelArt(file: File): Promise<File> {
    if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') return file;

    const img = await createImageBitmap(file);
    const { width, height } = img;

    if (width >= PIXEL_ART_THRESHOLD && height >= PIXEL_ART_THRESHOLD) {
        img.close();
        return file;
    }

    const scale = Math.floor(PIXEL_ART_UPSCALE_SIZE / Math.max(width, height));
    if (scale <= 1) { img.close(); return file; }

    const canvas = new OffscreenCanvas(width * scale, height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, width * scale, height * scale);
    img.close();

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const ext = file.name.lastIndexOf('.');
    const newName = ext > 0 ? file.name.substring(0, ext) + '.png' : file.name + '.png';
    return new File([blob], newName, { type: 'image/png' });
}

// Enhanced emoji upload with cache invalidation
async function uploadEmoji(serverId: string, userId: string, file: File): Promise<Emoji | null> {
    const emojiCache = useEmojiCacheStore();
    
    try {
        // Upscale tiny pixel art before upload so imgproxy only downscales
        file = await upscalePixelArt(file);

        const { name: cleanedName, extension } = cleanFileName(file.name);
        
        // Check if the emoji name already exists and find a unique name
        let uniqueName = cleanedName;
        let counter = 1;
        while (await doesEmojiNameExist(serverId, uniqueName)) {
            uniqueName = `${cleanedName}_${counter}`;
            counter++;
        }

        const uniqueEmojiName = `${uuidv4()}.${extension}`;
        const filePath = `${serverId}/${userId}/${uniqueEmojiName}`;
        
        // Upload the file
        const { error } = await supabase.storage
            .from('emojis')
            .upload(filePath, file);

        if (error) throw error;

        // Retrieve the file URL
        const { data } = await supabase.storage
            .from('emojis')
            .getPublicUrl(filePath);

        debug.log("Emoji uploaded successfully");

        // Add entry to database
        const newEmoji = {
            name: uniqueName,
            url: data.publicUrl,
            server_id: serverId,
            uploader: userId,
            file_size: file.size,
        };

        const { data: emojiData, error: fetchError } = await supabase
            .from('emojis')
            .insert([newEmoji])
            .select()
            .single();

        if (fetchError) throw fetchError;

        // Invalidate cache to pick up the new emoji
        await emojiCache.invalidate({ serverId });

        return emojiData;
    } catch (error) {
        debug.error('Error uploading emoji:', error);
        return null;
    }
}

// Enhanced emoji deletion with cache invalidation
async function deleteEmoji(emojiId: string): Promise<boolean> {
    try {
        // Get emoji details before deletion for cache invalidation
        const emoji = await getEmoji(emojiId);
        if (!emoji) {
            debug.error('Emoji not found for deletion:', emojiId);
            return false;
        }

        // Delete from storage
        const urlParts = emoji.url.split('/');
        const fileName = urlParts[urlParts.length - 1];
        const filePath = `${emoji.server_id}/${emoji.uploader}/${fileName}`;
        
        const { error: storageError } = await supabase.storage
            .from('emojis')
            .remove([filePath]);

        if (storageError) {
            debug.error('Error deleting emoji from storage:', storageError);
            // Continue with database deletion even if storage fails
        }

        // Delete from database
        const { error: dbError } = await supabase
            .from('emojis')
            .delete()
            .eq('id', emojiId);

        if (dbError) throw dbError;

        await cleanupEmojiReferences(emoji);

        debug.log('Emoji deleted successfully:', emoji.name);
        return true;
    } catch (error: any) {
        if (error?.code === '23503') {
            debug.error('Emoji delete blocked by foreign key references:', error);
        } else {
            debug.error('Error deleting emoji:', error);
        }
        return false;
    }
}

// Rename emoji with cache invalidation
async function renameEmoji(emojiId: string, newName: string, serverId: string): Promise<boolean> {
    const emojiCache = useEmojiCacheStore();
    
    try {
        // Get current emoji to check if name is actually changing
        const currentEmoji = await getEmoji(emojiId);
        if (!currentEmoji) {
            throw new Error('Emoji not found');
        }
        
        // Clean and validate the new name
        const { name: cleanedName } = cleanFileName(`${newName}.png`);
        
        if (!cleanedName || cleanedName.length === 0) {
            throw new Error('Invalid emoji name');
        }
        
        // If the name isn't changing, just return success
        if (currentEmoji.name === cleanedName) {
            debug.log('Emoji name unchanged:', cleanedName);
            return true;
        }
        
        // Check if the new name already exists
        if (await doesEmojiNameExist(serverId, cleanedName)) {
            throw new Error('An emoji with this name already exists');
        }
        
        // Update the emoji name in the database
        const { error } = await supabase
            .from('emojis')
            .update({ name: cleanedName })
            .eq('id', emojiId);

        if (error) throw error;

        // Invalidate cache to reflect the changes
        await emojiCache.invalidate({ serverId });

        debug.log('Emoji renamed successfully:', cleanedName);
        return true;
    } catch (error) {
        debug.error('Error renaming emoji:', error);
        return false;
    }
}

// Bulk delete emojis with cache invalidation
async function bulkDeleteEmojis(emojiIds: string[]): Promise<{ success: string[], failed: string[] }> {
    const results = { success: [] as string[], failed: [] as string[] };
    
    debug.log(`Starting bulk deletion of ${emojiIds.length} emojis`);

    // Fetch all emojis in one query
    const { data: emojis, error: fetchError } = await supabase
        .from('emojis')
        .select('*')
        .in('id', emojiIds);

    if (fetchError) {
        debug.error('Failed to fetch emojis for bulk delete:', fetchError);
        return { success: [], failed: emojiIds };
    }

    const emojiMap = new Map((emojis || []).map(e => [e.id, e]));

    // Build storage paths for batch removal
    const storagePaths: string[] = [];
    for (const emoji of emojis || []) {
        const urlParts = emoji.url.split('/');
        const fileName = urlParts[urlParts.length - 1];
        storagePaths.push(`${emoji.server_id}/${emoji.uploader}/${fileName}`);
    }

    // Batch delete from storage (Supabase .remove() accepts an array)
    if (storagePaths.length > 0) {
        const { error: storageError } = await supabase.storage
            .from('emojis')
            .remove(storagePaths);

        if (storageError) {
            debug.warn('Batch storage deletion had errors:', storageError);
        }
    }

    // Batch delete from database
    const foundIds = (emojis || []).map(e => e.id);
    if (foundIds.length > 0) {
        const { error: dbError } = await supabase
            .from('emojis')
            .delete()
            .in('id', foundIds);

        if (dbError) {
            debug.error('Batch DB deletion failed:', dbError);
            results.failed = emojiIds;
        } else {
            results.success = foundIds;
            results.failed = emojiIds.filter(id => !emojiMap.has(id));

            for (const id of foundIds) {
                const emoji = emojiMap.get(id);
                if (emoji) {
                    await cleanupEmojiReferences(emoji as Emoji);
                }
            }
        }
    } else {
        results.failed = emojiIds;
    }
    
    debug.log(`Bulk deletion completed: ${results.success.length}/${emojiIds.length} successful`);
    
    return results;
}

// Enhanced name existence check with caching
async function doesEmojiNameExist(serverId: string, name: string): Promise<boolean> {
    const emojiCache = useEmojiCacheStore();
    
    // Check cache first for performance
    const serverEmojis = emojiCache.getServerEmojis(serverId);
    const existsInCache = serverEmojis.some(emoji => emoji.name === name);
    
    if (existsInCache) {
        return true;
    }
    
    // Fall back to database check
    try {
        const { data, error } = await supabase
            .from('emojis')
            .select('id')
            .eq('server_id', serverId)
            .eq('name', name);

        if (error) {
            debug.error('Error checking emoji name existence:', error);
            throw error;
        }
        
        return data.length > 0;
    } catch (error) {
        debug.error('Error in name existence check:', error);
        return false;
    }
}

export interface BulkUploadProgress {
    current: number;
    completed: number;
    failed: number;
    total: number;
    currentFile: string;
}

async function bulkUploadEmojis(
    serverId: string,
    userId: string,
    files: File[],
    onProgress?: (progress: BulkUploadProgress) => void
): Promise<(Emoji | null)[]> {
    const results: (Emoji | null)[] = [];
    const emojiCache = useEmojiCacheStore();
    let completed = 0;
    let failed = 0;
    
    debug.log(`Starting bulk upload of ${files.length} emojis for server ${serverId}`);
    
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        onProgress?.({ current: i + 1, completed, failed, total: files.length, currentFile: file.name });
        
        try {
            const result = await uploadEmoji(serverId, userId, file);
            results.push(result);
            if (result) completed++; else failed++;
            
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
            debug.error(`Failed to upload ${file.name}:`, error);
            results.push(null);
            failed++;
        }
        
        onProgress?.({ current: i + 1, completed, failed, total: files.length, currentFile: file.name });
    }
    
    await emojiCache.invalidate({ serverId });
    
    debug.log(`Bulk upload completed: ${completed}/${files.length} successful`);
    
    return results;
}

// Search emojis with advanced filtering
async function searchEmojis(query: string, options: {
    serverId?: string;
    limit?: number;
    includeServerName?: boolean;
} = {}): Promise<any[]> {
    const emojiCache = useEmojiCacheStore();
    const { serverId, limit = 20, includeServerName = false } = options;
    
    if (serverId) {
        // Search within specific server
        const serverEmojis = emojiCache.getServerEmojis(serverId);
        return serverEmojis
            .filter(emoji => emoji.name.toLowerCase().includes(query.toLowerCase()))
            .slice(0, limit)
            .map(emoji => ({
                ...emoji,
                serverName: includeServerName ? emojiCache.serverCaches.get(serverId)?.serverName : undefined
            }));
    } else {
        // Search across all servers
        return emojiCache.searchEmojisByName(query, limit);
    }
}

// Get emoji analytics for a server
async function getServerEmojiAnalytics(serverId: string) {
    const emojiCache = useEmojiCacheStore();
    const serverEmojis = emojiCache.getServerEmojis(serverId);
    
    // Get usage statistics from cache
    const analytics = {
        totalEmojis: serverEmojis.length,
        mostUsedEmojis: serverEmojis
            .map(emoji => {
                const cacheEntry = emojiCache.globalEmojiIndex.get(emoji.id);
                return {
                    ...emoji,
                    usageCount: cacheEntry?.accessCount || 0,
                    lastUsed: cacheEntry?.lastAccessed || null
                };
            })
            .sort((a, b) => b.usageCount - a.usageCount)
            .slice(0, 10),
        leastUsedEmojis: serverEmojis
            .map(emoji => {
                const cacheEntry = emojiCache.globalEmojiIndex.get(emoji.id);
                return {
                    ...emoji,
                    usageCount: cacheEntry?.accessCount || 0
                };
            })
            .sort((a, b) => a.usageCount - b.usageCount)
            .slice(0, 5),
        averageUsage: serverEmojis.reduce((sum, emoji) => {
            const cacheEntry = emojiCache.globalEmojiIndex.get(emoji.id);
            return sum + (cacheEntry?.accessCount || 0);
        }, 0) / serverEmojis.length || 0
    };
    
    return analytics;
}

// Preload frequently used emojis
async function preloadFrequentEmojis(serverIds: string[] = []) {
    try {
        // Get most used emojis from analytics
        const { data, error } = await supabase
            .rpc('get_most_used_emojis', { 
                server_ids: serverIds.length > 0 ? serverIds : null,
                limit: 100 
            });
            
        if (error) {
            debug.error('Error fetching frequent emojis:', error);
            return;
        }
        
        // Ensure these emojis are cached
        const emojiIds = data.map((item: any) => item.emoji_id);
        for (const emojiId of emojiIds) {
            await getEmoji(emojiId); // This will cache them
        }
        
        debug.log(`🚀 Preloaded ${emojiIds.length} frequent emojis`);
    } catch (error) {
        debug.error('Error preloading frequent emojis:', error);
    }
}

export { 
    uploadEmoji, 
    getEmoji, 
    deleteEmoji, 
    renameEmoji,
    bulkDeleteEmojis,
    doesEmojiNameExist,
    bulkUploadEmojis,
    searchEmojis,
    getServerEmojiAnalytics,
    preloadFrequentEmojis,
    recordEmojiUsage,
    getDetailedEmojiAnalytics,
    getUserEmojiStats
};
