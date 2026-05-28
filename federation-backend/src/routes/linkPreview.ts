import { Router } from 'express';
import { fetchLinkPreview } from '../services/LinkPreviewService.js';
import { getSupabaseClientWithAuth } from '../config/supabase.js';

const router = Router();

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

