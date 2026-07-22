PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  parent_id TEXT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  default_processing_mode TEXT NOT NULL CHECK (default_processing_mode IN ('external_ai','platform_rules','manual_only')),
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER NULL,
  FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('current','historical','archived')),
  processing_mode TEXT NULL CHECK (processing_mode IN ('external_ai','platform_rules','manual_only') OR processing_mode IS NULL),
  valid_from INTEGER NULL,
  valid_to INTEGER NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER NULL,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS knowledge_blocks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  heading TEXT NOT NULL,
  body_md TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  block_type TEXT NOT NULL DEFAULT 'note',
  sort_order INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('current','historical','archived')),
  processing_mode TEXT NULL CHECK (processing_mode IN ('external_ai','platform_rules','manual_only') OR processing_mode IS NULL),
  valid_from INTEGER NULL,
  valid_to INTEGER NULL,
  source_capture_id TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (source_capture_id) REFERENCES captures(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS block_versions (
  id TEXT PRIMARY KEY,
  block_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  heading TEXT NOT NULL,
  body_md TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  proposal_operation_id TEXT NULL,
  change_note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (block_id) REFERENCES knowledge_blocks(id) ON DELETE CASCADE,
  FOREIGN KEY (proposal_operation_id) REFERENCES proposal_operations(id) ON DELETE SET NULL,
  UNIQUE (block_id, version_no)
);

CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY,
  raw_text TEXT NOT NULL,
  cleaned_text TEXT NOT NULL DEFAULT '',
  preferred_category_id TEXT NULL,
  processing_mode TEXT NOT NULL CHECK (processing_mode IN ('external_ai','platform_rules','manual_only')),
  requested_model_id TEXT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft','analyzing','review','approved','partial','rejected','failed','archived')),
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER NULL,
  FOREIGN KEY (preferred_category_id) REFERENCES categories(id) ON DELETE SET NULL,
  FOREIGN KEY (requested_model_id) REFERENCES ai_models(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL,
  provider_id TEXT NULL,
  model_id TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','edited','rejected','superseded','failed')),
  cleaned_text TEXT NOT NULL,
  classification_json TEXT NOT NULL DEFAULT '{}',
  conflicts_json TEXT NOT NULL DEFAULT '[]',
  questions_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  input_tokens INTEGER NULL,
  output_tokens INTEGER NULL,
  estimated_cost REAL NULL,
  cost_currency TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id) REFERENCES ai_providers(id) ON DELETE SET NULL,
  FOREIGN KEY (model_id) REFERENCES ai_models(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS proposal_operations (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create_document','create_block','append','merge','replace','move','mark_historical','archive')),
  target_category_id TEXT NULL,
  target_document_id TEXT NULL,
  target_block_id TEXT NULL,
  proposed_title TEXT NOT NULL DEFAULT '',
  proposed_heading TEXT NOT NULL DEFAULT '',
  proposed_body_md TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','edited','rejected','superseded')),
  sort_order INTEGER NOT NULL,
  reviewed_at INTEGER NULL,
  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE,
  FOREIGN KEY (target_category_id) REFERENCES categories(id) ON DELETE SET NULL,
  FOREIGN KEY (target_document_id) REFERENCES documents(id) ON DELETE SET NULL,
  FOREIGN KEY (target_block_id) REFERENCES knowledge_blocks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ai_providers (
  id TEXT PRIMARY KEY,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('deepseek','volcengine','cloudflare_ai','openai_compatible')),
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

CREATE TABLE IF NOT EXISTS ai_models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  supports_structured_output INTEGER NOT NULL DEFAULT 1,
  thinking_enabled INTEGER NOT NULL DEFAULT 0,
  cost_level TEXT NOT NULL CHECK (cost_level IN ('free','low','medium','high','unknown')),
  input_price REAL NULL,
  output_price REAL NULL,
  price_currency TEXT NOT NULL DEFAULT '',
  context_limit INTEGER NULL,
  max_output_tokens INTEGER NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (provider_id) REFERENCES ai_providers(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS ai_routes (
  id TEXT PRIMARY KEY,
  task_type TEXT UNIQUE NOT NULL CHECK (task_type IN ('organize_capture','compress_context')),
  default_model_id TEXT NULL,
  fallback_model_ids TEXT NOT NULL DEFAULT '[]',
  timeout_ms INTEGER NOT NULL,
  max_retries INTEGER NOT NULL,
  allow_cross_provider INTEGER NOT NULL,
  max_input_chars INTEGER NOT NULL,
  max_output_tokens INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (default_model_id) REFERENCES ai_models(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ai_runs (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,
  capture_id TEXT NULL,
  provider_id TEXT NULL,
  model_id TEXT NULL,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  input_tokens INTEGER NULL,
  output_tokens INTEGER NULL,
  estimated_cost REAL NULL,
  cost_currency TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER NULL,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE SET NULL,
  FOREIGN KEY (provider_id) REFERENCES ai_providers(id) ON DELETE SET NULL,
  FOREIGN KEY (model_id) REFERENCES ai_models(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS context_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  selection_json TEXT NOT NULL,
  ordering_json TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL CHECK (mode IN ('full','compact','custom')),
  token_budget INTEGER NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  last_failed_at INTEGER NOT NULL,
  locked_until INTEGER NULL
);

INSERT OR IGNORE INTO categories
  (id, parent_id, name, slug, description, default_processing_mode, sort_order, created_at, updated_at)
VALUES
  ('cat_profile', NULL, '个人画像', 'profile', '稳定的人设、经历、能力边界和协作方式。', 'external_ai', 10, 0, 0),
  ('cat_work', NULL, '工作', 'work', '工作相关资料的根分类。', 'external_ai', 20, 0, 0),
  ('cat_work_current', 'cat_work', '当前工作', 'current-work', '当前岗位、目标、机制和工作边界。', 'external_ai', 21, 0, 0),
  ('cat_work_history', 'cat_work', '工作经历', 'work-history', '过去工作经历和历史有效资料。', 'external_ai', 22, 0, 0),
  ('cat_life', NULL, '生活', 'life', '生活安排、日常记录和非工作资料。', 'external_ai', 30, 0, 0),
  ('cat_preferences', NULL, '习惯与偏好', 'preferences', '个人偏好、习惯、沟通方式和做事偏向。', 'external_ai', 40, 0, 0),
  ('cat_goals', NULL, '目标与计划', 'goals', '长期目标、阶段计划和执行跟踪。', 'external_ai', 50, 0, 0),
  ('cat_methods', NULL, '方法与流程', 'methods', '可复用的方法、流程、规则和检查清单。', 'external_ai', 60, 0, 0),
  ('cat_inbox', NULL, '待归档', 'inbox', '暂时无法自动判断位置的资料。', 'platform_rules', 90, 0, 0);

INSERT OR IGNORE INTO ai_routes
  (id, task_type, default_model_id, fallback_model_ids, timeout_ms, max_retries, allow_cross_provider, max_input_chars, max_output_tokens, updated_at)
VALUES
  ('route_organize_capture', 'organize_capture', NULL, '[]', 30000, 1, 1, 24000, 1800, 0),
  ('route_compress_context', 'compress_context', NULL, '[]', 30000, 1, 1, 60000, 2200, 0);

CREATE INDEX IF NOT EXISTS idx_categories_parent_order ON categories(parent_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_documents_category_updated ON documents(category_id, deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_status_updated ON documents(status, deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_title ON documents(title);
CREATE INDEX IF NOT EXISTS idx_blocks_document_order ON knowledge_blocks(document_id, deleted_at, sort_order);
CREATE INDEX IF NOT EXISTS idx_blocks_status_updated ON knowledge_blocks(status, deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_blocks_source ON knowledge_blocks(source_capture_id);
CREATE INDEX IF NOT EXISTS idx_versions_block_created ON block_versions(block_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_state_updated ON captures(state, deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_created ON captures(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proposals_capture ON proposals(capture_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proposals_status_updated ON proposals(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_operations_proposal_order ON proposal_operations(proposal_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_operations_status ON proposal_operations(status);
CREATE INDEX IF NOT EXISTS idx_ai_models_provider_enabled ON ai_models(provider_id, enabled);
CREATE INDEX IF NOT EXISTS idx_ai_runs_created ON ai_runs(created_at DESC);
