-- Genuine PriceRadar private-history schema v1 (pre-v2).
-- Extracted verbatim from MIGRATION_V1_SQL at commit 690e217205b3add3c544b3c65f2bf31685648467,
-- the last commit before schema v2 (reevaluation_runs, event_origin, reevaluation_run_id).
-- Deterministic; contains no data and no real Rappi information.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  store_key TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  external_store_id TEXT NOT NULL,
  storefront_slug TEXT NOT NULL,
  store_name TEXT NOT NULL,
  category_slug TEXT NOT NULL,
  verified_city_slug TEXT,
  verified_city_name TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(provider_id, external_store_id)
);

CREATE TABLE IF NOT EXISTS products (
  product_variant_key TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  external_product_id TEXT NOT NULL,
  external_variant_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  brand TEXT,
  category_slug TEXT NOT NULL,
  packaging_label TEXT NOT NULL,
  unit_quantity INTEGER NOT NULL CHECK (unit_quantity > 0),
  unit_type TEXT NOT NULL CHECK (unit_type IN ('g', 'ml', 'unit', 'kg', 'l')),
  canonical_product_url TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(provider_id, external_product_id, external_variant_id)
);

CREATE TABLE IF NOT EXISTS fulfillment_contexts (
  fulfillment_context_id TEXT PRIMARY KEY CHECK (
    fulfillment_context_id GLOB 'ctx-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  provider_id TEXT NOT NULL,
  verified_city_slug TEXT,
  verified_city_name TEXT,
  context_verification_status TEXT NOT NULL CHECK (
    context_verification_status IN ('PROVISIONAL_SESSION_CONTEXT', 'VERIFIED_ADDRESS_CONTEXT')
  ),
  active_address_evidence TEXT NOT NULL,
  city_metadata_evidence TEXT NOT NULL,
  serving_branch_evidence TEXT NOT NULL,
  catalog_context_evidence TEXT NOT NULL,
  pricing_verification_verdict TEXT NOT NULL CHECK (
    pricing_verification_verdict IN (
      'VERIFIED_ADDRESS_SPECIFIC_PRICING',
      'UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION'
    )
  ),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  CHECK (
    (context_verification_status = 'PROVISIONAL_SESSION_CONTEXT' AND pricing_verification_verdict != 'VERIFIED_ADDRESS_SPECIFIC_PRICING')
    OR
    (context_verification_status = 'VERIFIED_ADDRESS_CONTEXT' AND pricing_verification_verdict = 'VERIFIED_ADDRESS_SPECIFIC_PRICING')
  )
);

CREATE TABLE IF NOT EXISTS scan_runs (
  scan_run_id TEXT PRIMARY KEY,
  batch_fingerprint TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'SKIPPED_LOCKED')
  ),
  provider_id TEXT NOT NULL,
  store_key TEXT REFERENCES stores(store_key),
  fulfillment_context_id TEXT REFERENCES fulfillment_contexts(fulfillment_context_id),
  candidates_discovered INTEGER NOT NULL DEFAULT 0 CHECK (candidates_discovered >= 0),
  valid_observations INTEGER NOT NULL DEFAULT 0 CHECK (valid_observations >= 0),
  skipped_records INTEGER NOT NULL DEFAULT 0 CHECK (skipped_records >= 0),
  duplicate_records INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_records >= 0),
  opportunities_created INTEGER NOT NULL DEFAULT 0 CHECK (opportunities_created >= 0),
  error_category TEXT,
  error_summary TEXT
);

