export const PRODUCT_PERSISTENCE_FORMAT = "myagents-sqlite-session-v1" as const;
export const PRODUCT_PERSISTENCE_SCHEMA_VERSION = 2 as const;
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

export const PRODUCT_PERSISTENCE_SCHEMA_SQL = `${PRODUCT_PERSISTENCE_SCHEMA_V1_SQL.trim()}

${PRODUCT_CHECKPOINT_SCHEMA_SQL.trim()}
` as const;

export const PRODUCT_PERSISTENCE_TABLES = Object.freeze([
  "checkpoint_blobs",
  "checkpoint_records",
  "session_events",
  "session_generations",
  "sessions",
  "store_meta",
] as const);
