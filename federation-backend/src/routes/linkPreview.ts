import { Router } from 'express';
import { z } from 'zod';
import linkPreviewService from '../services/LinkPreviewService.js';

const router = Router();

const requestSchema = z.object({
  url: z.string().url(),
});

router.post('/', async (req, res, next) => {
  try {
    const { url } = requestSchema.parse(req.body);
    const payload = await linkPreviewService.getPreview(url);
    console.log('Link preview payload:', payload);
    res.json(payload);
  } catch (error) {
    console.error('Error getting link preview:', error);
    next(error);
  }
});

export default router;

