-- Operational table: apply once as the schema owner before enabling RATE_LIMIT_STORE=postgres.
-- This additive change does not alter the event schema version or event records.
CREATE TABLE IF NOT EXISTS api_rate_limits (
  prefix TEXT NOT NULL,
  key TEXT NOT NULL,
  hits INTEGER NOT NULL CHECK (hits >= 0),
  expires BIGINT NOT NULL,
  PRIMARY KEY (prefix,key)
);
CREATE INDEX IF NOT EXISTS idx_api_rate_limits_expiry ON api_rate_limits(expires);
