import { supabase } from '../lib/supabase.js';
import type { EvaluationResult, ExperimentRow, ResultRow } from '../types.js';

/**
 * Normal CDF approximation (Abramowitz and Stegun).
 */
function normalCDF(z: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  z = Math.abs(z) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * z);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Two-proportion z-test.
 * Compares conversion rates of control vs variant.
 */
export function calculateSignificance(
  controlConversions: number,
  controlImpressions: number,
  variantConversions: number,
  variantImpressions: number
): { zScore: number; pValue: number; isSignificant: boolean; confidenceLevel: number } {
  if (controlImpressions === 0 || variantImpressions === 0) {
    return { zScore: 0, pValue: 1, isSignificant: false, confidenceLevel: 0 };
  }

  const pC = controlConversions / controlImpressions;
  const pV = variantConversions / variantImpressions;
  const pPooled = (controlConversions + variantConversions) / (controlImpressions + variantImpressions);
  const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / controlImpressions + 1 / variantImpressions));

  if (se === 0) {
    return { zScore: 0, pValue: 1, isSignificant: false, confidenceLevel: 0 };
  }

  const z = (pV - pC) / se;
  const pValue = 2 * (1 - normalCDF(Math.abs(z)));

  return {
    zScore: z,
    pValue,
    isSignificant: pValue < 0.05,
    confidenceLevel: 1 - pValue,
  };
}

/**
 * Aggregate raw events into results for an experiment.
 */
async function aggregateResults(experimentId: string): Promise<void> {
  const { data: variants } = await supabase
    .from('variants')
    .select('id')
    .eq('experiment_id', experimentId);

  if (!variants) return;

  for (const variant of variants) {
    const { data: events } = await supabase
      .from('events')
      .select('event_type, metadata')
      .eq('experiment_id', experimentId)
      .eq('variant_id', variant.id);

    if (!events) continue;

    const impressions = events.filter(e => e.event_type === 'impression').length;
    const dismissals = events.filter(e => e.event_type === 'dismiss').length;
    const ctaTaps = events.filter(e => e.event_type === 'cta_tap').length;
    const purchases = events.filter(e => e.event_type === 'purchase').length;
    const trialStarts = events.filter(e => e.event_type === 'trial_start').length;
    const totalRevenue = events
      .filter(e => e.event_type === 'purchase')
      .reduce((sum, e) => sum + (Number((e.metadata as any)?.revenue) || 0), 0);

    const conversionRate = impressions > 0 ? purchases / impressions : null;
    const revenuePerImpression = impressions > 0 ? totalRevenue / impressions : null;

    await supabase.from('results').upsert(
      {
        experiment_id: experimentId,
        variant_id: variant.id,
        impressions,
        dismissals,
        cta_taps: ctaTaps,
        purchases,
        trial_starts: trialStarts,
        total_revenue: totalRevenue,
        conversion_rate: conversionRate,
        revenue_per_impression: revenuePerImpression,
        evaluated_at: new Date().toISOString(),
      },
      { onConflict: 'experiment_id,variant_id' }
    );
  }
}

/**
 * Evaluate a single experiment: aggregate results, check significance, auto-promote.
 */
