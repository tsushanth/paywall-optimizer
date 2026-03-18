import CryptoJS from 'crypto-js';
import { supabase } from '../lib/supabase.js';
import type { PaywallConfigResponse, ExperimentRow, VariantRow, AssignmentRow } from '../types.js';

/**
 * Deterministic hash bucket: maps (userId, experimentId) to 0-99.
 * Same user always gets the same bucket for a given experiment.
 */
export function hashBucket(userId: string, experimentId: string): number {
  const hash = CryptoJS.SHA256(userId + ':' + experimentId).toString();
  const num = parseInt(hash.slice(0, 8), 16);
  return num % 100;
}

/**
 * Weighted random selection among variants.
 * Uses the hash bucket to make it deterministic per user.
 */
function selectVariantByWeight(variants: VariantRow[], bucket: number): VariantRow {
  const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
  const normalizedBucket = bucket / 100; // 0.0 - 0.99
  let cumulative = 0;

  for (const variant of variants) {
    cumulative += variant.weight / totalWeight;
    if (normalizedBucket < cumulative) {
      return variant;
    }
  }

  return variants[variants.length - 1];
}

/**
 * Thompson Sampling: picks the variant with the highest Beta sample.
 * Uses successes (purchases) and failures (impressions - purchases).
 */
function thompsonSelect(
  variants: VariantRow[],
  results: Map<string, { successes: number; failures: number }>
): VariantRow {
  let bestVariant = variants[0];
  let bestSample = -1;

  for (const variant of variants) {
    const r = results.get(variant.id) || { successes: 1, failures: 1 };
    const alpha = r.successes + 1;
    const beta = r.failures + 1;
    // Approximate Beta sampling using the Joehnk method
    const sample = betaSample(alpha, beta);
    if (sample > bestSample) {
      bestSample = sample;
      bestVariant = variant;
    }
  }

  return bestVariant;
}

function betaSample(alpha: number, beta: number): number {
  // Box-Muller-based approximation for Beta distribution
  const x = gammaSample(alpha);
  const y = gammaSample(beta);
  return x / (x + y);
}

function gammaSample(shape: number): number {
  // Marsaglia and Tsang's method
  if (shape < 1) {
    return gammaSample(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number, v: number;
    do {
      x = normalRandom();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normalRandom(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Check if user attributes match experiment targeting rules.
 * Rules: { "source": ["tiktok", "meta"], "country": ["US"] }
 * All keys must match (AND logic). Each key: user value must be in the array (OR logic).
 */
function matchesTargeting(
  rules: Record<string, string[]>,
  attributes: Record<string, string>
): boolean {
  for (const [key, allowedValues] of Object.entries(rules)) {
    if (allowedValues.length === 0) continue;
    const userValue = attributes[key];
    if (!userValue || !allowedValues.includes(userValue)) {
      return false;
    }
  }
  return true;
}

/**
 * Main entry: get the paywall config for a user.
 * Handles experiment lookup, sticky assignments, and variant selection.
 */
export async function getPaywallConfig(
  appId: string,
  userId: string,
  triggerPoint: string,
  userAttributes: Record<string, string>
): Promise<PaywallConfigResponse | null> {
  // 1. Find running experiments for this app + trigger
  const { data: experiments } = await supabase
    .from('experiments')
    .select('*')
    .eq('app_id', appId)
    .eq('trigger_point', triggerPoint)
    .eq('status', 'running')
    .order('created_at', { ascending: false });

  if (!experiments || experiments.length === 0) {
    // Check for completed experiments with a winner (serve winning variant)
    return getWinningConfig(appId, triggerPoint);
  }

  // 2. Find the first experiment that matches targeting
  let matchedExperiment: ExperimentRow | null = null;
  for (const exp of experiments as ExperimentRow[]) {
    if (matchesTargeting(exp.targeting_rules, userAttributes)) {
      matchedExperiment = exp;
      break;
    }
  }

  if (!matchedExperiment) {
    return getWinningConfig(appId, triggerPoint);
  }

  // 3. Check for existing sticky assignment
  const { data: existingAssignment } = await supabase
    .from('assignments')
    .select('*, variants(*)')
    .eq('experiment_id', matchedExperiment.id)
    .eq('user_id', userId)
    .single();

  if (existingAssignment) {
    const variant = (existingAssignment as any).variants as VariantRow;
    return {
      experiment_id: matchedExperiment.id,
      variant_id: variant.id,
      variant_name: variant.name,
      config: variant.config,
      is_new_assignment: false,
    };
  }

  // 4. Check traffic eligibility
  const bucket = hashBucket(userId, matchedExperiment.id);
  if (bucket >= matchedExperiment.traffic_pct) {
    return getWinningConfig(appId, triggerPoint);
  }

  // 5. Get variants
  const { data: variants } = await supabase
    .from('variants')
    .select('*')
    .eq('experiment_id', matchedExperiment.id)
    .order('created_at');

  if (!variants || variants.length === 0) return null;

  // 6. Select variant
  let selectedVariant: VariantRow;

  if (matchedExperiment.strategy === 'bandit') {
    const { data: resultRows } = await supabase
      .from('results')
      .select('variant_id, purchases, impressions')
      .eq('experiment_id', matchedExperiment.id);

    const resultsMap = new Map<string, { successes: number; failures: number }>();
    for (const r of resultRows || []) {
      resultsMap.set(r.variant_id, {
        successes: r.purchases || 0,
        failures: Math.max(0, (r.impressions || 0) - (r.purchases || 0)),
      });
    }
    selectedVariant = thompsonSelect(variants as VariantRow[], resultsMap);
  } else {
    selectedVariant = selectVariantByWeight(variants as VariantRow[], bucket);
  }

  // 7. Store sticky assignment
  await supabase.from('assignments').insert({
    experiment_id: matchedExperiment.id,
    variant_id: selectedVariant.id,
    app_id: appId,
    user_id: userId,
    user_attributes: userAttributes,
  });

  return {
    experiment_id: matchedExperiment.id,
    variant_id: selectedVariant.id,
    variant_name: selectedVariant.name,
    config: selectedVariant.config,
    is_new_assignment: true,
  };
}

/**
 * Get the winning variant config from a completed experiment.
 */
async function getWinningConfig(
  appId: string,
  triggerPoint: string
): Promise<PaywallConfigResponse | null> {
  const { data: completed } = await supabase
    .from('experiments')
    .select('*, variants(*)')
    .eq('app_id', appId)
    .eq('trigger_point', triggerPoint)
    .eq('status', 'completed')
    .not('winning_variant_id', 'is', null)
    .order('completed_at', { ascending: false })
    .limit(1)
    .single();

  if (!completed) return null;

  const winningVariant = (completed as any).variants?.find(
    (v: VariantRow) => v.id === completed.winning_variant_id
  );

  if (!winningVariant) return null;

  return {
    experiment_id: completed.id,
    variant_id: winningVariant.id,
    variant_name: winningVariant.name,
    config: winningVariant.config,
    is_new_assignment: false,
  };
}
