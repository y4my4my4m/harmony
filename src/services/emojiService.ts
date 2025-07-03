// emojiService.ts
import { supabase } from '@/supabase';
import { v4 as uuidv4 } from 'uuid';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';
import type { Emoji } from '@/types';

const cleanFileName = (originalName: string) => {
    // Remove unwanted characters and trim leading/trailing spaces
    let name = originalName.replace(/[^\w\s.-]/gi, '').trim();

    // Remove leading/trailing periods and extra spaces
    name = name.replace(/^[.]+|[.]+$/g, "").replace(/\s+/g, ' ');

    // Handle multiple extensions: keep the last part after splitting by '.'
    const parts = name.split('.');
    const extension = parts.pop(); // Extract the extension
    let fileNameWithoutExtension = parts.join('.').trim();

    // Avoid empty filenames
    if (!fileNameWithoutExtension) {
        fileNameWithoutExtension = 'emoji';
    }

    return { name: fileNameWithoutExtension, extension };
};

// Enhanced emoji usage tracking with context
async function recordEmojiUsage(
    emojiId: string, 
    userId: string, 
    serverId: string, 
    contextType: 'message' | 'reaction', 
    contextId?: string
): Promise<void> {
    try {
        const { error } = await supabase.rpc('record_emoji_usage', {
            p_emoji_id: emojiId,
            p_user_id: userId,
            p_server_id: serverId,
            p_context_type: contextType,
            p_context_id: contextId || null
        });
        
        if (error) {
            console.error('Error recording emoji usage:', error);
        }
    } catch (error) {
        console.error('Error calling record_emoji_usage:', error);
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
            console.error('Error fetching emoji analytics:', error);
            return [];
        }
        
        return data;
    } catch (error) {
        console.error('Error in getDetailedEmojiAnalytics:', error);
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
            console.error('Error fetching user emoji stats:', error);
            return [];
        }
        
        return data;
    } catch (error) {
        console.error('Error in getUserEmojiStats:', error);
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
            console.error('Error getting emoji:', error);
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
        console.error('Error fetching emoji:', error);
        return null;
    }
}

// Enhanced emoji upload with cache invalidation
async function uploadEmoji(serverId: string, userId: string, file: File): Promise<Emoji | null> {
    const emojiCache = useEmojiCacheStore();
    
    try {
        const { name: cleanedName, extension } = cleanFileName(file.name);
        
        // Check if the emoji name already exists and find a unique name
        let uniqueName = cleanedName;
        let counter = 1;
        while (await doesEmojiNameExist(serverId, uniqueName)) {
            uniqueName = `${cleanedName}~${counter}`;
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

        console.log("Emoji uploaded successfully");

        // Add entry to database
        const newEmoji = {
            name: uniqueName,
            url: data.publicUrl,
            server_id: serverId,
            uploader: userId,
            created_at: new Date()
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
        console.error('Error uploading emoji:', error);
        return null;
    }
}

// Enhanced emoji deletion with cache invalidation
async function deleteEmoji(emojiId: string): Promise<boolean> {
    const emojiCache = useEmojiCacheStore();
    
    try {
        // Get emoji details before deletion for cache invalidation
        const emoji = await getEmoji(emojiId);
        if (!emoji) {
            console.error('Emoji not found for deletion:', emojiId);
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
            console.error('Error deleting emoji from storage:', storageError);
            // Continue with database deletion even if storage fails
        }

        // Delete from database
        const { error: dbError } = await supabase
            .from('emojis')
            .delete()
            .eq('id', emojiId);

        if (dbError) throw dbError;

        // Invalidate cache
        await emojiCache.invalidate({ serverId: emoji.server_id });

        console.log('Emoji deleted successfully:', emoji.name);
        return true;
    } catch (error) {
        console.error('Error deleting emoji:', error);
        return false;
    }
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
            console.error('Error checking emoji name existence:', error);
            throw error;
        }
        
        return data.length > 0;
    } catch (error) {
        console.error('Error in name existence check:', error);
        return false;
    }
}

// Bulk emoji operations for efficiency
async function bulkUploadEmojis(serverId: string, userId: string, files: File[]): Promise<(Emoji | null)[]> {
    const results: (Emoji | null)[] = [];
    const emojiCache = useEmojiCacheStore();
    
    console.log(`Starting bulk upload of ${files.length} emojis for server ${serverId}`);
    
    for (const file of files) {
        try {
            const result = await uploadEmoji(serverId, userId, file);
            results.push(result);
            
            // Small delay to prevent overwhelming the server
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
            console.error(`Failed to upload ${file.name}:`, error);
            results.push(null);
        }
    }
    
    // Single cache invalidation after all uploads
    await emojiCache.invalidate({ serverId });
    
    const successCount = results.filter(r => r !== null).length;
    console.log(`Bulk upload completed: ${successCount}/${files.length} successful`);
    
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
    const emojiCache = useEmojiCacheStore();
    
    try {
        // Get most used emojis from analytics
        const { data, error } = await supabase
            .rpc('get_most_used_emojis', { 
                server_ids: serverIds.length > 0 ? serverIds : null,
                limit: 100 
            });
            
        if (error) {
            console.error('Error fetching frequent emojis:', error);
            return;
        }
        
        // Ensure these emojis are cached
        const emojiIds = data.map((item: any) => item.emoji_id);
        for (const emojiId of emojiIds) {
            await getEmoji(emojiId); // This will cache them
        }
        
        console.log(`🚀 Preloaded ${emojiIds.length} frequent emojis`);
    } catch (error) {
        console.error('Error preloading frequent emojis:', error);
    }
}

export { 
    uploadEmoji, 
    getEmoji, 
    deleteEmoji, 
    doesEmojiNameExist,
    bulkUploadEmojis,
    searchEmojis,
    getServerEmojiAnalytics,
    preloadFrequentEmojis,
    recordEmojiUsage,
    getDetailedEmojiAnalytics,
    getUserEmojiStats
};
