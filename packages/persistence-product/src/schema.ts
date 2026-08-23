export const PRODUCT_PERSISTENCE_FORMAT = "myagents-sqlite-session-v1" as const;
export const PRODUCT_PERSISTENCE_SCHEMA_VERSION = 6 as const;
export const PRODUCT_PERSISTENCE_APPLICATION_ID = 0x4d594147 as const;

export const PRODUCT_PERSISTENCE_SCHEMA_V1_SQL = `
CREATE TABLE store_meta (
  singleton          INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_id           TEXT NOT NULL,
  schema_version     INTEGER NOT NULL,
  persistence_format TEXT NOT NULL,
  created_at         INTEGER NOT NULL
) STRICT;

CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,
  active_generation_id TEXT NOT NULL,
  state                TEXT NOT NULL CHECK (state IN ('active', 'tombstoned')),
  revision             INTEGER NOT NULL CHECK (revision >= 0),
  event_count          INTEGER NOT NULL CHECK (event_count >= 0),
  head_hash            TEXT NOT NULL,
  created_at           INTEGER NOT NULL
) STRICT;

CREATE TABLE session_generations (
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL,
  header_json   TEXT NOT NULL,
  origin         TEXT NOT NULL CHECK (origin IN ('create', 'rewind', 'fork', 'recovery')),
  state          TEXT NOT NULL CHECK (state IN ('active', 'archived', 'staging', 'purging')),
  revision       INTEGER NOT NULL CHECK (revision >= 0),
  event_count    INTEGER NOT NULL CHECK (event_count >= 0),
  head_hash      TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (session_id, generation_id)
) STRICT;

CREATE TABLE session_events (
  session_id    TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  seq            INTEGER NOT NULL CHECK (seq >= 0),
  type           TEXT NOT NULL,
  time           INTEGER NOT NULL,
  envelope_json  TEXT NOT NULL,
  chain_hash     TEXT NOT NULL,
  PRIMARY KEY (session_id, generation_id, seq),
  FOREIGN KEY (session_id, generation_id)
    REFERENCES session_generations(session_id, generation_id) ON DELETE CASCADE
) STRICT;
` as const;

export const PRODUCT_CHECKPOINT_SCHEMA_SQL = `
CREATE TABLE checkpoint_blobs (
  sha256     TEXT PRIMARY KEY,
  size       INTEGER NOT NULL CHECK (size >= 0 AND size <= 8388608),
  bytes      BLOB NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE checkpoint_records (
  checkpoint_id       TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  generation_id       TEXT NOT NULL,
  product_turn_id     TEXT NOT NULL,
  client_operation_id TEXT NOT NULL,
  dsh_turn            INTEGER NOT NULL CHECK (dsh_turn >= 1),
  call_id             TEXT NOT NULL,
  path                TEXT NOT NULL,
  tool                TEXT NOT NULL CHECK (tool IN ('Write', 'Edit')),
  prior_sha256        TEXT,
  expected_sha256     TEXT NOT NULL,
  actual_sha256       TEXT,
  state               TEXT NOT NULL CHECK (state IN ('prepared', 'published', 'settled', 'aborted', 'conflict')),
  policy_revision     TEXT NOT NULL,
  last_event_phase    TEXT CHECK (last_event_phase IS NULL OR last_event_phase IN ('prepared', 'published', 'settled', 'aborted', 'conflict')),
  last_event_seq      INTEGER CHECK (last_event_seq IS NULL OR last_event_seq >= 0),
  prepared_at         INTEGER NOT NULL,
  settled_at          INTEGER,
  UNIQUE (session_id, generation_id, call_id, path),
  FOREIGN KEY (session_id, generation_id)
    REFERENCES session_generations(session_id, generation_id) ON DELETE RESTRICT,
  FOREIGN KEY (prior_sha256) REFERENCES checkpoint_blobs(sha256) ON DELETE RESTRICT
) STRICT;
` as const;

export const PRODUCT_PERSISTENCE_SCHEMA_V2_SQL = `${PRODUCT_PERSISTENCE_SCHEMA_V1_SQL.trim()}

${PRODUCT_CHECKPOINT_SCHEMA_SQL.trim()}
` as const;

