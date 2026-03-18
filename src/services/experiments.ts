import { supabase } from '../lib/supabase.js';
import type { ExperimentRow, VariantRow, PaywallConfig } from '../types.js';

// ─── App CRUD ───────────────────────────────────────────────────────────────

export async function createApp(input: {
  name: string;
  bundle_id: string;
  platform?: string;
  store_product_ids?: string[];
}) {
  const apiKey = `pk_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

  const { data, error } = await supabase
    .from('apps')
    .insert({ ...input, api_key: apiKey })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function listApps() {
  const { data, error } = await supabase.from('apps').select('*').order('created_at');
  if (error) throw error;
  return data;
}

export async function getAppByApiKey(apiKey: string) {
  const { data, error } = await supabase
    .from('apps')
    .select('*')
    .eq('api_key', apiKey)
    .single();

  if (error) return null;
  return data;
}

// ─── Experiment CRUD ────────────────────────────────────────────────────────

export async function createExperiment(input: {
  app_id: string;
  name: string;
  trigger_point?: string;
  strategy?: 'ab_test' | 'bandit';
  traffic_pct?: number;
  targeting_rules?: Record<string, string[]>;
  min_sample_size?: number;
  confidence_level?: number;
}) {
  const { data, error } = await supabase
    .from('experiments')
    .insert(input)
    .select()
    .single();

  if (error) throw error;
  return data as ExperimentRow;
}

export async function getExperiment(id: string) {
  const { data, error } = await supabase
    .from('experiments')
    .select('*, variants(*), results(*)')
    .eq('id', id)
    .single();

  if (error) throw error;
  return data;
}

export async function listExperiments(appId?: string) {
  let query = supabase
    .from('experiments')
    .select('*, variants(id, name, is_control, weight)')
    .order('created_at', { ascending: false });

  if (appId) {
    query = query.eq('app_id', appId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function updateExperiment(id: string, updates: Partial<ExperimentRow>) {
  const { data, error } = await supabase
    .from('experiments')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function startExperiment(id: string) {
  // Validate: at least 2 variants, one control
  const { data: variants } = await supabase
    .from('variants')
    .select('*')
    .eq('experiment_id', id);

  if (!variants || variants.length < 2) {
    throw new Error('Need at least 2 variants to start an experiment');
  }

  const hasControl = variants.some((v: any) => v.is_control);
  if (!hasControl) {
    throw new Error('One variant must be marked as control');
  }

  return updateExperiment(id, {
    status: 'running',
    started_at: new Date().toISOString(),
  } as any);
}

export async function pauseExperiment(id: string) {
  return updateExperiment(id, { status: 'paused' } as any);
}

export async function completeExperiment(id: string, winningVariantId?: string) {
  return updateExperiment(id, {
    status: 'completed',
    winning_variant_id: winningVariantId || null,
    completed_at: new Date().toISOString(),
  } as any);
}

// ─── Variant CRUD ───────────────────────────────────────────────────────────

export async function addVariant(input: {
  experiment_id: string;
  name: string;
  is_control?: boolean;
  weight?: number;
  config: PaywallConfig;
}) {
  const { data, error } = await supabase
    .from('variants')
    .insert(input)
    .select()
    .single();

  if (error) throw error;
  return data as VariantRow;
}

export async function updateVariant(id: string, updates: { name?: string; weight?: number; config?: PaywallConfig }) {
  const { data, error } = await supabase
    .from('variants')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteVariant(id: string) {
  const { error } = await supabase.from('variants').delete().eq('id', id);
  if (error) throw error;
}

// ─── Events ─────────────────────────────────────────────────────────────────

export async function recordEvents(
  appId: string,
  events: Array<{
    experiment_id: string;
    variant_id: string;
    user_id: string;
    event_type: string;
    trigger_point?: string;
    metadata?: Record<string, unknown>;
  }>
) {
  const rows = events.map(e => ({ ...e, app_id: appId }));
  const { error } = await supabase.from('events').insert(rows);
  if (error) throw error;
  return { recorded: rows.length };
}
