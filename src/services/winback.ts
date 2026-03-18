/**
 * Winback Offer Service
 *
 * Auto-creates winback experiments for apps with high paywall dismiss rates.
 * Called by the growth orchestrator or directly via admin API.
 *
 * Winback experiments use:
 *   - trigger_point: "winback" (shown to users who previously dismissed)
 *   - strategy: "bandit" (Thompson sampling to find best offer quickly)
 *   - Variants with discount/urgency messaging
 */

import { supabase } from '../lib/supabase.js';
import {
  createExperiment,
  addVariant,
  startExperiment,
} from './experiments.js';
import type { PaywallConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WinbackRequest {
  app_id: string;
  discount_product_id?: string;  // discounted store product ID
  original_product_id: string;   // regular price product
  discount_text?: string;        // e.g. "50% OFF — Limited Time"
  urgency_hours?: number;        // countdown timer hours (default: 24)
}

export interface WinbackResult {
  experiment_id: string;
  experiment_name: string;
  variants_created: number;
  status: 'created_and_started' | 'created_draft';
  auto_started: boolean;
}

// ---------------------------------------------------------------------------
// Winback Config Templates
// ---------------------------------------------------------------------------

function controlVariant(originalProductId: string): PaywallConfig {
  return {
    template: 'standard',
    colors: {
      primary: '#007AFF',
      secondary: '#5856D6',
      background: '#FFFFFF',
      accent: '#FF9500',
      text_primary: '#000000',
      text_secondary: '#8E8E93',
    },
    copy: {
      headline: 'Unlock Premium',
      subheadline: 'Get the full experience with all features',
      cta_text: 'Continue',
      features: [
        { icon: 'star.fill', title: 'All Features', description: 'Access everything' },
        { icon: 'bolt.fill', title: 'No Limits', description: 'Unlimited usage' },
        { icon: 'sparkles', title: 'Priority Support', description: 'Get help fast' },
      ],
      disclaimer: 'Cancel anytime. Subscription auto-renews.',
    },
    products: [
      { store_product_id: originalProductId, display_order: 1, is_highlighted: true },
    ],
    trial: { show_trial_messaging: true },
    close_button: { behavior: 'show_immediately' },
  };
}

function discountVariant(
  discountProductId: string,
  originalProductId: string,
  discountText: string
): PaywallConfig {
  return {
    template: 'urgency',
    colors: {
      primary: '#FF3B30',
      secondary: '#FF9500',
      background: '#1C1C1E',
      accent: '#FFD60A',
      text_primary: '#FFFFFF',
      text_secondary: '#EBEBF5',
    },
    copy: {
      headline: discountText,
      subheadline: 'This special offer won\'t last — upgrade now and save',
      cta_text: 'Claim Offer',
      features: [
        { icon: 'tag.fill', title: 'Special Discount', description: 'Exclusive comeback offer' },
        { icon: 'star.fill', title: 'All Features', description: 'Full premium access' },
        { icon: 'clock.fill', title: 'Limited Time', description: 'Offer expires soon' },
      ],
      disclaimer: 'Promotional pricing. Cancel anytime.',
      social_proof: 'Thousands of users upgraded this week',
    },
    products: [
      { store_product_id: discountProductId, display_order: 1, is_highlighted: true, badge_text: 'BEST DEAL' },
      { store_product_id: originalProductId, display_order: 2, is_highlighted: false, subtitle: 'Regular price' },
    ],
    trial: { show_trial_messaging: false },
    close_button: { behavior: 'delay_3s' },
  };
}

function urgencyVariant(originalProductId: string): PaywallConfig {
  return {
    template: 'urgency',
    colors: {
      primary: '#FF9500',
      secondary: '#FF3B30',
      background: '#1C1C1E',
      accent: '#FFD60A',
      text_primary: '#FFFFFF',
      text_secondary: '#EBEBF5',
    },
    copy: {
      headline: 'Still Thinking?',
      subheadline: 'Start your free trial — cancel anytime, no risk',
      cta_text: 'Start Free Trial',
      features: [
        { icon: 'gift.fill', title: 'Free to Try', description: 'No charge until trial ends' },
        { icon: 'xmark.circle', title: 'Cancel Anytime', description: 'No commitment, no hassle' },
        { icon: 'star.fill', title: 'Full Access', description: 'Everything unlocked today' },
      ],
      disclaimer: 'Free trial then auto-renews. Cancel anytime.',
    },
    products: [
      { store_product_id: originalProductId, display_order: 1, is_highlighted: true, badge_text: 'FREE TRIAL' },
    ],
    trial: { show_trial_messaging: true, custom_trial_text: 'Try free for 3 days' },
    close_button: { behavior: 'delay_5s' },
  };
}

function minimalVariant(originalProductId: string): PaywallConfig {
  return {
    template: 'minimal',
    colors: {
      primary: '#34C759',
      secondary: '#30D158',
      background: '#FFFFFF',
      accent: '#007AFF',
      text_primary: '#000000',
      text_secondary: '#8E8E93',
    },
    copy: {
      headline: 'Welcome Back!',
      subheadline: 'We missed you. Ready to unlock the full experience?',
      cta_text: 'Upgrade Now',
      features: [],
      disclaimer: 'Cancel anytime.',
    },
    products: [
      { store_product_id: originalProductId, display_order: 1, is_highlighted: true },
    ],
    trial: { show_trial_messaging: true },
    close_button: { behavior: 'show_immediately' },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Create and optionally start a winback experiment for an app.
 * Creates 3-4 variants:
 *   1. Control (standard paywall)
 *   2. Discount offer (if discount_product_id provided)
 *   3. Urgency (emphasizes free trial)
 *   4. Minimal (welcome back, soft ask)
 */
export async function createWinbackExperiment(
  request: WinbackRequest
): Promise<WinbackResult> {
  // Check if there's already a running winback experiment for this app
  const { data: existing } = await supabase
    .from('experiments')
    .select('id')
    .eq('app_id', request.app_id)
    .eq('trigger_point', 'winback')
    .in('status', ['running', 'draft'])
    .limit(1);

  if (existing && existing.length > 0) {
    return {
      experiment_id: existing[0].id,
      experiment_name: 'Existing winback experiment',
      variants_created: 0,
      status: 'created_draft',
      auto_started: false,
    };
  }

  // Create the experiment
  const experiment = await createExperiment({
    app_id: request.app_id,
    name: `Winback ${new Date().toISOString().split('T')[0]}`,
    trigger_point: 'winback',
    strategy: 'bandit', // Thompson sampling finds winner faster
    traffic_pct: 100,
    min_sample_size: 50,  // Lower threshold for winback (smaller audience)
    confidence_level: 0.90,
  });

  let variantsCreated = 0;

  // 1. Control variant
  await addVariant({
    experiment_id: experiment.id,
    name: 'Control (standard)',
    is_control: true,
    weight: 1,
    config: controlVariant(request.original_product_id),
  });
  variantsCreated++;

  // 2. Discount variant (if discount product available)
  if (request.discount_product_id) {
    await addVariant({
      experiment_id: experiment.id,
      name: 'Discount Offer',
      is_control: false,
      weight: 1,
      config: discountVariant(
        request.discount_product_id,
        request.original_product_id,
        request.discount_text || '50% OFF — Limited Time',
      ),
    });
    variantsCreated++;
  }

  // 3. Urgency variant (free trial emphasis)
  await addVariant({
    experiment_id: experiment.id,
    name: 'Free Trial Urgency',
    is_control: false,
    weight: 1,
    config: urgencyVariant(request.original_product_id),
  });
  variantsCreated++;

  // 4. Minimal welcome back
  await addVariant({
    experiment_id: experiment.id,
    name: 'Welcome Back (minimal)',
    is_control: false,
    weight: 1,
    config: minimalVariant(request.original_product_id),
  });
  variantsCreated++;

  // Auto-start the experiment
  await startExperiment(experiment.id);

  return {
    experiment_id: experiment.id,
    experiment_name: experiment.name,
    variants_created: variantsCreated,
    status: 'created_and_started',
    auto_started: true,
  };
}

/**
 * Get dismiss stats for an app to determine if winback is needed.
 */
export async function getAppDismissStats(appId: string, days = 7) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data: events } = await supabase
    .from('events')
    .select('event_type')
    .eq('app_id', appId)
    .gte('ts', since.toISOString());

  if (!events?.length) return null;

  const counts = { impression: 0, dismiss: 0, cta_tap: 0, purchase: 0, trial_start: 0 };
  for (const e of events) {
    if (e.event_type in counts) {
      counts[e.event_type as keyof typeof counts]++;
    }
  }

  return {
    ...counts,
    dismiss_rate: counts.impression > 0 ? counts.dismiss / counts.impression : 0,
    conversion_rate: counts.impression > 0 ? (counts.purchase + counts.trial_start) / counts.impression : 0,
    total_events: events.length,
  };
}
