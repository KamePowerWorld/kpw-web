PRAGMA foreign_keys = ON;

CREATE TABLE page_policies (
  page_id TEXT PRIMARY KEY,
  access_mode TEXT NOT NULL DEFAULT 'inherit' CHECK (access_mode IN ('inherit', 'custom')),
  creator_user_id TEXT,
  manager_user_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE page_grants (
  page_id TEXT NOT NULL REFERENCES page_policies(page_id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('role', 'user')),
  subject_id TEXT NOT NULL,
  can_edit INTEGER NOT NULL DEFAULT 0 CHECK (can_edit IN (0, 1)),
  create_children_mode TEXT CHECK (create_children_mode IN ('inherit', 'custom')),
  PRIMARY KEY (page_id, subject_type, subject_id)
);

CREATE INDEX page_grants_subject ON page_grants(subject_type, subject_id);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  page_id TEXT,
  before_json TEXT,
  after_json TEXT,
  git_commit_sha TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX audit_events_page_time ON audit_events(page_id, created_at DESC);
