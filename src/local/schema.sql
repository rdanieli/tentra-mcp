-- Tentra local-mode SQLite schema (Phase 1, tier-1 only).
--
-- Translated from the Postgres/Prisma schema at packages/api/prisma/schema.prisma.
-- Scope: only the tier-1 tables required by the 15 MCP tools listed in the
-- local-backend plan. No pgvector (embeddings) and no enrichment (domains,
-- contracts, decisions, ownership) — those stay hosted-only for now.
--
-- Conventions:
-- - TEXT for CUID / string IDs and ISO-8601 timestamps.
-- - INTEGER (0/1) for booleans (mirrors Prisma Boolean → SQLite).
-- - FOREIGN KEY ... ON DELETE CASCADE matches the Prisma relations.
-- - Composite unique indexes replace Prisma @@unique tuples.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS code_repos (
  id             TEXT PRIMARY KEY,
  workspaceId    TEXT NOT NULL DEFAULT 'local',
  architectureId TEXT,
  rootPath       TEXT NOT NULL DEFAULT '',
  gitRemote      TEXT,
  defaultBranch  TEXT,
  lastIndexedAt  TEXT,
  createdAt      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS code_snapshots (
  id               TEXT PRIMARY KEY,
  repoId           TEXT NOT NULL,
  commitSha        TEXT,
  parentSnapshotId TEXT,
  stats            TEXT NOT NULL DEFAULT '{}',
  createdAt        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (repoId) REFERENCES code_repos(id) ON DELETE CASCADE,
  FOREIGN KEY (parentSnapshotId) REFERENCES code_snapshots(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_code_snapshots_repo ON code_snapshots(repoId, createdAt);

CREATE TABLE IF NOT EXISTS code_files (
  id             TEXT PRIMARY KEY,
  snapshotId     TEXT NOT NULL,
  serviceId      TEXT,
  relativePath   TEXT NOT NULL,
  language       TEXT NOT NULL,
  loc            INTEGER NOT NULL DEFAULT 0,
  contentHash    TEXT NOT NULL,
  parseError     TEXT,
  isTest         INTEGER NOT NULL DEFAULT 0,
  tier1IndexedAt TEXT,
  tier2IndexedAt TEXT,
  UNIQUE (snapshotId, relativePath),
  FOREIGN KEY (snapshotId) REFERENCES code_snapshots(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_code_files_service ON code_files(snapshotId, serviceId);
CREATE INDEX IF NOT EXISTS idx_code_files_hash    ON code_files(contentHash);

CREATE TABLE IF NOT EXISTS code_symbols (
  id             TEXT PRIMARY KEY,
  fileId         TEXT NOT NULL,
  snapshotId     TEXT NOT NULL,
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL,
  qualifiedName  TEXT NOT NULL,
  startLine      INTEGER NOT NULL,
  endLine        INTEGER NOT NULL,
  fanIn          INTEGER NOT NULL DEFAULT 0,
  fanOut         INTEGER NOT NULL DEFAULT 0,
  isGodNode      INTEGER NOT NULL DEFAULT 0,
  semanticRoleId TEXT,
  UNIQUE (snapshotId, qualifiedName),
  FOREIGN KEY (fileId) REFERENCES code_files(id) ON DELETE CASCADE,
  FOREIGN KEY (snapshotId) REFERENCES code_snapshots(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_code_symbols_file ON code_symbols(fileId);

CREATE TABLE IF NOT EXISTS code_edges (
  id           TEXT PRIMARY KEY,
  snapshotId   TEXT NOT NULL,
  fromSymbolId TEXT,
  toSymbolId   TEXT,
  toExternal   TEXT,
  edgeType     TEXT NOT NULL,
  FOREIGN KEY (snapshotId) REFERENCES code_snapshots(id) ON DELETE CASCADE,
  FOREIGN KEY (fromSymbolId) REFERENCES code_symbols(id) ON DELETE CASCADE,
  FOREIGN KEY (toSymbolId) REFERENCES code_symbols(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_code_edges_from ON code_edges(snapshotId, fromSymbolId);
CREATE INDEX IF NOT EXISTS idx_code_edges_to   ON code_edges(snapshotId, toSymbolId);

CREATE TABLE IF NOT EXISTS code_index_jobs (
  id              TEXT PRIMARY KEY,
  repoId          TEXT NOT NULL,
  snapshotId      TEXT,
  tier            TEXT NOT NULL,
  status          TEXT NOT NULL,
  totalFiles      INTEGER NOT NULL DEFAULT 0,
  processedFiles  INTEGER NOT NULL DEFAULT 0,
  lastBatchCursor INTEGER NOT NULL DEFAULT 0,
  resumptionState TEXT NOT NULL DEFAULT '{}',
  startedAt       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completedAt     TEXT,
  error           TEXT,
  FOREIGN KEY (repoId) REFERENCES code_repos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_code_index_jobs_status ON code_index_jobs(repoId, status);

CREATE TABLE IF NOT EXISTS code_semantics (
  id           TEXT PRIMARY KEY,
  fileId       TEXT,
  symbolId     TEXT,
  snapshotId   TEXT NOT NULL,
  purpose      TEXT NOT NULL,
  domainTags   TEXT NOT NULL DEFAULT '[]',  -- JSON-encoded string array
  confidence   REAL NOT NULL,
  extractedBy  TEXT NOT NULL,
  extractedAt  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  lensMetadata TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (fileId) REFERENCES code_files(id) ON DELETE CASCADE,
  FOREIGN KEY (symbolId) REFERENCES code_symbols(id) ON DELETE CASCADE,
  FOREIGN KEY (snapshotId) REFERENCES code_snapshots(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_code_semantics_file   ON code_semantics(fileId);
CREATE INDEX IF NOT EXISTS idx_code_semantics_symbol ON code_semantics(symbolId);

-- Phase 2 — embeddings.
--
-- Stores agent-generated dense vectors for files / symbols. Pure-JS cosine
-- similarity runs at query time; no native extension needed. The schema
-- mirrors packages/api/prisma/schema.prisma's `embeddings` table (entityType
-- + entityId instead of hosted pgvector's FK split) so the hosted and local
-- API response shapes stay identical byte-for-byte.
--
-- IF NOT EXISTS keeps this block safe to re-run against Phase 1 DBs that were
-- created before Phase 2 shipped — getDb() re-applies loadSchema() on every
-- open, so existing DBs get the new table added transparently.

CREATE TABLE IF NOT EXISTS embeddings (
  id          TEXT PRIMARY KEY,
  entityType  TEXT NOT NULL,       -- 'file' | 'symbol'
  entityId    TEXT NOT NULL,
  snapshotId  TEXT,                -- nullable: caller may embed outside a snapshot
  model       TEXT NOT NULL,
  dimension   INTEGER NOT NULL,
  vector      BLOB NOT NULL,       -- packed Float32Array (4 bytes × dimension)
  sourceText  TEXT NOT NULL,
  createdAt   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (snapshotId) REFERENCES code_snapshots(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_embeddings_snapshot ON embeddings(snapshotId);
CREATE INDEX IF NOT EXISTS idx_embeddings_model    ON embeddings(snapshotId, model);
CREATE INDEX IF NOT EXISTS idx_embeddings_entity   ON embeddings(entityType, entityId);
