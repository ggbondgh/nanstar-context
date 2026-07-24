PRAGMA defer_foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ai_providers_0004 (
  id TEXT PRIMARY KEY,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('deepseek','volcengine','cloudflare_ai','openai_compatible','funasr')),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  key_ciphertext TEXT NOT NULL DEFAULT '',
  key_iv TEXT NOT NULL DEFAULT '',
  key_last4 TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  allow_auto_fallback INTEGER NOT NULL DEFAULT 1,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  last_checked_at INTEGER NULL,
  last_error TEXT NOT NULL DEFAULT '',
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO ai_providers_0004 (
  id, provider_type, name, base_url, key_ciphertext, key_iv, key_last4,
  enabled, allow_auto_fallback, health_status, last_checked_at, last_error,
  timeout_ms, created_at, updated_at
)
SELECT
  id, provider_type, name, base_url, key_ciphertext, key_iv, key_last4,
  enabled, allow_auto_fallback, health_status, last_checked_at, last_error,
  timeout_ms, created_at, updated_at
FROM ai_providers;

DROP TABLE ai_providers;
ALTER TABLE ai_providers_0004 RENAME TO ai_providers;

PRAGMA defer_foreign_keys = OFF;
