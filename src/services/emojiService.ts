// emojiService.ts
import { supabase } from '@/supabase';
import { apiUrl } from '@/services/instanceConfig';
import { v4 as uuidv4 } from 'uuid';
import { useEmojiCacheStore, PERSONAL_EMOJI_GROUPS } from '@/stores/useEmojiCache';
import type { Emoji } from '@/types';
import { debug } from '@/utils/debug'
import { removeFrequentEmoji } from '@/composables/useFrequentEmojis';
import { EmojiFavoriteService } from '@/services/EmojiFavoriteService';
import { invalidateEmojiResolverCache } from '@/services/emojiShortcodeResolver';
import { isAnimatedImage, prepareImageUpload, type PreparedImage } from '@/utils/imageResize';
import { UploadRejectedError, getBucketLimits, imageSourceError, validateImageUpload } from '@/utils/uploadValidation';
import { storePublicImage, type PublicImageUploadOptions } from '@/services/uploads/storageUpload';

const cleanFileName = (originalName: string) => {
    let name = originalName.replace(/[^\w\s.-]/gi, '').trim();

    name = name.replace(/^[.]+|[.]+$/g, "").replace(/\s+/g, ' ');

    // Handle multiple extensions: keep the last part after splitting by '.'
    const parts = name.split('.');
    const extension = parts.pop();
    let fileNameWithoutExtension = parts.join('.').trim();

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

// Records emoji usage with the surrounding context (message or reaction).
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
            debug.log('Skipping emoji usage tracking for native emoji:', emojiId);
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

// Cache-first emoji lookup; records usage when tracking info is supplied.
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
            .is('deleted_at', null)
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
    // Redrawing keeps one frame.
    if (isAnimatedImage(new Uint8Array(await file.arrayBuffer()))) return file;

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

/** Default emoji name for an uploaded file: its stem, [\w.-] only, at most 20 characters. */
function emojiNameFromFile(fileName: string): string {
    return cleanFileName(fileName).name;
}

/**
 * Emoji upload, steps 1-2: pixel-art upscale, downscale to the emojis bucket limits,
 * validation. Throws UploadRejectedError with a user-facing message.
 */
async function prepareEmojiImage(file: File): Promise<PreparedImage> {
    const sourceError = imageSourceError(file);
    if (sourceError) throw new UploadRejectedError(sourceError);
    // imgproxy only downscales; tiny pixel art is upscaled with nearest-neighbour first.
    const upscaled = await upscalePixelArt(file).catch(() => file);
    const prepared = await prepareImageUpload(upscaled, 'emoji', await getBucketLimits('emojis'));
    const validationError = await validateImageUpload(prepared.file, 'emojis');
    if (validationError) throw new UploadRejectedError(validationError);
    return prepared;
}

export type EmojiUploadOptions = PublicImageUploadOptions;

/** Emoji upload, step 3: writes the object; returns its public URL. */
function storeEmojiImage(path: string, prepared: PreparedImage, options: EmojiUploadOptions = {}): Promise<string> {
    return storePublicImage('emojis', path, prepared, options);
}

/**
 * Server upload: prepareEmojiImage and storeEmojiImage write <server>/<uploader>/<uuid>.<ext> to
 * the emojis bucket, then create_server_emoji records it under a free name. A refused record
 * removes the object and rethrows: 42501 not a manager, 22023 a bad path or url, 23505 a file
 * already recorded, 23514 SERVER_EMOJI_LIMIT. Throws UploadRejectedError for a file outside the
 * bucket limits.
 */
async function uploadEmoji(serverId: string, userId: string, file: File, options: EmojiUploadOptions = {}): Promise<Emoji | null> {
    const emojiCache = useEmojiCacheStore();

    const label = options.label ?? file.name;
    const prepared = await prepareEmojiImage(file);

    const path = `${serverId}/${userId}/${uuidv4()}.${prepared.extension}`;
    const url = await storeEmojiImage(path, prepared, { ...options, label });
    const { data, error } = await supabase.rpc('create_server_emoji', {
        p_server_id: serverId,
        p_name: emojiNameFromFile(prepared.file.name),
        p_path: path,
        p_url: url,
    });
    if (error || !data) {
        await supabase.storage.from('emojis').remove([path]);
        throw error ?? new Error('create_server_emoji returned no row');
    }

    await emojiCache.invalidate({ serverId });
    return data as Emoji;
}

/**
 * remove_emoji: the row, its file and every message showing it stay; the emoji leaves the
 * picker and :name: resolution. 42501 not a manager, P0002 absent.
 */
async function deleteEmoji(emojiId: string): Promise<boolean> {
    try {
        const emoji = await getEmoji(emojiId);
        const { error } = await supabase.rpc('remove_emoji', { p_emoji_id: emojiId });
        if (error) throw error;
        if (emoji) await cleanupEmojiReferences(emoji);
        return true;
    } catch (error) {
        debug.error('Error removing emoji:', error);
        return false;
    }
}

/** rename_emoji: 22023 invalid name, 23505 name taken, 42501 not a manager. */
async function renameEmoji(emojiId: string, newName: string, serverId: string): Promise<boolean> {
    const emojiCache = useEmojiCacheStore();

    try {
        const { name: cleanedName } = cleanFileName(`${newName.replace(/\./g, '')}.png`);
        if (!cleanedName) throw new Error('Invalid emoji name');

        const { error } = await supabase.rpc('rename_emoji', { p_emoji_id: emojiId, p_name: cleanedName });
        if (error) throw error;

        await emojiCache.invalidate({ serverId });
        invalidateEmojiResolverCache();
        return true;
    } catch (error) {
        debug.error('Error renaming emoji:', error);
        return false;
    }
}

/** remove_emoji per id; ids it refuses land in failed. */
async function bulkDeleteEmojis(emojiIds: string[]): Promise<{ success: string[], failed: string[] }> {
    const results = { success: [] as string[], failed: [] as string[] };
    for (const id of emojiIds) {
        if (await deleteEmoji(id)) results.success.push(id);
        else results.failed.push(id);
    }
    return results;
}

// Name-collision check; cache first, database second.
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
            .is('deleted_at', null)
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

async function getServerEmojiAnalytics(serverId: string) {
    const emojiCache = useEmojiCacheStore();
    const serverEmojis = emojiCache.getServerEmojis(serverId);
    
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
        
        debug.log(`Preloaded ${emojiIds.length} frequent emojis`);
    } catch (error) {
        debug.error('Error preloading frequent emojis:', error);
    }
}