export const PRODUCT_STABLE_BOUNDARY_SCHEMA_SQL = `
CREATE TABLE mutation_journals (
  token                            TEXT PRIMARY KEY,
  kind                             TEXT NOT NULL CHECK (kind = 'rewind'),
  client_mutation_id               TEXT NOT NULL,
  request_fingerprint              TEXT NOT NULL,
  session_id                       TEXT NOT NULL,
  source_generation_id             TEXT NOT NULL,
  source_revision                  TEXT NOT NULL,
  boundary_id                      TEXT NOT NULL REFERENCES stable_boundaries(boundary_id) ON DELETE RESTRICT,
  source_transcript_postcondition  TEXT NOT NULL,
  target_transcript_postcondition  TEXT NOT NULL,
  target_generation_id             TEXT,
  phase                            TEXT NOT NULL CHECK (phase IN ('prepared', 'committing', 'committed', 'rolling_back', 'rolled_back', 'recovery_required')),
  attempt                          INTEGER NOT NULL CHECK (attempt >= 0),
  receipt_json                     TEXT,
  created_at                       INTEGER NOT NULL,
  updated_at                       INTEGER NOT NULL,
  UNIQUE (session_id, client_mutation_id),
  FOREIGN KEY (session_id, source_generation_id)
    REFERENCES session_generations(session_id, generation_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE rewind_file_plans (
  token                   TEXT NOT NULL REFERENCES mutation_journals(token) ON DELETE RESTRICT,
  path                    TEXT NOT NULL,
  expected_current_sha256 TEXT NOT NULL,
  target_sha256           TEXT,
  target_blob_sha256      TEXT REFERENCES checkpoint_blobs(sha256) ON DELETE RESTRICT,
  rollback_sha256         TEXT,
  rollback_blob_sha256    TEXT REFERENCES checkpoint_blobs(sha256) ON DELETE RESTRICT,
  sealed                  INTEGER NOT NULL CHECK (sealed IN (0, 1)),
  state                   TEXT NOT NULL CHECK (state IN ('prepared', 'published', 'rolled_back', 'conflict')),
  actual_sha256           TEXT,
  PRIMARY KEY (token, path),
  CHECK ((target_sha256 IS NULL) = (target_blob_sha256 IS NULL)),
  CHECK ((rollback_sha256 IS NULL) = (rollback_blob_sha256 IS NULL))
) STRICT;

CREATE TABLE stable_boundaries (
  boundary_id   TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  seq_exclusive INTEGER NOT NULL CHECK (seq_exclusive > 0),
  turn           INTEGER NOT NULL CHECK (turn >= 1),
  prefix_hash    TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE (session_id, generation_id, seq_exclusive),
  FOREIGN KEY (session_id, generation_id)
    REFERENCES session_generations(session_id, generation_id) ON DELETE RESTRICT
) STRICT;
` as const;

export const PRODUCT_PERSISTENCE_SCHEMA_V3_SQL = `${PRODUCT_PERSISTENCE_SCHEMA_V2_SQL.trim()}

${PRODUCT_STABLE_BOUNDARY_SCHEMA_SQL.trim()}
` as const;

export const PRODUCT_REWIND_CHILD_SCHEMA_SQL = `
CREATE TABLE rewind_child_plans (
  token                     TEXT NOT NULL REFERENCES mutation_journals(token) ON DELETE RESTRICT,
  child_session_id          TEXT NOT NULL,
  child_generation_id       TEXT NOT NULL,
  child_session_revision    INTEGER NOT NULL CHECK (child_session_revision >= 0),
  child_generation_revision INTEGER NOT NULL CHECK (child_generation_revision >= 0),
  state                     TEXT NOT NULL CHECK (state IN ('prepared', 'tombstoned', 'restored')),
  PRIMARY KEY (token, child_session_id),
  FOREIGN KEY (child_session_id, child_generation_id)
    REFERENCES session_generations(session_id, generation_id) ON DELETE RESTRICT
) STRICT;
` as const;

export const PRODUCT_PERSISTENCE_SCHEMA_V4_SQL = `${PRODUCT_PERSISTENCE_SCHEMA_V3_SQL.trim()}

${PRODUCT_REWIND_CHILD_SCHEMA_SQL.trim()}
` as const;

