PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS work_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'archived')),
  stage TEXT NOT NULL DEFAULT 'planning',
  goal TEXT NOT NULL DEFAULT '',
  current_summary TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  target_date TEXT NULL,
  processing_mode TEXT NOT NULL CHECK (processing_mode IN ('external_ai', 'platform_rules', 'manual_only')),
  tags_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER NULL
);

CREATE TABLE IF NOT EXISTS work_modules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'planning',
  status TEXT NOT NULL CHECK (status IN ('not_started', 'in_progress', 'testing', 'verifying', 'done', 'blocked', 'archived')),
  current_summary TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  target_date TEXT NULL,
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER NULL,
  FOREIGN KEY (project_id) REFERENCES work_projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  module_id TEXT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('task', 'issue', 'requirement', 'milestone', 'follow_up')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('not_started', 'in_progress', 'waiting_customer', 'waiting_internal', 'testing', 'verifying', 'blocked', 'done', 'archived')),
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  external_reference TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  current_result TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  due_date TEXT NULL,
  discovered_at TEXT NULL,
  resolved_at TEXT NULL,
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER NULL,
  FOREIGN KEY (project_id) REFERENCES work_projects(id) ON DELETE CASCADE,
  FOREIGN KEY (module_id) REFERENCES work_modules(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS work_milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  target_date TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'in_progress', 'at_risk', 'done', 'cancelled')),
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  current_result TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES work_projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS daily_work_logs (
  id TEXT PRIMARY KEY,
  work_date TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  cleaned_text TEXT NOT NULL DEFAULT '',
  selected_project_ids_json TEXT NOT NULL DEFAULT '[]',
  processing_mode TEXT NOT NULL CHECK (processing_mode IN ('external_ai', 'platform_rules', 'manual_only')),
  requested_model_id TEXT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'analyzing', 'review', 'approved', 'partial', 'rejected', 'failed', 'archived')),
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (requested_model_id) REFERENCES ai_models(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS daily_work_events (
  id TEXT PRIMARY KEY,
  daily_log_id TEXT NOT NULL,
  project_id TEXT NULL,
  module_id TEXT NULL,
  work_item_id TEXT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('progress', 'issue_found', 'issue_resolved', 'test_result', 'customer_feedback', 'decision', 'next_action')),
  content TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  review_status TEXT NOT NULL CHECK (review_status IN ('pending', 'accepted', 'rejected', 'edited')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (daily_log_id) REFERENCES daily_work_logs(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES work_projects(id) ON DELETE SET NULL,
  FOREIGN KEY (module_id) REFERENCES work_modules(id) ON DELETE SET NULL,
  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS work_update_proposals (
  id TEXT PRIMARY KEY,
  daily_log_id TEXT NOT NULL,
  project_id TEXT NULL,
  module_id TEXT NULL,
  work_item_id TEXT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'status_change', 'archive', 'link')),
  field_name TEXT NOT NULL DEFAULT '',
  old_value TEXT NOT NULL DEFAULT '',
  proposed_value TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  source_event_id TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'edited', 'rejected')),
  provider_id TEXT NULL,
  model_id TEXT NULL,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER NULL,
  FOREIGN KEY (daily_log_id) REFERENCES daily_work_logs(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES work_projects(id) ON DELETE SET NULL,
  FOREIGN KEY (module_id) REFERENCES work_modules(id) ON DELETE SET NULL,
  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE SET NULL,
  FOREIGN KEY (source_event_id) REFERENCES daily_work_events(id) ON DELETE SET NULL,
  FOREIGN KEY (provider_id) REFERENCES ai_providers(id) ON DELETE SET NULL,
  FOREIGN KEY (model_id) REFERENCES ai_models(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS daily_progress_drafts (
  id TEXT PRIMARY KEY,
  daily_log_id TEXT NOT NULL,
  work_date TEXT NOT NULL,
  project_scope_json TEXT NOT NULL DEFAULT '[]',
  progress_text TEXT NOT NULL,
  detail_text TEXT NOT NULL DEFAULT '',
  next_action_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft', 'edited', 'approved', 'copied', 'archived')),
  provider_id TEXT NULL,
  model_id TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (daily_log_id) REFERENCES daily_work_logs(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id) REFERENCES ai_providers(id) ON DELETE SET NULL,
  FOREIGN KEY (model_id) REFERENCES ai_models(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS work_state_versions (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('project', 'module', 'item', 'milestone')),
  entity_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  change_reason TEXT NOT NULL DEFAULT '',
  source_event_id TEXT NULL,
  proposal_id TEXT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (entity_type, entity_id, version_no)
);

ALTER TABLE ai_runs ADD COLUMN daily_log_id TEXT NULL;

CREATE TABLE IF NOT EXISTS ai_routes_new (
  id TEXT PRIMARY KEY,
  task_type TEXT UNIQUE NOT NULL CHECK (task_type IN ('organize_capture', 'compress_context', 'daily_progress')),
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

INSERT INTO ai_routes_new (id, task_type, default_model_id, fallback_model_ids, timeout_ms, max_retries, allow_cross_provider, max_input_chars, max_output_tokens, updated_at)
SELECT id, task_type, default_model_id, fallback_model_ids, timeout_ms, max_retries, allow_cross_provider, max_input_chars, max_output_tokens, updated_at
  FROM ai_routes;

DROP TABLE ai_routes;
ALTER TABLE ai_routes_new RENAME TO ai_routes;

INSERT OR IGNORE INTO ai_routes
  (id, task_type, default_model_id, fallback_model_ids, timeout_ms, max_retries, allow_cross_provider, max_input_chars, max_output_tokens, updated_at)
VALUES
  ('route_organize_capture', 'organize_capture', NULL, '[]', 30000, 1, 1, 24000, 1800, 0),
  ('route_compress_context', 'compress_context', NULL, '[]', 30000, 1, 1, 60000, 2200, 0),
  ('route_daily_progress', 'daily_progress', NULL, '[]', 30000, 1, 1, 50000, 2200, 0);

CREATE INDEX IF NOT EXISTS idx_work_projects_status_updated ON work_projects(status, archived_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_projects_sort ON work_projects(sort_order, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_modules_project_status ON work_modules(project_id, status, archived_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_modules_project_sort ON work_modules(project_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_work_items_project_module_status ON work_items(project_id, module_id, status, archived_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_items_due ON work_items(due_date, status, priority);
CREATE INDEX IF NOT EXISTS idx_work_milestones_project_status ON work_milestones(project_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_logs_date_state ON daily_work_logs(work_date, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_events_log ON daily_work_events(daily_log_id, created_at);
CREATE INDEX IF NOT EXISTS idx_daily_events_project ON daily_work_events(project_id, module_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_update_proposals_log_status ON work_update_proposals(daily_log_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_update_proposals_status ON work_update_proposals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_progress_drafts_log_status ON daily_progress_drafts(daily_log_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_state_versions_entity ON work_state_versions(entity_type, entity_id, version_no DESC);

PRAGMA foreign_keys = ON;
