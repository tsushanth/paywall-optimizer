import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import {
  createApp,
  listApps,
  createExperiment,
  getExperiment,
  listExperiments,
  updateExperiment,
  startExperiment,
  pauseExperiment,
  completeExperiment,
  addVariant,
  updateVariant,
  deleteVariant,
} from '../services/experiments.js';
import { createWinbackExperiment, getAppDismissStats } from '../services/winback.js';

const router = Router();

function paramId(req: Request): string {
  return req.params.id as string;
}

/**
 * Middleware: authenticate admin requests by X-Internal-Secret header.
 */
function authenticateAdmin(req: Request, res: Response, next: Function) {
  const secret = req.headers['x-internal-secret'] as string;
  if (secret !== config.INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(authenticateAdmin);

// ─── Apps ───────────────────────────────────────────────────────────────────

router.get('/apps', async (_req: Request, res: Response) => {
  try {
    const apps = await listApps();
    return res.json(apps);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.post('/apps', async (req: Request, res: Response) => {
  try {
    const app = await createApp(req.body);
    return res.status(201).json(app);
  } catch (err) {
    return res.status(400).json({ error: String(err) });
  }
});

// ─── Experiments ────────────────────────────────────────────────────────────

router.get('/experiments', async (req: Request, res: Response) => {
  try {
    const appId = req.query.app_id as string | undefined;
    const experiments = await listExperiments(appId);
    return res.json(experiments);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.post('/experiments', async (req: Request, res: Response) => {
  try {
    const experiment = await createExperiment(req.body);
    return res.status(201).json(experiment);
  } catch (err) {
    return res.status(400).json({ error: String(err) });
  }
});

router.get('/experiments/:id', async (req: Request, res: Response) => {
  try {
    const experiment = await getExperiment(paramId(req));
    return res.json(experiment);
  } catch (err) {
    return res.status(404).json({ error: 'Experiment not found' });
  }
});

router.patch('/experiments/:id', async (req: Request, res: Response) => {
  try {
    const experiment = await updateExperiment(paramId(req), req.body);
    return res.json(experiment);
  } catch (err) {
    return res.status(400).json({ error: String(err) });
  }
});

router.post('/experiments/:id/start', async (req: Request, res: Response) => {
  try {
    const experiment = await startExperiment(paramId(req));
    return res.json(experiment);
  } catch (err) {
    return res.status(400).json({ error: String(err) });
  }
});

router.post('/experiments/:id/pause', async (req: Request, res: Response) => {
  try {
    const experiment = await pauseExperiment(paramId(req));
    return res.json(experiment);
  } catch (err) {
    return res.status(400).json({ error: String(err) });
  }
});

router.post('/experiments/:id/complete', async (req: Request, res: Response) => {
  try {
    const experiment = await completeExperiment(paramId(req), req.body.winning_variant_id);
    return res.json(experiment);
  } catch (err) {
    return res.status(400).json({ error: String(err) });
  }
});

// ─── Variants ───────────────────────────────────────────────────────────────

router.post('/experiments/:id/variants', async (req: Request, res: Response) => {
  try {
    const variant = await addVariant({
      experiment_id: paramId(req),
      ...req.body,
    });
    return res.status(201).json(variant);
  } catch (err) {
    return res.status(400).json({ error: String(err) });
  }
});

router.patch('/variants/:id', async (req: Request, res: Response) => {
  try {
    const variant = await updateVariant(paramId(req), req.body);
    return res.json(variant);
  } catch (err) {
    return res.status(400).json({ error: String(err) });
  }
});

router.delete('/variants/:id', async (req: Request, res: Response) => {
  try {
    await deleteVariant(paramId(req));
    return res.status(204).send();
  } catch (err) {
    return res.status(400).json({ error: String(err) });
  }
});

// ─── Winback Offers ──────────────────────────────────────────────────────────

/**
 * POST /api/admin/winback
 * Create and auto-start a winback experiment for an app.
 * Body: { app_id, original_product_id, discount_product_id?, discount_text?, urgency_hours? }
 */
router.post('/winback', async (req: Request, res: Response) => {
  try {
    const { app_id, original_product_id, discount_product_id, discount_text, urgency_hours } = req.body;

    if (!app_id || !original_product_id) {
      return res.status(400).json({ error: 'app_id and original_product_id are required' });
    }

    const result = await createWinbackExperiment({
      app_id,
      original_product_id,
      discount_product_id,
      discount_text,
      urgency_hours,
    });

    return res.status(201).json(result);
  } catch (err) {
    return res.status(400).json({ error: String(err) });
  }
});

/**
 * GET /api/admin/winback/stats/:appId
 * Get dismiss/conversion stats for an app (used to decide if winback is needed).
 */
router.get('/winback/stats/:appId', async (req: Request, res: Response) => {
  try {
    const days = Number(req.query.days) || 7;
    const stats = await getAppDismissStats(req.params.appId as string, days);
    if (!stats) {
      return res.status(204).send();
    }
    return res.json(stats);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
