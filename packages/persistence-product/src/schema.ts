export const PRODUCT_PERSISTENCE_FORMAT = "myagents-sqlite-session-v1" as const;
export const PRODUCT_PERSISTENCE_SCHEMA_VERSION = 1 as const;
export const PRODUCT_PERSISTENCE_APPLICATION_ID = 0x4d594147 as const;

export const PRODUCT_PERSISTENCE_SCHEMA_SQL = `
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

export const PRODUCT_PERSISTENCE_TABLES = Object.freeze([
  "session_events",
  "session_generations",
  "sessions",
  "store_meta",
] as const);
