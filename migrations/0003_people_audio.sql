PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL DEFAULT '',
  organization_type TEXT NOT NULL CHECK (organization_type IN ('customer', 'internal', 'partner', 'other')),
  parent_id TEXT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'unknown')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER NULL,
  FOREIGN KEY (parent_id) REFERENCES organizations(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  organization_id TEXT NULL,
  department TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'unknown')),
  processing_mode TEXT NOT NULL CHECK (processing_mode IN ('external_ai', 'platform_rules', 'manual_only')),
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS person_roles (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  organization_id TEXT NULL,
  role_type TEXT NOT NULL CHECK (role_type IN ('customer', 'fae', 'ae', 'rd', 'pm', 'tester', 'other')),
  role_name TEXT NOT NULL DEFAULT '',
  scope_description TEXT NOT NULL DEFAULT '',
  valid_from TEXT NULL,
  valid_to TEXT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'meeting', 'project', 'imported', 'suggested')),
  confidence REAL NOT NULL DEFAULT 0.6,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER NULL,
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS person_expertise (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  expertise_name TEXT NOT NULL,
  expertise_category TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL CHECK (level IN ('unknown', 'familiar', 'strong', 'specialist')),
  scope_description TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'project', 'meeting', 'suggestion')),
  source_id TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.6,
  review_status TEXT NOT NULL CHECK (review_status IN ('pending', 'confirmed', 'rejected', 'suggested', 'edited')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER NULL,
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_people (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL CHECK (relationship_type IN ('customer_contact', 'fae', 'ae', 'rd', 'project_owner', 'tester', 'supporter', 'other')),
  responsibility TEXT NOT NULL DEFAULT '',
  module_id TEXT NULL,
  valid_from TEXT NULL,
  valid_to TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'proposed', 'archived')),
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'meeting', 'project', 'imported', 'suggested')),
  confidence REAL NOT NULL DEFAULT 0.6,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER NULL,
  FOREIGN KEY (project_id) REFERENCES work_projects(id) ON DELETE CASCADE,
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE,
  FOREIGN KEY (module_id) REFERENCES work_modules(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS work_item_people (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('owner', 'assignee', 'requester', 'reviewer', 'mentioned', 'supporter', 'waiting_on')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER NULL,
  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audio_recordings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NULL,
  description TEXT NOT NULL DEFAULT '',
  project_id TEXT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('upload', 'meeting', 'import', 'manual')),
  processing_mode TEXT NOT NULL CHECK (processing_mode IN ('external_ai', 'platform_rules', 'manual_only')),
  requested_model_id TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploaded', 'queued', 'validating', 'transcribing', 'diarizing', 'aligning', 'review', 'analyzing', 'proposal_ready', 'completed', 'failed', 'cancelled', 'expired', 'archived')),
  language TEXT NOT NULL DEFAULT '',
  transcript_summary TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER NULL,
  FOREIGN KEY (project_id) REFERENCES work_projects(id) ON DELETE SET NULL,
  FOREIGN KEY (requested_model_id) REFERENCES ai_models(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS audio_transcript_segments (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL,
  segment_index INTEGER NOT NULL,
  start_ms INTEGER NULL,
  end_ms INTEGER NULL,
  speaker_label TEXT NOT NULL DEFAULT '',
  person_id TEXT NULL,
  text TEXT NOT NULL DEFAULT '',
  asr_confidence REAL NULL,
  language TEXT NOT NULL DEFAULT '',
  is_overlap INTEGER NOT NULL DEFAULT 0,
  review_status TEXT NOT NULL CHECK (review_status IN ('pending', 'confirmed', 'rejected', 'suggested', 'edited')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER NULL,
  FOREIGN KEY (recording_id) REFERENCES audio_recordings(id) ON DELETE CASCADE,
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE SET NULL,
  UNIQUE (recording_id, segment_index)
);

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  recording_id TEXT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  meeting_date TEXT NULL,
  meeting_type TEXT NOT NULL CHECK (meeting_type IN ('customer', 'internal', 'project', 'support', 'other')),
  selected_project_ids_json TEXT NOT NULL DEFAULT '[]',
  participant_status TEXT NOT NULL CHECK (participant_status IN ('unknown', 'partial', 'confirmed')),
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft', 'review', 'approved', 'archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER NULL,
  FOREIGN KEY (recording_id) REFERENCES audio_recordings(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS meeting_participants (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  person_id TEXT NULL,
  speaker_label TEXT NOT NULL DEFAULT '',
  attendance_status TEXT NOT NULL CHECK (attendance_status IN ('unknown', 'present', 'absent', 'partial')),
  identification_method TEXT NOT NULL CHECK (identification_method IN ('manual', 'name_match', 'voice_match', 'suggested')),
  confidence REAL NOT NULL DEFAULT 0.5,
  confirmed_at INTEGER NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER NULL,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS meeting_topics (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  start_ms INTEGER NULL,
  end_ms INTEGER NULL,
  project_id TEXT NULL,
  module_id TEXT NULL,
  topic_type TEXT NOT NULL CHECK (topic_type IN ('project_progress', 'issue', 'decision', 'requirement', 'resource', 'schedule', 'other')),
  confidence REAL NOT NULL DEFAULT 0.5,
  review_status TEXT NOT NULL CHECK (review_status IN ('pending', 'confirmed', 'rejected', 'suggested', 'edited')),
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER NULL,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES work_projects(id) ON DELETE SET NULL,
  FOREIGN KEY (module_id) REFERENCES work_modules(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS person_interactions (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  project_id TEXT NULL,
  meeting_id TEXT NULL,
  interaction_type TEXT NOT NULL CHECK (interaction_type IN ('meeting', 'issue', 'support', 'decision', 'other')),
  summary TEXT NOT NULL DEFAULT '',
  occurred_at INTEGER NOT NULL,
  source_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER NULL,
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES work_projects(id) ON DELETE SET NULL,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_organizations_parent_status ON organizations(parent_id, status, archived_at, name);
CREATE INDEX IF NOT EXISTS idx_people_org_status ON people(organization_id, status, archived_at, display_name);
CREATE INDEX IF NOT EXISTS idx_people_name ON people(display_name);
CREATE INDEX IF NOT EXISTS idx_person_roles_person ON person_roles(person_id, archived_at, is_primary DESC, valid_from DESC);
CREATE INDEX IF NOT EXISTS idx_person_roles_org ON person_roles(organization_id, role_type, archived_at);
CREATE INDEX IF NOT EXISTS idx_person_expertise_person ON person_expertise(person_id, archived_at, review_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_people_project ON project_people(project_id, archived_at, relationship_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_people_person ON project_people(person_id, archived_at, status);
CREATE INDEX IF NOT EXISTS idx_work_item_people_item ON work_item_people(work_item_id, archived_at, relation_type);
CREATE INDEX IF NOT EXISTS idx_work_item_people_person ON work_item_people(person_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_audio_recordings_status ON audio_recordings(status, archived_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_audio_recordings_project ON audio_recordings(project_id, archived_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_audio_segments_recording ON audio_transcript_segments(recording_id, archived_at, segment_index);
CREATE INDEX IF NOT EXISTS idx_audio_segments_person ON audio_transcript_segments(person_id, review_status, archived_at);
CREATE INDEX IF NOT EXISTS idx_meetings_status_date ON meetings(status, meeting_type, meeting_date, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_recording ON meetings(recording_id);
CREATE INDEX IF NOT EXISTS idx_meeting_participants_meeting ON meeting_participants(meeting_id, archived_at, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_meeting_topics_meeting ON meeting_topics(meeting_id, archived_at, sort_order);
CREATE INDEX IF NOT EXISTS idx_person_interactions_person ON person_interactions(person_id, occurred_at DESC, archived_at);
CREATE INDEX IF NOT EXISTS idx_person_interactions_project ON person_interactions(project_id, meeting_id, occurred_at DESC);

PRAGMA foreign_keys = ON;
