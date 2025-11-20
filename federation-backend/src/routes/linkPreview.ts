import { Router } from 'express';
import { fetchLinkPreview } from '../services/LinkPreviewService.js';

const router = Router();

router.post('/', async (req, res) => {
  try {
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

