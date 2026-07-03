import { Router } from 'express';
import { fetchLinkPreview } from '../services/LinkPreviewService.js';
import { getSupabaseClient, getSupabaseClientWithAuth } from '../config/supabase.js';
import config from '../config/index.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * Internal service-to-service trigger: enrich one stored message's link
 * previews immediately. Called by the bot-gateway right after inserting a
 * bridged message, so its previews don't depend on the federation sweep /
 * realtime subscription picking the row up.
 * Auth: caller must present the service-role key (the bot-gateway has it).
 */
router.post('/enrich-message', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : '';
  if (!token || token !== config.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { messageId } = req.body || {};
  if (!messageId || typeof messageId !== 'string') {
    return res.status(400).json({ error: 'messageId is required' });
  }

  try {
    const supabase = getSupabaseClient();
    const { data: message } = await supabase
      .from('messages')
      .select('*')
      .eq('id', messageId)
      .single();

    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const { enrichMessageLinkPreviews } = await import('../listeners/DatabaseListener.js');
    await enrichMessageLinkPreviews(message);
    return res.json({ success: true });
  } catch (error: any) {
    logger.warn(`enrich-message failed for ${messageId}:`, error);
    return res.status(500).json({ error: error.message || 'Enrichment failed' });
  }
});

router.post('/', async (req, res) => {
  try {
    // Require authentication to prevent anonymous SSRF abuse
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization required' });
    }
    const supabase = getSupabaseClientWithAuth(authHeader.substring(7));
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required' });
    }

    const preview = await fetchLinkPreview(url);
    return res.json(preview);
  } catch (error: any) {
    return res.status(500).json({
      error: error.message || 'Failed to generate link preview'
    });
  }
});

export default router;

