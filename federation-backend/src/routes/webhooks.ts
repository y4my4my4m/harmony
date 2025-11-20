import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { createClient } from '@supabase/supabase-js';
import config from '../config/index.js';
import { fetchLinkPreview } from '../services/LinkPreviewService.js';

const router = Router();

// Initialize Supabase client for callback
const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);

/**
 * POST /webhooks/enrich-message-previews
 * 
 * Webhook called by Supabase AFTER INSERT trigger for messages with external URLs.
 * Fetches link previews and updates message metadata via RPC.
 * 
 * Payload: { messageId: string, urls: string[] }
 */
router.post('/enrich-message-previews', async (req: Request, res: Response) => {
  try {
    const { messageId, urls } = req.body;

    if (!messageId || !Array.isArray(urls) || urls.length === 0) {
      logger.warn('Invalid webhook payload:', req.body);
      return res.status(400).json({ error: 'Invalid payload: messageId and urls[] required' });
    }

    logger.info(`📨 Webhook received for message ${messageId} with ${urls.length} URLs`);

    // Respond immediately so Postgres doesn't wait
    res.status(202).json({ status: 'accepted', messageId, urlCount: urls.length });

    // Process previews asynchronously
    const embeds: Record<string, any> = {};

    await Promise.all(
      urls.map(async (url) => {
        try {
          logger.info(`🔗 Fetching preview for: ${url}`);
          const preview = await fetchLinkPreview(url);
          embeds[url] = preview;
          logger.info(`✅ Preview fetched for: ${url}`);
        } catch (error: any) {
          logger.error(`❌ Failed to fetch preview for ${url}:`, error.message);
          // Store error embed so frontend knows it failed
          embeds[url] = {
            url,
            normalizedUrl: url,
            provider: 'generic',
            title: url,
            description: `Preview failed: ${error.message}`,
            fetchedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour
          };
        }
      })
    );

    // Update message metadata via RPC
    const { error: rpcError } = await supabase.rpc('update_message_embeds', {
      p_message_id: messageId,
      p_embeds: embeds,
    });

    if (rpcError) {
      logger.error(`❌ Failed to update message ${messageId}:`, rpcError);
    } else {
      logger.info(`✅ Updated message ${messageId} with ${Object.keys(embeds).length} embeds`);
    }
  } catch (error: any) {
    logger.error('❌ Webhook processing error:', error);
    // Don't fail the response since we already sent 202
  }
});

export default router;