export async function evaluateExperiment(experimentId: string): Promise<EvaluationResult> {
  // 1. Get experiment
  const { data: experiment } = await supabase
    .from('experiments')
    .select('*')
    .eq('id', experimentId)
    .single();

  if (!experiment) {
    throw new Error(`Experiment ${experimentId} not found`);
  }

  const exp = experiment as ExperimentRow;

  // 2. Aggregate events → results
  await aggregateResults(experimentId);

  // 3. Get results + variant info
  const { data: resultRows } = await supabase
    .from('results')
    .select('*, variants(name, is_control)')
    .eq('experiment_id', experimentId);

  if (!resultRows || resultRows.length < 2) {
    return {
      experiment_id: experimentId,
      experiment_name: exp.name,
      status: 'needs_more_data',
      variants: [],
    };
  }

  const results = resultRows as (ResultRow & { variants: { name: string; is_control: boolean } })[];

  // 4. Check minimum sample size
  const allMeetMinimum = results.every(r => r.impressions >= exp.min_sample_size);
  if (!allMeetMinimum) {
    return {
      experiment_id: experimentId,
      experiment_name: exp.name,
      status: 'needs_more_data',
      variants: results.map(r => ({
        variant_id: r.variant_id,
        name: r.variants.name,
        impressions: r.impressions,
        conversions: r.purchases,
        conversion_rate: r.conversion_rate || 0,
        revenue: Number(r.total_revenue),
        is_significant: false,
      })),
    };
  }

  // 5. Find control
  const control = results.find(r => r.variants.is_control);
  if (!control) {
    return {
      experiment_id: experimentId,
      experiment_name: exp.name,
      status: 'needs_more_data',
      variants: [],
    };
  }

  // 6. Test each variant against control
  let bestVariant: (typeof results)[0] | null = null;
  let bestLift = 0;

  const variantResults = results.map(r => {
    if (r.variants.is_control) {
      return {
        variant_id: r.variant_id,
        name: r.variants.name,
        impressions: r.impressions,
        conversions: r.purchases,
        conversion_rate: r.conversion_rate || 0,
        revenue: Number(r.total_revenue),
        is_significant: false,
        p_value: undefined as number | undefined,
      };
    }

    const sig = calculateSignificance(
      control.purchases, control.impressions,
      r.purchases, r.impressions
    );

    const isSignificant = sig.pValue < (1 - exp.confidence_level);

    // Update significance in DB
    supabase
      .from('results')
      .update({ is_significant: isSignificant, p_value: sig.pValue })
      .eq('experiment_id', experimentId)
      .eq('variant_id', r.variant_id)
      .then(() => {});

    const lift = (r.conversion_rate || 0) - (control.conversion_rate || 0);
    if (isSignificant && lift > bestLift) {
      bestLift = lift;
      bestVariant = r;
    }

    return {
      variant_id: r.variant_id,
      name: r.variants.name,
      impressions: r.impressions,
      conversions: r.purchases,
      conversion_rate: r.conversion_rate || 0,
      revenue: Number(r.total_revenue),
      is_significant: isSignificant,
      p_value: sig.pValue,
    };
  });

  // 7. Auto-promote winner if found
  if (bestVariant) {
    await supabase
      .from('experiments')
      .update({
        status: 'completed',
        winning_variant_id: (bestVariant as any).variant_id,
        completed_at: new Date().toISOString(),
      })
      .eq('id', experimentId);

    return {
      experiment_id: experimentId,
      experiment_name: exp.name,
      status: 'winner_promoted',
      winning_variant_id: (bestVariant as any).variant_id,
      variants: variantResults,
    };
  }

  // 8. Check if we've exceeded 4x sample size with no winner
  const maxImpressions = Math.max(...results.map(r => r.impressions));
  if (maxImpressions > exp.min_sample_size * 4) {
    return {
      experiment_id: experimentId,
      experiment_name: exp.name,
      status: 'no_winner',
      variants: variantResults,
    };
  }

  return {
    experiment_id: experimentId,
    experiment_name: exp.name,
    status: 'needs_more_data',
    variants: variantResults,
  };
}

/**
 * Evaluate all running experiments.
 */
export async function evaluateAllExperiments(): Promise<EvaluationResult[]> {
  const { data: running } = await supabase
    .from('experiments')
    .select('id')
    .eq('status', 'running');

  if (!running || running.length === 0) return [];

  const results: EvaluationResult[] = [];
  for (const exp of running) {
    try {
      const result = await evaluateExperiment(exp.id);
      results.push(result);
    } catch (err) {
      console.error(`[Evaluation] Error evaluating ${exp.id}:`, err);
    }
  }

  return results;
}
