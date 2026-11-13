CREATE TABLE practices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  doctor_count INTEGER NOT NULL,
  bonus_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE hipaa_forms (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
  form_version TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  signer_name TEXT NOT NULL,
  signer_title TEXT NOT NULL,
  npi TEXT,
  signature TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  signed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT,
  size INTEGER NOT NULL,
  kind TEXT NOT NULL,
  claims_imported INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL,
  payer_icn TEXT,
  payer TEXT,
  billed_cents INTEGER NOT NULL DEFAULT 0,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  denied_cents INTEGER NOT NULL DEFAULT 0,
  carc TEXT NOT NULL,
  category TEXT,
  recommended_action TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, claim_id, carc)
);
CREATE INDEX claims_practice_status ON claims(practice_id, status);
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
  system_name TEXT NOT NULL,
  category TEXT NOT NULL,
  contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'link_created',
  link_hash TEXT UNIQUE,
  link_expires_at TEXT,
  ingest_key_hash TEXT UNIQUE,
  ingest_key_prefix TEXT,
  enc_credentials TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  practice_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX audit_practice ON audit_log(practice_id, created_at);
