// ─── Database Row Types ─────────────────────────────────────────────────────

export interface AppRow {
  id: string;
  name: string;
  bundle_id: string;
  api_key: string;
  platform: string;
  store_product_ids: string[];
  created_at: string;
}

export interface ExperimentRow {
  id: string;
  app_id: string;
  name: string;
  trigger_point: string;
  status: 'draft' | 'running' | 'paused' | 'completed';
  strategy: 'ab_test' | 'bandit';
  traffic_pct: number;
  targeting_rules: Record<string, string[]>;
  min_sample_size: number;
  confidence_level: number;
  winning_variant_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VariantRow {
  id: string;
  experiment_id: string;
  name: string;
  is_control: boolean;
  weight: number;
  config: PaywallConfig;
  created_at: string;
}

export interface AssignmentRow {
  id: string;
  experiment_id: string;
  variant_id: string;
  app_id: string;
  user_id: string;
  user_attributes: Record<string, string>;
  assigned_at: string;
}

export interface EventRow {
  id: string;
  app_id: string;
  experiment_id: string;
  variant_id: string;
  user_id: string;
  event_type: EventType;
  trigger_point: string | null;
  metadata: Record<string, unknown>;
  ts: string;
}

export interface ResultRow {
  id: string;
  experiment_id: string;
  variant_id: string;
  impressions: number;
  dismissals: number;
  cta_taps: number;
  purchases: number;
  trial_starts: number;
  total_revenue: number;
  conversion_rate: number | null;
  revenue_per_impression: number | null;
  is_significant: boolean;
  p_value: number | null;
  evaluated_at: string | null;
}

// ─── Paywall Config (JSON schema served to SDK) ────────────────────────────

export interface PaywallConfig {
  template: 'standard' | 'minimal' | 'feature_list' | 'comparison' | 'urgency';
  colors: {
    primary: string;
    secondary: string;
    background: string;
    accent: string;
    text_primary: string;
    text_secondary: string;
  };
  copy: {
    headline: string;
    subheadline: string;
    cta_text: string;
    features: Array<{ icon: string; title: string; description: string }>;
    disclaimer: string;
    social_proof?: string;
  };
  products: Array<{
    store_product_id: string;
    display_order: number;
    is_highlighted: boolean;
    badge_text?: string;
    subtitle?: string;
  }>;
  trial: {
    show_trial_messaging: boolean;
    custom_trial_text?: string;
  };
  close_button: {
    behavior: 'show_immediately' | 'delay_3s' | 'delay_5s' | 'hidden';
  };
}

// ─── API Types ──────────────────────────────────────────────────────────────

export type EventType = 'impression' | 'dismiss' | 'cta_tap' | 'purchase' | 'trial_start';

export interface PaywallConfigResponse {
  experiment_id: string;
  variant_id: string;
  variant_name: string;
  config: PaywallConfig;
  is_new_assignment: boolean;
}

export interface EventInput {
  experiment_id: string;
  variant_id: string;
  user_id: string;
  event_type: EventType;
  trigger_point?: string;
  metadata?: Record<string, unknown>;
}

export interface EvaluationResult {
  experiment_id: string;
  experiment_name: string;
  status: 'needs_more_data' | 'significant' | 'no_winner' | 'winner_promoted';
  winning_variant_id?: string;
  variants: Array<{
    variant_id: string;
    name: string;
    impressions: number;
    conversions: number;
    conversion_rate: number;
    revenue: number;
    is_significant: boolean;
    p_value?: number;
  }>;
}