export const PRODUCT_FORK_SCHEMA_SQL = `
CREATE TABLE fork_journals (
  token                       TEXT PRIMARY KEY,
  client_mutation_id          TEXT NOT NULL,
  request_fingerprint         TEXT NOT NULL,
  source_session_id           TEXT NOT NULL,
  source_generation_id        TEXT NOT NULL,
  source_revision             TEXT NOT NULL,
  source_boundary_id          TEXT NOT NULL REFERENCES stable_boundaries(boundary_id) ON DELETE RESTRICT,
  target_runtime_home         TEXT NOT NULL,
  target_persistence_ref      TEXT NOT NULL,
  target_workspace_identity   TEXT NOT NULL,
  target_session_id           TEXT NOT NULL,
  target_generation_id        TEXT NOT NULL,
  phase                       TEXT NOT NULL CHECK (phase IN ('prepared', 'committing', 'committed', 'aborting', 'aborted', 'recovery_required')),
  attempt                     INTEGER NOT NULL CHECK (attempt >= 0),
  receipt_json                TEXT,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL,
  UNIQUE (source_session_id, client_mutation_id),
  FOREIGN KEY (source_session_id, source_generation_id)
    REFERENCES session_generations(session_id, generation_id) ON DELETE RESTRICT
) STRICT;
` as const;

export const PRODUCT_PERSISTENCE_SCHEMA_V5_SQL = `${PRODUCT_PERSISTENCE_SCHEMA_V4_SQL.trim()}

${PRODUCT_FORK_SCHEMA_SQL.trim()}
` as const;

export const PRODUCT_DELETE_SCHEMA_SQL = `
CREATE TABLE delete_journals (
  token                 TEXT PRIMARY KEY,
  client_mutation_id    TEXT NOT NULL,
  request_fingerprint   TEXT NOT NULL,
  session_id            TEXT NOT NULL,
  source_generation_id  TEXT NOT NULL,
  source_revision       TEXT NOT NULL,
  phase                 TEXT NOT NULL CHECK (phase IN ('prepared', 'committing', 'committed', 'rolling_back', 'rolled_back', 'recovery_required')),
  attempt               INTEGER NOT NULL CHECK (attempt >= 0),
  receipt_json          TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE (session_id, client_mutation_id),
  FOREIGN KEY (session_id, source_generation_id)
    REFERENCES session_generations(session_id, generation_id) ON DELETE RESTRICT
) STRICT;
` as const;

export const PRODUCT_SESSION_GENERATIONS_V6_SCHEMA_SQL = `
CREATE TABLE session_generations (
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL,
  header_json   TEXT NOT NULL,
  origin         TEXT NOT NULL CHECK (origin IN ('create', 'rewind', 'fork', 'recovery')),
  state          TEXT NOT NULL CHECK (state IN ('active', 'archived', 'staging', 'purging', 'tombstoned')),
  revision       INTEGER NOT NULL CHECK (revision >= 0),
  event_count    INTEGER NOT NULL CHECK (event_count >= 0),
  head_hash      TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (session_id, generation_id)
) STRICT;
` as const;

const PRODUCT_PERSISTENCE_SCHEMA_V6_BASE_SQL = PRODUCT_PERSISTENCE_SCHEMA_V5_SQL.replace(
  /CREATE TABLE session_generations \([\s\S]*?\n\) STRICT;/u,
  PRODUCT_SESSION_GENERATIONS_V6_SCHEMA_SQL.trim(),
);

export const PRODUCT_PERSISTENCE_SCHEMA_SQL = `${PRODUCT_PERSISTENCE_SCHEMA_V6_BASE_SQL.trim()}

${PRODUCT_DELETE_SCHEMA_SQL.trim()}
` as const;

export const PRODUCT_PERSISTENCE_TABLES = Object.freeze([
  "checkpoint_blobs",
  "checkpoint_records",
  "delete_journals",
  "fork_journals",
  "mutation_journals",
  "rewind_child_plans",
  "rewind_file_plans",
  "session_events",
  "session_generations",
  "sessions",
  "stable_boundaries",
  "store_meta",
] as const);
