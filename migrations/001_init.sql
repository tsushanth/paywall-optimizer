-- 001_init.sql
-- PaywallOptimizer: apps, experiments, variants, assignments, events, results

-- ============================================================================
-- 1. TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS apps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  bundle_id       TEXT NOT NULL UNIQUE,
  api_key         TEXT NOT NULL UNIQUE,
  platform        TEXT NOT NULL DEFAULT 'ios',
  store_product_ids TEXT[] DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS experiments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          UUID NOT NULL REFERENCES apps(id),
  name            TEXT NOT NULL,
  trigger_point   TEXT NOT NULL DEFAULT 'onboarding',
  status          TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','running','paused','completed')),
  strategy        TEXT NOT NULL DEFAULT 'ab_test'
    CHECK (strategy IN ('ab_test','bandit')),
  traffic_pct     INTEGER NOT NULL DEFAULT 100,
  targeting_rules JSONB NOT NULL DEFAULT '{}',
  min_sample_size INTEGER NOT NULL DEFAULT 200,
  confidence_level NUMERIC(4,3) NOT NULL DEFAULT 0.95,
  winning_variant_id UUID,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS variants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id   UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  is_control      BOOLEAN NOT NULL DEFAULT false,
  weight          INTEGER NOT NULL DEFAULT 1,
  config          JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id   UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  variant_id      UUID NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  app_id          UUID NOT NULL,
  user_id         TEXT NOT NULL,
  user_attributes JSONB DEFAULT '{}',
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(experiment_id, user_id)
);

CREATE TABLE IF NOT EXISTS events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          UUID NOT NULL,
  experiment_id   UUID NOT NULL,
  variant_id      UUID NOT NULL,
  user_id         TEXT NOT NULL,
  event_type      TEXT NOT NULL
    CHECK (event_type IN ('impression','dismiss','cta_tap','purchase','trial_start')),
  trigger_point   TEXT,
  metadata        JSONB DEFAULT '{}',
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS results (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id   UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  variant_id      UUID NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  impressions     INTEGER NOT NULL DEFAULT 0,
  dismissals      INTEGER NOT NULL DEFAULT 0,
  cta_taps        INTEGER NOT NULL DEFAULT 0,
  purchases       INTEGER NOT NULL DEFAULT 0,
  trial_starts    INTEGER NOT NULL DEFAULT 0,
  total_revenue   NUMERIC(12,4) NOT NULL DEFAULT 0,
  conversion_rate NUMERIC(8,6),
  revenue_per_impression NUMERIC(12,6),
  is_significant  BOOLEAN DEFAULT false,
  p_value         NUMERIC(10,8),
  evaluated_at    TIMESTAMPTZ,
  UNIQUE(experiment_id, variant_id)
);

-- ============================================================================
-- 2. INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS ix_experiments_app ON experiments(app_id, status);
CREATE INDEX IF NOT EXISTS ix_variants_experiment ON variants(experiment_id);
CREATE INDEX IF NOT EXISTS ix_assignments_lookup ON assignments(experiment_id, user_id);
CREATE INDEX IF NOT EXISTS ix_assignments_app_user ON assignments(app_id, user_id);
CREATE INDEX IF NOT EXISTS ix_events_experiment ON events(experiment_id, variant_id, event_type);
CREATE INDEX IF NOT EXISTS ix_events_ts ON events(app_id, ts DESC);
CREATE INDEX IF NOT EXISTS ix_results_experiment ON results(experiment_id);

-- ============================================================================
-- 3. HELPER: updated_at trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_experiments_updated_at
  BEFORE UPDATE ON experiments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
