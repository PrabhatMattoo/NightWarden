CREATE TABLE IF NOT EXISTS runner (
  id             TEXT     NOT NULL PRIMARY KEY,
  -- The SHA-256 hash, never the credential.
  token          TEXT     NOT NULL UNIQUE,
  platform       TEXT     NOT NULL CHECK (platform IN ('docker', 'kubernetes')),
  server_name    TEXT     NOT NULL UNIQUE,
  created_at     TEXT     NOT NULL,
  last_used_at   TEXT
);

CREATE TABLE IF NOT EXISTS config (
  id                            TEXT     NOT NULL PRIMARY KEY,
  active_provider               TEXT,
  max_retries                   INTEGER  NOT NULL DEFAULT 3,
  max_investigations_per_hour   INTEGER  NOT NULL DEFAULT 10,
  check_in_after_ms             INTEGER  NOT NULL DEFAULT 1800000,
  tool_call_ceiling_ms          INTEGER  NOT NULL DEFAULT 600000,
  sandbox_idle_timeout_ms       INTEGER  NOT NULL DEFAULT 3600000,
  sandbox_cpus                  INTEGER  NOT NULL DEFAULT 2,
  sandbox_memory_mb             INTEGER  NOT NULL DEFAULT 4096,
  sandbox_require_gvisor        INTEGER  NOT NULL DEFAULT 0,
  sandbox_network               TEXT     NOT NULL DEFAULT 'allowlist',
  -- Newline-joined, which is the Settings textarea's own shape.
  sandbox_allowlist_hosts       TEXT     NOT NULL DEFAULT 'registry.npmjs.org
registry.yarnpkg.com
repo.yarnpkg.com',
  key_check                     TEXT,
  updated_at                    TEXT     NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_config (
  provider            TEXT     NOT NULL PRIMARY KEY,
  model               TEXT,
  base_url            TEXT,
  api_key_encrypted   TEXT,
  reasoning_level     TEXT,
  updated_at          TEXT     NOT NULL
);

CREATE TABLE IF NOT EXISTS integrations (
  id            TEXT   NOT NULL PRIMARY KEY,
  kind          TEXT   NOT NULL,
  name          TEXT   NOT NULL,
  config        TEXT   NOT NULL,
  -- One encrypted value whose plaintext is a map, so a row can carry two.
  secrets       TEXT,
  -- Set only for a sender that presents a credential to us.
  token_hash    TEXT   UNIQUE,
  last_used_at  TEXT,
  -- When the third party last refused the stored credential, and its reason.
  rejected_at   TEXT,
  rejection     TEXT,
  created_at    TEXT   NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_name ON integrations(name);
CREATE INDEX IF NOT EXISTS idx_integrations_kind ON integrations(kind);

CREATE TABLE IF NOT EXISTS sessions (
  session_id           TEXT     NOT NULL PRIMARY KEY,
  title                TEXT     NOT NULL DEFAULT '',
  investigation        INTEGER  NOT NULL DEFAULT 0,
  -- Every value but 'running' derives from the columns below; 'running' is
  -- claimed by a conditional UPDATE, so the row is the dispatch mutex too.
  status               TEXT     NOT NULL DEFAULT 'completed'
                                CHECK (status IN ('action_required', 'running',
                                  'resolved', 'stopped', 'failed', 'completed',
                                  'not_started')),
  -- Why the hourly limit left this session for a person to start. Kept after a
  -- Start, so the hourly count still reads it as not started automatically.
  held_reason          TEXT,
  failed_attempts      INTEGER  NOT NULL DEFAULT 0,
  failure_kind         TEXT     CHECK (failure_kind IN ('transient', 'permanent')),
  stopped_at           TEXT,
  -- The gate, all null when the session is not parked on one.
  awaiting_tool_use_id TEXT,
  awaiting_kind        TEXT     CHECK (awaiting_kind IN
                                  ('approval', 'clarification', 'continue')),
  awaiting_results     TEXT     NOT NULL DEFAULT '[]',
  -- Stamped before an approved call runs, so a crash in the gap says the write
  -- may already have happened rather than replaying it.
  attempt_started_at   TEXT,
  candidates           TEXT     NOT NULL DEFAULT '[]',
  findings             TEXT     NOT NULL DEFAULT '[]',
  report               TEXT,
  record_updated_at    TEXT,
  created_at           TEXT     NOT NULL,
  last_activity_at     TEXT     NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_list
  ON sessions(investigation,
              (awaiting_tool_use_id IS NOT NULL) DESC,
              last_activity_at DESC,
              session_id ASC);
DROP INDEX IF EXISTS idx_sessions_kind_activity;

CREATE TABLE IF NOT EXISTS alerts (
  id                 INTEGER  NOT NULL PRIMARY KEY,
  session_id         TEXT     NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  group_key          TEXT     NOT NULL,
  source_alert_id    TEXT     NOT NULL,
  -- Its own column so json_each reads the labels without the alert beside them.
  labels             TEXT     NOT NULL DEFAULT '{}',
  alert_type         TEXT     NOT NULL DEFAULT 'unknown',
  fired_at           TEXT     NOT NULL,
  arrived_at         TEXT     NOT NULL,
  cleared_at         TEXT,
  injected           INTEGER  NOT NULL DEFAULT 0,
  -- 1 while an alert that joined a run waits for the model to be told of it.
  pending_delivery   INTEGER  NOT NULL DEFAULT 0,
  dropped_alerts     INTEGER  NOT NULL DEFAULT 0,
  group_context      TEXT,
  alert              TEXT     NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_session ON alerts(session_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_firing
  ON alerts(source_alert_id, fired_at) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_open
  ON alerts(session_id) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_group ON alerts(group_key);

CREATE TABLE IF NOT EXISTS session_transcript (
  session_id     TEXT     NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  seq            INTEGER  NOT NULL,
  kind           TEXT     NOT NULL,
  content        TEXT     NOT NULL,
  canonical      TEXT,
  timestamp      TEXT     NOT NULL,
  -- The sender's id for a person's message; null on every row no person sent.
  client_id      TEXT,
  -- Which note a system_reminder row is; null on every other kind.
  reminder       TEXT     CHECK (reminder IN ('alert_opening',
                            'candidates_opening', 'frontier', 'falsification',
                            'report_request', 'report_retry', 'closing',
                            'text_only', 'reopen', 'record_check',
                            'toolset_change', 'injected_alerts')),
  PRIMARY KEY (session_id, seq)
);

-- A citable result past the ceiling, kept whole so the agent can page through it.
CREATE TABLE IF NOT EXISTS tool_result_store (
  session_id     TEXT     NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  tool_call_id   TEXT     NOT NULL,
  content        TEXT     NOT NULL,
  PRIMARY KEY (session_id, tool_call_id)
);


-- Better Auth's own four tables, transcribed from what its getMigrations emits
-- for this config. It writes dates as ISO strings and booleans as 0/1.

CREATE TABLE user (
  id             TEXT     NOT NULL PRIMARY KEY,
  name           TEXT     NOT NULL,
  email          TEXT     NOT NULL UNIQUE,
  email_verified INTEGER  NOT NULL,
  image          TEXT,
  created_at     DATE     NOT NULL,
  updated_at     DATE     NOT NULL,
  -- 'admin' or 'member'. The admin plugin stamps 'member', so the first owner is
  -- raised to 'admin' by a create hook rather than by this column's default.
  role           TEXT,
  banned         INTEGER,
  ban_reason     TEXT,
  ban_expires    DATE,
  theme          TEXT     NOT NULL DEFAULT 'system'
);

-- Renamed from Better Auth's `session`, which would otherwise sit one letter
-- from `sessions`, the agent's own.
CREATE TABLE auth_session (
  id              TEXT     NOT NULL PRIMARY KEY,
  expires_at      DATE     NOT NULL,
  token           TEXT     NOT NULL UNIQUE,
  created_at      DATE     NOT NULL,
  updated_at      DATE     NOT NULL,
  ip_address      TEXT,
  user_agent      TEXT,
  user_id         TEXT     NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  impersonated_by TEXT
);

-- One row per authentication method on a user. Email and password is a row with
-- provider_id 'credential' holding the argon2id hash; SSO would add a second.
CREATE TABLE account (
  id                          TEXT     NOT NULL PRIMARY KEY,
  account_id                  TEXT     NOT NULL,
  provider_id                 TEXT     NOT NULL,
  user_id                     TEXT     NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  access_token                TEXT,
  refresh_token               TEXT,
  id_token                    TEXT,
  access_token_expires_at     DATE,
  refresh_token_expires_at    DATE,
  scope                       TEXT,
  password                    TEXT,
  created_at                  DATE     NOT NULL,
  updated_at                  DATE     NOT NULL
);

-- Short-lived tokens: password resets and email verification today, and an
-- invite link when one is built.
CREATE TABLE verification (
  id         TEXT     NOT NULL PRIMARY KEY,
  identifier TEXT     NOT NULL,
  value      TEXT     NOT NULL,
  expires_at DATE     NOT NULL,
  created_at DATE     NOT NULL,
  updated_at DATE     NOT NULL
);

CREATE INDEX auth_session_user_id_idx ON auth_session (user_id);
CREATE INDEX account_user_id_idx ON account (user_id);
CREATE INDEX verification_identifier_idx ON verification (identifier);
