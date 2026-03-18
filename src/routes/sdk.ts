import { Router, type Request, type Response } from 'express';
import { getPaywallConfig } from '../services/assignment.js';
import { recordEvents, getAppByApiKey } from '../services/experiments.js';

const router = Router();

/**
 * Middleware: authenticate SDK requests by X-API-Key header.
 * Attaches app to req.
 */
async function authenticateApp(req: Request, res: Response, next: Function) {
  const apiKey = req.headers['x-api-key'] as string;
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing X-API-Key header' });
  }

  const app = await getAppByApiKey(apiKey);
  if (!app) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  (req as any).app_record = app;
  next();
}

router.use(authenticateApp);

/**
 * GET /api/paywall/config
 * SDK calls this to get the paywall config for a user.
 *
 * Query params:
 *   user_id: string (required)
 *   trigger: string (default: "onboarding")
 *   attributes: JSON string of user attributes (optional)
 */
router.get('/config', async (req: Request, res: Response) => {
  try {
    const app = (req as any).app_record;
    const userId = req.query.user_id as string;
    const trigger = (req.query.trigger as string) || 'onboarding';
    let attributes: Record<string, string> = {};

    if (!userId) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    if (req.query.attributes) {
      try {
        attributes = JSON.parse(req.query.attributes as string);
      } catch {
        return res.status(400).json({ error: 'Invalid attributes JSON' });
      }
    }

    const config = await getPaywallConfig(app.id, userId, trigger, attributes);

    if (!config) {
      return res.status(204).send(); // No experiment or config available
    }

    return res.json(config);
  } catch (err) {
    console.error('[SDK] Error getting config:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/paywall/events
 * SDK sends batch events here.
 *
 * Body: { events: Array<{ experiment_id, variant_id, user_id, event_type, trigger_point?, metadata? }> }
 */
router.post('/events', async (req: Request, res: Response) => {
  try {
    const app = (req as any).app_record;
    const { events } = req.body;

    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'events array is required' });
    }

    if (events.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 events per batch' });
    }

    const result = await recordEvents(app.id, events);
    return res.json(result);
  } catch (err) {
    console.error('[SDK] Error recording events:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