CREATE TABLE IF NOT EXISTS price_observations (
  observation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  listing_key TEXT NOT NULL,
  scan_run_id TEXT NOT NULL REFERENCES scan_runs(scan_run_id) ON DELETE CASCADE,
  product_variant_key TEXT NOT NULL REFERENCES products(product_variant_key),
  store_key TEXT NOT NULL REFERENCES stores(store_key),
  fulfillment_context_id TEXT NOT NULL REFERENCES fulfillment_contexts(fulfillment_context_id),
  city_slug TEXT NOT NULL,
  observed_price_cop INTEGER NOT NULL CHECK (observed_price_cop > 0),
  declared_reference_price_cop INTEGER CHECK (
    declared_reference_price_cop IS NULL OR declared_reference_price_cop > observed_price_cop
  ),
  availability TEXT NOT NULL CHECK (
    availability IN ('IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'UNKNOWN')
  ),
  observed_at TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (
    provenance IN ('PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL', 'LIVE_PRIVATE')
  ),
  geographic_verification_verdict TEXT NOT NULL CHECK (
    geographic_verification_verdict IN (
      'UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION',
      'VERIFIED_ADDRESS_SPECIFIC_PRICING'
    )
  ),
  serving_branch_evidence TEXT NOT NULL,
  catalog_context_evidence TEXT NOT NULL,
  address_specific_pricing_verified INTEGER NOT NULL CHECK (
    address_specific_pricing_verified IN (0, 1)
  ),
  is_superseded INTEGER NOT NULL DEFAULT 0 CHECK (is_superseded IN (0, 1)),
  superseded_reason TEXT,
  CHECK (
    (provenance = 'PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL' AND address_specific_pricing_verified = 0 AND geographic_verification_verdict = 'UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION')
    OR
    (provenance = 'LIVE_PRIVATE' AND address_specific_pricing_verified = 1 AND geographic_verification_verdict = 'VERIFIED_ADDRESS_SPECIFIC_PRICING')
  )
);

CREATE INDEX IF NOT EXISTS idx_price_observations_listing_history
  ON price_observations(listing_key, provenance, is_superseded, observed_at ASC, observation_id ASC);

CREATE INDEX IF NOT EXISTS idx_price_observations_product
  ON price_observations(product_variant_key, observed_at DESC);

CREATE TABLE IF NOT EXISTS opportunity_events (
  opportunity_id TEXT PRIMARY KEY,
  deduplication_key TEXT NOT NULL UNIQUE,
  listing_key TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES price_observations(observation_id) ON DELETE CASCADE,
  scan_run_id TEXT NOT NULL REFERENCES scan_runs(scan_run_id) ON DELETE CASCADE,
  product_variant_key TEXT NOT NULL REFERENCES products(product_variant_key),
  store_key TEXT NOT NULL REFERENCES stores(store_key),
  fulfillment_context_id TEXT NOT NULL REFERENCES fulfillment_contexts(fulfillment_context_id),
  opportunity_type TEXT NOT NULL CHECK (
    opportunity_type IN ('DECLARED_DISCOUNT', 'HISTORICAL_DROP', 'HISTORICAL_LOW', 'POTENTIAL_ANOMALY')
  ),
  label_es_co TEXT NOT NULL,
  baseline_price_cop INTEGER NOT NULL CHECK (baseline_price_cop > 0),
  previous_price_cop INTEGER CHECK (previous_price_cop IS NULL OR previous_price_cop > 0),
  observed_price_cop INTEGER NOT NULL CHECK (observed_price_cop > 0),
  savings_cop INTEGER NOT NULL CHECK (savings_cop > 0),
  discount_basis_points INTEGER NOT NULL CHECK (
    discount_basis_points > 0 AND discount_basis_points <= 10000
  ),
  discount_percentage INTEGER NOT NULL,
  historical_observation_count INTEGER NOT NULL CHECK (historical_observation_count >= 0),
  historical_low_cop INTEGER NOT NULL CHECK (historical_low_cop > 0),
  historical_median_cop INTEGER NOT NULL CHECK (historical_median_cop > 0),
  confidence TEXT NOT NULL CHECK (confidence IN ('LOW', 'MEDIUM', 'HIGH')),
  requires_verification INTEGER NOT NULL CHECK (requires_verification IN (0, 1)),
  provenance TEXT NOT NULL CHECK (
    provenance IN ('PRIVATE_AUTHENTICATED_SESSION_PROVISIONAL', 'LIVE_PRIVATE')
  ),
  geographic_verification_verdict TEXT NOT NULL CHECK (
    geographic_verification_verdict IN (
      'UNVERIFIED_BRANCH_OR_CATALOG_ASSOCIATION',
      'VERIFIED_ADDRESS_SPECIFIC_PRICING'
    )
  ),
  rationale_es_co TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (
    lifecycle_status IN ('ACTIVE', 'SUPERSEDED', 'EXPIRED', 'DISMISSED')
  )
);

CREATE INDEX IF NOT EXISTS idx_opportunity_events_listing
  ON opportunity_events(listing_key, lifecycle_status, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_opportunity_events_type
  ON opportunity_events(opportunity_type, lifecycle_status, discount_basis_points DESC);
