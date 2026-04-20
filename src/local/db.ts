/**
 * Local-mode SQLite connection manager.
 *
 * One SQLite database per repoId, cached per-process. The stdio MCP server is
 * single-threaded, so better-sqlite3's synchronous API is appropriate here and
 * keeps the code straightforward (no async transactions to juggle).
 *
 * DB files live under $TENTRA_HOME or ~/.tentra/graphs/{repoId}/db.sqlite so
 * multiple local repos stay isolated from each other.
 */

import Database from 'better-sqlite3'
import { readFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Cache one Database instance per repoId. Cleared by tests via `_resetDbCache`.
const cache = new Map<string, Database.Database>()

export function tentraHome(): string {
  return process.env.TENTRA_HOME || join(homedir(), '.tentra')
}

export function repoDbPath(repoId: string): string {
  // Keep the filesystem path safe: substitute any character that isn't allowed
  // in a typical unix filename. CUIDs are safe but agents may pass slashes like
  // "owner/repo" — we preserve semantics by replacing with '__'.
  const safe = repoId.replace(/[^A-Za-z0-9._-]/g, '__')
  return join(tentraHome(), 'graphs', safe, 'db.sqlite')
}

// Read schema.sql once per process; it's ~100 lines so reading on demand is fine.
let schemaSqlCache: string | null = null
function loadSchema(): string {
  if (schemaSqlCache) return schemaSqlCache
  // Resolve schema.sql from whichever layout is on disk:
  //   1. Dev / tsx:  src/local/db.ts → schema.sql alongside (__dirname/schema.sql)
  //   2. Bundle:     dist/index.js → scripts/bundle.mjs copies it to dist/local/schema.sql
  // We try both so the same binary works in both scenarios.
  const candidates = [
    join(__dirname, 'schema.sql'),
    join(__dirname, 'local', 'schema.sql')
  ]
  for (const p of candidates) {
    try {
      schemaSqlCache = readFileSync(p, 'utf8')
      return schemaSqlCache
    } catch { /* keep trying */ }
  }
  throw new Error(`[tentra-local] schema.sql not found (looked in: ${candidates.join(', ')})`)
}

export function getDb(repoId: string): Database.Database {
  const cached = cache.get(repoId)
  if (cached) return cached

  const dbPath = repoDbPath(repoId)
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // Apply schema (idempotent — all tables use IF NOT EXISTS).
  db.exec(loadSchema())
  // Ensure a repo row exists so downstream FKs stay satisfied.
  db.prepare(
    `INSERT OR IGNORE INTO code_repos (id, workspaceId, rootPath) VALUES (?, 'local', '')`
  ).run(repoId)
  cache.set(repoId, db)
  return db
}

/**
 * Test helper — closes + forgets every cached DB. Not exported from the public
 * entrypoint; intended only for the local-backend Vitest tests.
 */
export function _resetDbCache(): void {
  for (const db of cache.values()) db.close()
  cache.clear()
  schemaSqlCache = null
}
