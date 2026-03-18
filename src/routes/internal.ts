import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { evaluateAllExperiments, evaluateExperiment } from '../services/evaluation.js';

const router = Router();

/**
 * Middleware: authenticate internal requests by X-Internal-Secret header.
 */
function authenticateInternal(req: Request, res: Response, next: Function) {
  const secret = req.headers['x-internal-secret'] as string;
  if (secret !== config.INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Health check (no auth)
router.get('/health', (_req: Request, res: Response) => {
  return res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

router.use(authenticateInternal);

/**
 * POST /internal/evaluate
 * Evaluate all running experiments. Called by Cloud Scheduler.
 */
router.post('/evaluate', async (_req: Request, res: Response) => {
  try {
    const results = await evaluateAllExperiments();

    const summary = {
      evaluated: results.length,
      winners_promoted: results.filter(r => r.status === 'winner_promoted').length,
      needs_more_data: results.filter(r => r.status === 'needs_more_data').length,
      no_winner: results.filter(r => r.status === 'no_winner').length,
      details: results,
    };

    console.log(`[Evaluation] Evaluated ${summary.evaluated} experiments, promoted ${summary.winners_promoted} winners`);
    return res.json(summary);
  } catch (err) {
    console.error('[Evaluation] Error:', err);
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /internal/evaluate/:experimentId
 * Evaluate a single experiment.
 */
router.post('/evaluate/:experimentId', async (req: Request, res: Response) => {
  try {
    const result = await evaluateExperiment(req.params.experimentId as string);
    return res.json(result);
  } catch (err) {
    console.error(`[Evaluation] Error evaluating ${req.params.experimentId}:`, err);
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