/**
 * Generate an AI emoji from a text prompt via the federation backend (Klipy).
 * The backend hosts the image and creates a per-user custom emoji; the result
 * lands in the picker's AI Generated group and is usable at once.
 */
export interface AiEmojiQuota {
    enabled: boolean;
    /** Instance admins/owners skip the per-user cap (instance cap still applies). */
    isExempt: boolean;
    perUserDaily: number;
    userUsed: number;
    userRemaining: number;
    instanceDaily: number;
    instanceUsed: number;
    instanceRemaining: number;
    /** Effective remaining for this user (bounded by the instance cap). */
    remaining: number;
}

/**
 * Result of *starting* a generation. The emoji itself arrives asynchronously
 * via the `ai_emoji:generated` realtime event (Klipy is webhook-driven), so
 * this only carries the job id and an optimistic quota snapshot.
 */
export interface StartedAiEmoji {
    jobId: string;
    quota?: AiEmojiQuota;
}

/** Fetch the current user's AI emoji generation quota (drives the UI counter). */
async function getAiEmojiQuota(): Promise<AiEmojiQuota | null> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    try {
        const res = await fetch(apiUrl('/api/federation/gifs/ai-emojis/quota'), {
            headers: {
                Accept: 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
        });
        if (!res.ok) return null;
        return (await res.json()) as AiEmojiQuota;
    } catch {
        return null;
    }
}

/**
 * Start an AI emoji generation. Returns immediately with a job id; the finished
 * emoji is delivered later via the `ai_emoji:generated` realtime user event.
 */
async function generateAiEmoji(prompt: string): Promise<StartedAiEmoji> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const res = await fetch(apiUrl('/api/federation/gifs/ai-emojis/generate'), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ prompt }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'AI emoji generation failed');
    }
    return {
        jobId: String(payload.jobId ?? ''),
        quota: payload.quota as AiEmojiQuota | undefined,
    };
}

/**
 * Register an emoji delivered by the generation webhook into the picker cache
 * so it's immediately resolvable + visible in the AI Generated category.
 */
function registerGeneratedEmoji(raw: { id: string; name: string; url: string }): Emoji {
    const emoji: Emoji = {
        id: String(raw.id),
        name: String(raw.name),
        url: String(raw.url),
        scope: 'user',
        is_ai_generated: true,
        created_at: new Date(),
    };
    const cache = useEmojiCacheStore();
    cache.addPersonalEmoji(PERSONAL_EMOJI_GROUPS.ai, 'AI Generated', emoji);
    invalidateEmojiResolverCache();
    return emoji;
}

export { 
    cleanupEmojiReferences,
    uploadEmoji, 
    generateAiEmoji,
    registerGeneratedEmoji,
    getAiEmojiQuota,
    getEmoji, 
    deleteEmoji, 
    renameEmoji,
    bulkDeleteEmojis,
    doesEmojiNameExist,
    emojiNameFromFile,
    prepareEmojiImage,
    storeEmojiImage,
    searchEmojis,
    getServerEmojiAnalytics,
    preloadFrequentEmojis,
    recordEmojiUsage,
    getDetailedEmojiAnalytics,
    getUserEmojiStats
};
