/**
 * Local-mode request dispatch.
 *
 * Mirrors the HTTP surface of the hosted API for the tier-1 MCP tools so
 * packages/mcp-server/src/tools/code-index/api-client.ts can call us in place
 * of `fetch(API_URL + path)` when TENTRA_BACKEND === 'local'.
 *
 * Scope (Phase 1 / tier-1):
 *   - code graph write path: snapshots, files, symbols, edges, jobs, semantics
 *   - code graph read path: symbols (substring only), references, neighbors,
 *     god-nodes, quality-hotspots (proxy), explain, diff, safe-rename, path,
 *     service
 *   - semantic nodes insert
 *
 * Deferred (return a structured "requires hosted" error for now):
 *   - embeddings (record + search)
 *   - architecture tools — handled by index.ts's apiRequest() chokepoint,
 *     which maps those endpoints to cloudRequired() responses.
 */

import { getDb } from './db.js'
import { newId } from './ids.js'
import {
  computeFanCounts,
  bfsNeighbors,
  shortestPath,
  looksLikeLocalVar,
  GraphEdge
} from './graph-utils.js'
import type BetterSqlite3 from 'better-sqlite3'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HandlerCtx {
  db: BetterSqlite3.Database
  repoId: string
  params: Record<string, string>
  query: Record<string, string>
  body: Record<string, unknown> | undefined
}

type Handler = (ctx: HandlerCtx) => Promise<unknown>

// ─── Path matching ────────────────────────────────────────────────────────────

interface Route {
  method: string
  pattern: RegExp
  paramNames: string[]
  handler: Handler
  // Resolves the repoId for a request so the dispatcher can pick the right
  // SQLite DB file. The function may read from the URL params, the request
  // body, or the query string — or defer to the side-index keyed by a CUID
  // (snapshotId / fileId / symbolId / jobId) set by whichever write-path call
  // originally produced that entity.
  resolveRepoFromPath?: (
    params: Record<string, string>,
    body: Record<string, unknown> | undefined,
    query: Record<string, string>
  ) => string | null | Promise<string | null>
}

function compile(pattern: string): { regex: RegExp; params: string[] } {
  const params: string[] = []
  const re = pattern.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    params.push(name)
    return '([^/?]+)'
  })
  return { regex: new RegExp(`^${re}$`), params }
}

// ─── Cross-repo resolution ────────────────────────────────────────────────────
//
// Most endpoints carry an ID that's owned by some repo row. Rather than scan
// every DB file looking for a snapshot/job/symbol/file, we keep a tiny
// side-index in $TENTRA_HOME/graphs/_index.json mapping id → repoId. Every
// write-path handler writes here; read-path handlers look up.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tentraHome } from './db.js'

let sideIndexCache: Record<string, string> | null = null

function sideIndexPath(): string {
  return join(tentraHome(), 'graphs', '_index.json')
}

function loadSideIndex(): Record<string, string> {
  if (sideIndexCache) return sideIndexCache
  const p = sideIndexPath()
  if (!existsSync(p)) { sideIndexCache = {}; return sideIndexCache }
  try {
    sideIndexCache = JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>
  } catch {
    sideIndexCache = {}
  }
  return sideIndexCache
}

function saveSideIndex(): void {
  if (!sideIndexCache) return
  const p = sideIndexPath()
  mkdirSync(join(tentraHome(), 'graphs'), { recursive: true })
  writeFileSync(p, JSON.stringify(sideIndexCache))
}

function registerEntity(id: string, repoId: string): void {
  const idx = loadSideIndex()
  idx[id] = repoId
  saveSideIndex()
}

function lookupRepoForEntity(id: string): string | null {
  const idx = loadSideIndex()
  return idx[id] ?? null
}

// ─── Handlers — write path ────────────────────────────────────────────────────

const postSnapshot: Handler = async ({ db, repoId, body }) => {
  const b = (body ?? {}) as { repoId?: string; commitSha?: string; parentSnapshotId?: string }
  const actualRepoId = b.repoId ?? repoId
  // Ensure the repo row exists before inserting the snapshot.
  db.prepare(
    `INSERT OR IGNORE INTO code_repos (id, workspaceId, rootPath) VALUES (?, 'local', '')`
  ).run(actualRepoId)
  const id = newId()
  db.prepare(
    `INSERT INTO code_snapshots (id, repoId, commitSha, parentSnapshotId) VALUES (?, ?, ?, ?)`
  ).run(id, actualRepoId, b.commitSha ?? null, b.parentSnapshotId ?? null)
  registerEntity(id, actualRepoId)
  return {
    id,
    repoId: actualRepoId,
    commitSha: b.commitSha ?? null,
    parentSnapshotId: b.parentSnapshotId ?? null,
    stats: {},
    createdAt: new Date().toISOString()
  }
}

function looksLikeTest(relativePath: string): boolean {
  return /(^|\/)(tests?|__tests__|fixtures|e2e)\//i.test(relativePath)
      || /\.(test|spec)\.[a-z]+$/i.test(relativePath)
      || /(^|\/)test-[^/]+$/i.test(relativePath)
}

const postFiles: Handler = async ({ db, repoId, params, body }) => {
  const snapshotId = params.snapshotId
  const b = body as { files: Array<{ relativePath: string; language: string; loc: number; contentHash: string; serviceId?: string; isTest?: boolean }> }
  const files = b.files ?? []
  const now = new Date().toISOString()

  const upsert = db.prepare(`
    INSERT INTO code_files (id, snapshotId, serviceId, relativePath, language, loc, contentHash, isTest, tier1IndexedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshotId, relativePath) DO UPDATE SET
      language = excluded.language,
      loc = excluded.loc,
      contentHash = excluded.contentHash,
      serviceId = excluded.serviceId,
      isTest = excluded.isTest,
      tier1IndexedAt = excluded.tier1IndexedAt
    RETURNING id, relativePath
  `)

  const rows: Array<{ id: string; relativePath: string }> = []
  const tx = db.transaction((items: typeof files) => {
    for (const f of items) {
      const isTest = f.isTest ?? looksLikeTest(f.relativePath)
      const id = newId()
      const row = upsert.get(
        id, snapshotId, f.serviceId ?? null, f.relativePath, f.language,
        f.loc, f.contentHash, isTest ? 1 : 0, now
      ) as { id: string; relativePath: string }
      rows.push(row)
      registerEntity(row.id, repoId)
    }
  })
  tx(files)

  return { count: rows.length, files: rows }
}

const postSymbols: Handler = async ({ db, repoId, params, body }) => {
  const snapshotId = params.snapshotId
  const b = body as { symbols: Array<{ fileId: string; kind: string; name: string; qualifiedName: string; startLine: number; endLine: number }> }
  const symbols = b.symbols ?? []

  const upsert = db.prepare(`
    INSERT INTO code_symbols (id, snapshotId, fileId, kind, name, qualifiedName, startLine, endLine)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshotId, qualifiedName) DO UPDATE SET
      fileId = excluded.fileId,
      kind = excluded.kind,
      name = excluded.name,
      startLine = excluded.startLine,
      endLine = excluded.endLine
    RETURNING id, qualifiedName
  `)

  const rows: Array<{ id: string; qualifiedName: string }> = []
  const tx = db.transaction((items: typeof symbols) => {
    for (const s of items) {
      const id = newId()
      const row = upsert.get(
        id, snapshotId, s.fileId, s.kind, s.name, s.qualifiedName,
        s.startLine, s.endLine
      ) as { id: string; qualifiedName: string }
      rows.push(row)
      registerEntity(row.id, repoId)
    }
  })
  tx(symbols)

  return { count: rows.length, symbols: rows }
}

const postEdges: Handler = async ({ db, params, body }) => {
  const snapshotId = params.snapshotId
  const b = body as { edges: Array<{ fromSymbolId: string | null; toSymbolId?: string | null; toExternal?: string | null; edgeType: string }> }
  const edges = b.edges ?? []

  const insert = db.prepare(`
    INSERT INTO code_edges (id, snapshotId, fromSymbolId, toSymbolId, toExternal, edgeType)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  db.transaction(() => {
    for (const e of edges) {
      insert.run(newId(), snapshotId, e.fromSymbolId, e.toSymbolId ?? null, e.toExternal ?? null, e.edgeType)
    }
  })()

  // Recompute fan counts for all symbols in this snapshot.
  const symbolRows = db.prepare(`SELECT id FROM code_symbols WHERE snapshotId = ?`).all(snapshotId) as Array<{ id: string }>
  const edgeRows = db.prepare(`SELECT fromSymbolId, toSymbolId FROM code_edges WHERE snapshotId = ?`).all(snapshotId) as Array<{ fromSymbolId: string | null; toSymbolId: string | null }>
  const counts = computeFanCounts(symbolRows, edgeRows)
  const upd = db.prepare(`UPDATE code_symbols SET fanIn = ?, fanOut = ? WHERE id = ?`)
  db.transaction(() => {
    for (const [id, c] of counts) upd.run(c.fanIn, c.fanOut, id)
  })()

  return { count: edges.length }
}

const postJob: Handler = async ({ db, repoId, body }) => {
  const b = body as { repoId?: string; snapshotId?: string; tier: string; totalFiles: number }
  const actualRepoId = b.repoId ?? repoId
  const id = newId()
  db.prepare(
    `INSERT INTO code_index_jobs (id, repoId, snapshotId, tier, status, totalFiles)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  ).run(id, actualRepoId, b.snapshotId ?? null, b.tier, b.totalFiles)
  registerEntity(id, actualRepoId)
  return {
    id,
    repoId: actualRepoId,
    snapshotId: b.snapshotId ?? null,
    tier: b.tier,
    status: 'pending',
    totalFiles: b.totalFiles,
    processedFiles: 0,
    lastBatchCursor: 0,
    resumptionState: {},
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null
  }
}

const patchJob: Handler = async ({ db, params, body }) => {
  const b = body as { processedFiles?: number; lastBatchCursor?: number; resumptionState?: Record<string, unknown> }
  const sets: string[] = [`status = 'in_progress'`]
  const vals: unknown[] = []
  if (b.processedFiles !== undefined) { sets.push(`processedFiles = ?`); vals.push(b.processedFiles) }
  if (b.lastBatchCursor !== undefined) { sets.push(`lastBatchCursor = ?`); vals.push(b.lastBatchCursor) }
  if (b.resumptionState !== undefined) { sets.push(`resumptionState = ?`); vals.push(JSON.stringify(b.resumptionState)) }
  vals.push(params.id)
  const info = db.prepare(`UPDATE code_index_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  if (info.changes === 0) throw new Error('job_not_found')
  return getJobRow(db, params.id)
}

const postJobComplete: Handler = async ({ db, params }) => {
  const info = db.prepare(
    `UPDATE code_index_jobs SET status = 'completed', completedAt = ? WHERE id = ?`
  ).run(new Date().toISOString(), params.id)
  if (info.changes === 0) throw new Error('job_not_found')
  return getJobRow(db, params.id)
}

const getJob: Handler = async ({ db, params }) => {
  const row = getJobRow(db, params.id)
  if (!row) throw new Error('job_not_found')
  return row
}

function getJobRow(db: BetterSqlite3.Database, id: string) {
  const row = db.prepare(`SELECT * FROM code_index_jobs WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    ...row,
    resumptionState: JSON.parse((row.resumptionState as string) || '{}')
  }
}

const postSemanticNode: Handler = async ({ db, params, body }) => {
  // This endpoint is served in two forms: /code-graph/semantics (the one the
  // hosted MCP record_semantic_node tool POSTs to) and per-snapshot scoped
  // variants. We accept either and always insert a CodeSemantic row.
  const b = body as {
    fileId?: string
    symbolId?: string
    snapshotId: string
    purpose: string
    domainTags?: string[]
    confidence: number
    extractedBy: string
    lensMetadata?: Record<string, unknown>
  }
  if (!b.fileId && !b.symbolId) throw new Error('fileId or symbolId required')
  const id = newId()
  db.prepare(`
    INSERT INTO code_semantics (id, fileId, symbolId, snapshotId, purpose, domainTags, confidence, extractedBy, lensMetadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, b.fileId ?? null, b.symbolId ?? null, b.snapshotId,
    b.purpose, JSON.stringify(b.domainTags ?? []), b.confidence, b.extractedBy,
    JSON.stringify(b.lensMetadata ?? {})
  )
  // Mark file tier2-indexed (parallels the hosted API behavior).
  if (b.fileId) {
    db.prepare(`UPDATE code_files SET tier2IndexedAt = ? WHERE id = ?`).run(new Date().toISOString(), b.fileId)
  }
  return {
    id,
    fileId: b.fileId ?? null,
    symbolId: b.symbolId ?? null,
    snapshotId: b.snapshotId,
    purpose: b.purpose,
    domainTags: b.domainTags ?? [],
    confidence: b.confidence,
    extractedBy: b.extractedBy,
    lensMetadata: b.lensMetadata ?? {},
    extractedAt: new Date().toISOString()
  }
}

// ─── Handlers — read path ─────────────────────────────────────────────────────

const getSnapshotsByRepo: Handler = async ({ db, params }) => {
  const rows = db.prepare(
    `SELECT id, commitSha, createdAt, stats, parentSnapshotId
     FROM code_snapshots WHERE repoId = ? ORDER BY createdAt DESC`
  ).all(params.repoId) as Array<{ id: string; commitSha: string | null; createdAt: string; stats: string; parentSnapshotId: string | null }>
  return {
    repoId: params.repoId,
    snapshots: rows.map(r => ({
      ...r,
      stats: JSON.parse(r.stats || '{}')
    }))
  }
}

const querySymbols: Handler = async ({ db, query }) => {
  const snapshotId = query.snapshot_id
  const q = query.q ?? ''
  const kind = query.kind
  const role = query.role
  // Local mode: trigram isn't available — always use substring. Docs flag this.
  const excludeTests = query.exclude_tests !== 'false'
  const limit = Math.min(parseInt(query.limit ?? '50', 10) || 50, 100)

  const where: string[] = [`cs.snapshotId = ?`, `cs.qualifiedName LIKE ?`]
  const params: unknown[] = [snapshotId, `%${q}%`]
  if (excludeTests) where.push(`(cf.isTest = 0 OR cf.isTest IS NULL)`)
  if (kind) { where.push(`cs.kind = ?`); params.push(kind) }
  // role: local-mode has no semantic_roles table — ignore silently (Phase 1).
  if (role) { /* no-op */ }

  const rows = db.prepare(`
    SELECT cs.id, cs.kind, cs.name, cs.qualifiedName AS qualifiedName,
           cs.startLine, cs.endLine, cs.fanIn, cs.fanOut, cs.isGodNode,
           cf.relativePath AS filePath, cf.isTest
    FROM code_symbols cs
    LEFT JOIN code_files cf ON cf.id = cs.fileId
    WHERE ${where.join(' AND ')}
    ORDER BY (cs.fanIn + cs.fanOut) DESC, cs.qualifiedName ASC
    LIMIT ?
  `).all(...params, limit) as Array<{
    id: string; kind: string; name: string; qualifiedName: string
    startLine: number; endLine: number; fanIn: number; fanOut: number
    isGodNode: number; filePath: string | null; isTest: number | null
  }>

  return {
    excludeTests,
    symbols: rows.map(r => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      qualifiedName: r.qualifiedName,
      startLine: r.startLine,
      endLine: r.endLine,
      fanIn: r.fanIn,
      fanOut: r.fanOut,
      isGodNode: !!r.isGodNode,
      semanticRole: null,
      filePath: r.filePath,
      isTest: !!r.isTest
    }))
  }
}

const findReferences: Handler = async ({ db, params, query }) => {
  const symbolId = params.symbolId
  const snapshotId = query.snapshot_id
  const includeUnresolved = query.include_unresolved === 'true'
  const includeTests = query.include_tests !== 'false'
  const limit = Math.min(parseInt(query.limit ?? '200', 10) || 200, 500)

  const target = db.prepare(
    `SELECT id, name, qualifiedName, snapshotId FROM code_symbols WHERE id = ?`
  ).get(symbolId) as { id: string; name: string; qualifiedName: string; snapshotId: string } | undefined
  if (!target) throw new HttpError(404, 'symbol not found')
  if (target.snapshotId !== snapshotId) throw new HttpError(400, 'symbol does not belong to this snapshot')

  // Resolved: edges where toSymbolId = target and fromSymbol is non-null.
  const resolvedRows = db.prepare(`
    SELECT ce.edgeType AS edgeType, ce.fromSymbolId AS fromSymbolId,
           fs.id AS fsId, fs.kind AS fsKind, fs.name AS fsName,
           fs.qualifiedName AS fsQn, fs.startLine AS fsStart, fs.endLine AS fsEnd,
           ff.relativePath AS filePath, ff.isTest AS isTest
    FROM code_edges ce
    JOIN code_symbols fs ON fs.id = ce.fromSymbolId
    LEFT JOIN code_files ff ON ff.id = fs.fileId
    WHERE ce.snapshotId = ? AND ce.toSymbolId = ?
    LIMIT ?
  `).all(snapshotId, symbolId, limit) as Array<{
    edgeType: string; fromSymbolId: string
    fsId: string; fsKind: string; fsName: string; fsQn: string
    fsStart: number; fsEnd: number; filePath: string | null; isTest: number | null
  }>

  const resolvedGroups = new Map<string, {
    kind: 'resolved'
    edgeType: string
    fromSymbolId: string | null
    fromQualifiedName: string
    fromKind: string
    filePath: string | null
    isTest: boolean
    startLine: number
    endLine: number
    callCount: number
  }>()
  for (const r of resolvedRows) {
    if (!includeTests && r.isTest) continue
    const key = `${r.fromSymbolId}|${r.edgeType}`
    const existing = resolvedGroups.get(key)
    if (existing) existing.callCount += 1
    else resolvedGroups.set(key, {
      kind: 'resolved',
      edgeType: r.edgeType,
      fromSymbolId: r.fromSymbolId,
      fromQualifiedName: r.fsQn,
      fromKind: r.fsKind,
      filePath: r.filePath,
      isTest: !!r.isTest,
      startLine: r.fsStart,
      endLine: r.fsEnd,
      callCount: 1
    })
  }
  const resolved = [...resolvedGroups.values()].sort((a, b) => b.callCount - a.callCount)

  // File-scope edges (fromSymbolId = null, toSymbolId = target).
  const fileScopeCount = (db.prepare(
    `SELECT COUNT(*) AS c FROM code_edges WHERE snapshotId = ? AND toSymbolId = ? AND fromSymbolId IS NULL`
  ).get(snapshotId, symbolId) as { c: number }).c

  let unresolved: Array<{
    kind: 'unresolved'; edgeType: string; fromQualifiedName: string
    fromKind: string; filePath: string | null; isTest: boolean
    startLine: number; endLine: number
  }> = []
  if (includeUnresolved) {
    const rows = db.prepare(`
      SELECT ce.edgeType AS edgeType,
             fs.kind AS fsKind, fs.qualifiedName AS fsQn,
             fs.startLine AS fsStart, fs.endLine AS fsEnd,
             ff.relativePath AS filePath, ff.isTest AS isTest
      FROM code_edges ce
      JOIN code_symbols fs ON fs.id = ce.fromSymbolId
      LEFT JOIN code_files ff ON ff.id = fs.fileId
      WHERE ce.snapshotId = ? AND ce.toSymbolId IS NULL AND ce.toExternal = ?
      LIMIT ?
    `).all(snapshotId, target.name, limit) as Array<{
      edgeType: string; fsKind: string; fsQn: string
      fsStart: number; fsEnd: number; filePath: string | null; isTest: number | null
    }>
    unresolved = rows
      .filter(r => includeTests || !r.isTest)
      .map(r => ({
        kind: 'unresolved' as const,
        edgeType: r.edgeType,
        fromQualifiedName: r.fsQn,
        fromKind: r.fsKind,
        filePath: r.filePath,
        isTest: !!r.isTest,
        startLine: r.fsStart,
        endLine: r.fsEnd
      }))
  }

  return {
    target: { id: target.id, name: target.name, qualifiedName: target.qualifiedName },
    resolvedCount: resolved.length,
    unresolvedCount: unresolved.length,
    fileScopeCount,
    references: [...resolved, ...unresolved]
  }
}

const getNeighbors: Handler = async ({ db, params, query }) => {
  const symbolId = params.symbolId
  const snapshotId = query.snapshot_id
  const depth = Math.min(parseInt(query.depth ?? '2', 10) || 2, 5)
  const direction = (query.direction === 'both' ? 'both' : 'outgoing') as 'outgoing' | 'both'
  const edgeTypes = query.edge_types ? query.edge_types.split(',').map(s => s.trim()) : undefined

  const sym = db.prepare(`SELECT id FROM code_symbols WHERE id = ?`).get(symbolId)
  if (!sym) throw new HttpError(404, 'symbol not found')

  const rawEdges = db.prepare(
    `SELECT id, fromSymbolId, toSymbolId, toExternal, edgeType FROM code_edges WHERE snapshotId = ?`
  ).all(snapshotId) as Array<{ id: string; fromSymbolId: string | null; toSymbolId: string | null; toExternal: string | null; edgeType: string }>

  const graphEdges: GraphEdge[] = rawEdges.map(e => ({
    fromSymbolId: e.fromSymbolId, toSymbolId: e.toSymbolId, edgeType: e.edgeType
  }))
  const { visited, edges: traversedEdges } = bfsNeighbors(symbolId, graphEdges, { depth, edgeTypes, direction })

  const neighborIds = [...visited].filter(id => id !== symbolId)
  const neighbors = neighborIds.length > 0
    ? (db.prepare(
        `SELECT cs.id, cs.kind, cs.name, cs.qualifiedName, cs.fanIn, cs.fanOut, cs.isGodNode, cf.relativePath AS filePath
         FROM code_symbols cs LEFT JOIN code_files cf ON cf.id = cs.fileId
         WHERE cs.id IN (${neighborIds.map(() => '?').join(',')})`
      ).all(...neighborIds) as Array<{ id: string; kind: string; name: string; qualifiedName: string; fanIn: number; fanOut: number; isGodNode: number; filePath: string | null }>)
    : []

  const externalCounts = new Map<string, { name: string; type: string; count: number }>()
  for (const e of rawEdges) {
    if (e.fromSymbolId !== symbolId || e.toSymbolId !== null) continue
    const name = e.toExternal ?? '<unknown>'
    if (looksLikeLocalVar(name)) continue
    const key = `${e.edgeType}:${name}`
    const existing = externalCounts.get(key)
    if (existing) existing.count += 1
    else externalCounts.set(key, { name, type: e.edgeType, count: 1 })
  }

  return {
    symbolId,
    depth,
    neighbors: neighbors.map(n => ({
      id: n.id, kind: n.kind, name: n.name, qualifiedName: n.qualifiedName,
      filePath: n.filePath, fanIn: n.fanIn, fanOut: n.fanOut, isGodNode: !!n.isGodNode
    })),
    edges: traversedEdges
      .filter(e => e.toSymbolId !== null)
      .map(e => ({ from: e.fromSymbolId, to: e.toSymbolId, type: e.edgeType })),
    externalEdges: [...externalCounts.values()].sort((a, b) => b.count - a.count).slice(0, 50)
  }
}

const listGodNodes: Handler = async ({ db, query }) => {
  const snapshotId = query.snapshot_id ?? resolveLatestSnapshot(db, query.repo_id ?? '')
  if (!snapshotId) throw new HttpError(400, 'repo_id or snapshot_id required')
  const excludeTests = query.exclude_tests !== 'false'
  const topN = Math.min(parseInt(query.top_n ?? '20', 10) || 20, 50)

  const whereExtra = excludeTests ? `AND (cf.isTest = 0 OR cf.isTest IS NULL)` : ''
  const rows = db.prepare(`
    SELECT cs.id, cs.name, cs.qualifiedName, cs.fanIn, cs.fanOut,
           cf.relativePath AS filePath, cf.isTest
    FROM code_symbols cs
    LEFT JOIN code_files cf ON cf.id = cs.fileId
    WHERE cs.snapshotId = ? ${whereExtra}
    ORDER BY cs.fanIn DESC, cs.fanOut DESC
    LIMIT ?
  `).all(snapshotId, topN) as Array<{ id: string; name: string; qualifiedName: string; fanIn: number; fanOut: number; filePath: string | null; isTest: number | null }>

  return {
    snapshotId,
    excludeTests,
    godNodes: rows.map(s => ({
      id: s.id, name: s.name, qualifiedName: s.qualifiedName,
      filePath: s.filePath, isTest: !!s.isTest,
      fanIn: s.fanIn, fanOut: s.fanOut
    }))
  }
}

const getHotspots: Handler = async ({ db, query }) => {
  // Local mode: no QualityMetric seeding. Always run the proxy path.
  const snapshotId = query.snapshot_id ?? resolveLatestSnapshot(db, query.repo_id ?? '')
  if (!snapshotId) throw new HttpError(400, 'repo_id or snapshot_id required')
  const excludeTests = query.exclude_tests !== 'false'
  const topN = Math.min(parseInt(query.top_n ?? '20', 10) || 20, 50)

  const whereTest = excludeTests ? `AND cf.isTest = 0` : ''
  const rows = db.prepare(`
    SELECT cf.id AS fileId, cf.relativePath AS filePath, cf.language, cf.loc,
           COUNT(cs.id) AS symbolCount,
           COALESCE(SUM(cs.fanIn), 0) AS fanInSum,
           COALESCE(SUM(cs.fanOut), 0) AS fanOutSum
    FROM code_files cf
    LEFT JOIN code_symbols cs ON cs.fileId = cf.id
    WHERE cf.snapshotId = ? ${whereTest}
    GROUP BY cf.id, cf.relativePath, cf.language, cf.loc
    HAVING COUNT(cs.id) > 0
    ORDER BY (cf.loc + COUNT(cs.id) * 5 + COALESCE(SUM(cs.fanIn), 0)) DESC
    LIMIT ?
  `).all(snapshotId, topN) as Array<{ fileId: string; filePath: string; language: string; loc: number; symbolCount: number; fanInSum: number; fanOutSum: number }>

  return {
    snapshotId,
    dataSource: 'proxy',
    dataSourceNote: 'Local mode: proxy ranking (LOC + symbols × 5 + fan-in sum). QualityMetric not available locally.',
    hotspots: rows.map(r => ({
      fileId: r.fileId,
      filePath: r.filePath,
      language: r.language,
      loc: r.loc,
      symbolCount: Number(r.symbolCount),
      fanInSum: Number(r.fanInSum),
      fanOutSum: Number(r.fanOutSum),
      score: r.loc + Number(r.symbolCount) * 5 + Number(r.fanInSum)
    }))
  }
}

const diffSnapshots: Handler = async ({ db, query }) => {
  const fromId = query.from_id
  const toId = query.to_id
  if (!fromId || !toId) throw new HttpError(400, 'from_id and to_id required')

  const files = (snapshotId: string) => db.prepare(
    `SELECT relativePath, contentHash FROM code_files WHERE snapshotId = ?`
  ).all(snapshotId) as Array<{ relativePath: string; contentHash: string }>

  const syms = (snapshotId: string) => db.prepare(
    `SELECT qualifiedName, isGodNode FROM code_symbols WHERE snapshotId = ?`
  ).all(snapshotId) as Array<{ qualifiedName: string; isGodNode: number }>

  const fromFiles = files(fromId)
  const toFiles = files(toId)
  const fromSyms = syms(fromId)
  const toSyms = syms(toId)

  const fromPathMap = new Map(fromFiles.map(f => [f.relativePath, f.contentHash]))
  const toPathMap = new Map(toFiles.map(f => [f.relativePath, f.contentHash]))

  const addedFiles = toFiles.filter(f => !fromPathMap.has(f.relativePath)).map(f => f.relativePath)
  const removedFiles = fromFiles.filter(f => !toPathMap.has(f.relativePath)).map(f => f.relativePath)
  const modifiedFiles = toFiles
    .filter(f => fromPathMap.has(f.relativePath) && fromPathMap.get(f.relativePath) !== f.contentHash)
    .map(f => f.relativePath)

  const fromQ = new Set(fromSyms.map(s => s.qualifiedName))
  const toQ = new Set(toSyms.map(s => s.qualifiedName))
  const fromGod = new Set(fromSyms.filter(s => s.isGodNode).map(s => s.qualifiedName))
  const toGod = new Set(toSyms.filter(s => s.isGodNode).map(s => s.qualifiedName))

  return {
    fromSnapshotId: fromId,
    toSnapshotId: toId,
    files: { added: addedFiles, removed: removedFiles, modified: modifiedFiles },
    symbols: {
      added: [...toQ].filter(q => !fromQ.has(q)),
      removed: [...fromQ].filter(q => !toQ.has(q))
    },
    godNodes: {
      appeared: [...toGod].filter(q => !fromGod.has(q)),
      resolved: [...fromGod].filter(q => !toGod.has(q))
    }
  }
}

const safeRename: Handler = async ({ db, params, query }) => {
  const symbolId = params.symbolId
  const snapshotId = query.snapshot_id
  const newName = query.new_name
  const includeUnresolved = query.include_unresolved === 'true'
  const includeTests = query.include_tests !== 'false'
  const limit = Math.min(parseInt(query.limit ?? '200', 10) || 200, 500)

  if (!newName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
    throw new HttpError(400, 'new_name must be a valid identifier')
  }

  const target = db.prepare(`
    SELECT cs.id, cs.name, cs.qualifiedName, cs.snapshotId,
           cs.startLine, cs.endLine, cs.fanIn, cs.fanOut, cs.isGodNode,
           cf.relativePath AS filePath
    FROM code_symbols cs
    LEFT JOIN code_files cf ON cf.id = cs.fileId
    WHERE cs.id = ?
  `).get(symbolId) as {
    id: string; name: string; qualifiedName: string; snapshotId: string
    startLine: number; endLine: number; fanIn: number; fanOut: number; isGodNode: number
    filePath: string | null
  } | undefined
  if (!target) throw new HttpError(404, 'symbol not found')
  if (target.snapshotId !== snapshotId) throw new HttpError(400, 'symbol does not belong to this snapshot')
  if (target.name === newName) throw new HttpError(400, 'new_name is identical to current name — nothing to rename')

  // Reuse findReferences logic (copy-paste, smaller dep graph than currying).
  const resolvedRows = db.prepare(`
    SELECT ce.edgeType AS edgeType, ce.fromSymbolId AS fromSymbolId,
           fs.id AS fsId, fs.kind AS fsKind, fs.name AS fsName,
           fs.qualifiedName AS fsQn, fs.startLine AS fsStart, fs.endLine AS fsEnd,
           ff.relativePath AS filePath, ff.isTest AS isTest
    FROM code_edges ce
    JOIN code_symbols fs ON fs.id = ce.fromSymbolId
    LEFT JOIN code_files ff ON ff.id = fs.fileId
    WHERE ce.snapshotId = ? AND ce.toSymbolId = ?
    LIMIT ?
  `).all(snapshotId, symbolId, limit) as Array<{
    edgeType: string; fromSymbolId: string
    fsId: string; fsKind: string; fsName: string; fsQn: string
    fsStart: number; fsEnd: number; filePath: string | null; isTest: number | null
  }>

  const resolvedGroups = new Map<string, {
    kind: 'resolved'; edgeType: string; fromSymbolId: string | null
    fromQualifiedName: string; fromKind: string; filePath: string | null
    isTest: boolean; startLine: number; endLine: number; callCount: number
  }>()
  for (const r of resolvedRows) {
    if (!includeTests && r.isTest) continue
    const key = `${r.fromSymbolId}|${r.edgeType}`
    const existing = resolvedGroups.get(key)
    if (existing) existing.callCount += 1
    else resolvedGroups.set(key, {
      kind: 'resolved',
      edgeType: r.edgeType,
      fromSymbolId: r.fromSymbolId,
      fromQualifiedName: r.fsQn,
      fromKind: r.fsKind,
      filePath: r.filePath,
      isTest: !!r.isTest,
      startLine: r.fsStart,
      endLine: r.fsEnd,
      callCount: 1
    })
  }
  const resolved = [...resolvedGroups.values()].sort((a, b) => b.callCount - a.callCount)

  let unresolved: Array<{
    kind: 'unresolved'; edgeType: string; fromSymbolId: null
    fromQualifiedName: string; fromKind: string; filePath: string | null
    isTest: boolean; startLine: number; endLine: number; callCount: number
  }> = []
  if (includeUnresolved) {
    const rows = db.prepare(`
      SELECT ce.edgeType AS edgeType,
             fs.kind AS fsKind, fs.qualifiedName AS fsQn,
             fs.startLine AS fsStart, fs.endLine AS fsEnd,
             ff.relativePath AS filePath, ff.isTest AS isTest
      FROM code_edges ce
      JOIN code_symbols fs ON fs.id = ce.fromSymbolId
      LEFT JOIN code_files ff ON ff.id = fs.fileId
      WHERE ce.snapshotId = ? AND ce.toSymbolId IS NULL AND ce.toExternal = ?
      LIMIT ?
    `).all(snapshotId, target.name, limit) as Array<{
      edgeType: string; fsKind: string; fsQn: string
      fsStart: number; fsEnd: number; filePath: string | null; isTest: number | null
    }>
    unresolved = rows.filter(r => includeTests || !r.isTest).map(r => ({
      kind: 'unresolved' as const,
      edgeType: r.edgeType,
      fromSymbolId: null,
      fromQualifiedName: r.fsQn,
      fromKind: r.fsKind,
      filePath: r.filePath,
      isTest: !!r.isTest,
      startLine: r.fsStart,
      endLine: r.fsEnd,
      callCount: 1
    }))
  }

  const references = [...resolved, ...unresolved]
  const distinctCallers = new Set<string>()
  const fileSet = new Set<string>()
  let totalReferences = 0
  for (const r of references) {
    if (r.fromSymbolId) distinctCallers.add(r.fromSymbolId)
    if (r.filePath) fileSet.add(r.filePath)
    totalReferences += r.callCount
  }
  if (target.filePath) fileSet.add(target.filePath)

  const warnings: string[] = []
  const GOD_NODE_FANIN_THRESHOLD = 50
  if (target.fanIn > GOD_NODE_FANIN_THRESHOLD) {
    warnings.push(`Target has fanIn=${target.fanIn} (threshold ${GOD_NODE_FANIN_THRESHOLD}) — high blast radius, sanity-check the rename before applying.`)
  }
  if (target.isGodNode) {
    warnings.push('Target is flagged as a god-node in the code graph — consider whether renaming is the right fix, or if the symbol should be decomposed first.')
  }
  if (includeUnresolved && unresolved.length > 0) {
    warnings.push(`${unresolved.length} unresolved reference(s) included — these are best-effort short-name matches that may not all be the target. Review each before applying.`)
  }
  if (!target.filePath) {
    warnings.push('Definition site has no associated file — cannot locate the declaration for renaming.')
  }

  return {
    target: {
      id: target.id,
      qualifiedName: target.qualifiedName,
      oldName: target.name,
      newName,
      fanIn: target.fanIn,
      fanOut: target.fanOut,
      isGodNode: !!target.isGodNode
    },
    definition: target.filePath ? {
      filePath: target.filePath,
      startLine: target.startLine,
      endLine: target.endLine
    } : null,
    references,
    summary: {
      totalReferences,
      distinctCallers: distinctCallers.size,
      fileCount: fileSet.size,
      warnings
    }
  }
}

const explainCodePath: Handler = async ({ db, query }) => {
  const snapshotId = query.snapshot_id
  const fromSymbol = query.from_symbol
  const toSymbol = query.to_symbol
  if (!snapshotId || !fromSymbol || !toSymbol) throw new HttpError(400, 'snapshot_id, from_symbol, to_symbol required')

  const rawEdges = db.prepare(
    `SELECT fromSymbolId, toSymbolId, edgeType FROM code_edges WHERE snapshotId = ?`
  ).all(snapshotId) as Array<{ fromSymbolId: string | null; toSymbolId: string | null; edgeType: string }>

  const result = shortestPath(fromSymbol, toSymbol, rawEdges)
  if (!result) throw new HttpError(404, 'no_path')

  const idsList = result.path
  const symbols = idsList.length > 0
    ? db.prepare(`
        SELECT cs.id, cs.name, cs.qualifiedName, cf.relativePath AS filePath,
               (SELECT purpose FROM code_semantics sem WHERE sem.symbolId = cs.id ORDER BY sem.extractedAt DESC LIMIT 1) AS purpose
        FROM code_symbols cs LEFT JOIN code_files cf ON cf.id = cs.fileId
        WHERE cs.id IN (${idsList.map(() => '?').join(',')})
      `).all(...idsList) as Array<{ id: string; name: string; qualifiedName: string; filePath: string | null; purpose: string | null }>
    : []

  const map = new Map(symbols.map(s => [s.id, s]))
  return {
    found: true,
    hopCount: result.path.length - 1,
    path: result.path.map(id => {
      const s = map.get(id)
      return s ? {
        id: s.id, name: s.name, qualifiedName: s.qualifiedName,
        filePath: s.filePath, purpose: s.purpose ?? null
      } : { id, name: null, qualifiedName: null, filePath: null, purpose: null }
    }),
    edges: result.edges.map(e => ({ from: e.fromSymbolId, to: e.toSymbolId, type: e.edgeType }))
  }
}

const getServiceGraph: Handler = async ({ db, params, query }) => {
  const serviceId = params.serviceId
  const snapshotId = query.snapshot_id
  const depth = Math.min(parseInt(query.depth ?? '2', 10) || 2, 5)
  const includeSemantics = query.include_semantics === 'true'

  const files = db.prepare(`
    SELECT id, relativePath, language, loc FROM code_files
    WHERE snapshotId = ? AND serviceId = ?
  `).all(snapshotId, serviceId) as Array<{ id: string; relativePath: string; language: string; loc: number }>

  const fileIds = files.map(f => f.id)
  const symbols = fileIds.length > 0
    ? db.prepare(`
        SELECT id, fileId, kind, name, qualifiedName, startLine, endLine,
               fanIn, fanOut, isGodNode, semanticRoleId
        FROM code_symbols WHERE fileId IN (${fileIds.map(() => '?').join(',')})
      `).all(...fileIds) as Array<{ id: string; fileId: string; kind: string; name: string; qualifiedName: string; startLine: number; endLine: number; fanIn: number; fanOut: number; isGodNode: number; semanticRoleId: string | null }>
    : []

  const symbolIds = symbols.map(s => s.id)
  const semMap = new Map<string, Array<{ purpose: string; domainTags: string[]; confidence: number }>>()
  if (includeSemantics && symbolIds.length > 0) {
    const rows = db.prepare(`
      SELECT symbolId, purpose, domainTags, confidence FROM code_semantics
      WHERE symbolId IN (${symbolIds.map(() => '?').join(',')})
    `).all(...symbolIds) as Array<{ symbolId: string; purpose: string; domainTags: string; confidence: number }>
    for (const r of rows) {
      const arr = semMap.get(r.symbolId) ?? []
      arr.push({ purpose: r.purpose, domainTags: JSON.parse(r.domainTags || '[]'), confidence: r.confidence })
      semMap.set(r.symbolId, arr)
    }
  }

  const symbolsByFile = new Map<string, typeof symbols>()
  for (const s of symbols) {
    const arr = symbolsByFile.get(s.fileId) ?? []
    arr.push(s)
    symbolsByFile.set(s.fileId, arr)
  }

  const edges = symbolIds.length > 0
    ? db.prepare(`
        SELECT fromSymbolId, toSymbolId, toExternal, edgeType FROM code_edges
        WHERE snapshotId = ? AND fromSymbolId IN (${symbolIds.map(() => '?').join(',')})
      `).all(snapshotId, ...symbolIds) as Array<{ fromSymbolId: string | null; toSymbolId: string | null; toExternal: string | null; edgeType: string }>
    : []

  return {
    serviceId,
    snapshotId,
    depth,
    files: files.map(f => ({
      ...f,
      symbols: (symbolsByFile.get(f.id) ?? []).map(s => ({
        id: s.id,
        kind: s.kind,
        name: s.name,
        qualifiedName: s.qualifiedName,
        startLine: s.startLine,
        endLine: s.endLine,
        fanIn: s.fanIn,
        fanOut: s.fanOut,
        isGodNode: !!s.isGodNode,
        semanticRoleId: s.semanticRoleId,
        ...(includeSemantics ? { semantics: semMap.get(s.id) ?? [] } : {})
      }))
    })),
    edges
  }
}

const explainCodebase: Handler = async ({ db, params, query }) => {
  const repoId = params.repoId
  const format = query.format === 'json' ? 'json' : 'markdown'
  const explicitSnapshotId = query.snapshot_id

  const repo = db.prepare(
    `SELECT id, workspaceId, rootPath, gitRemote FROM code_repos WHERE id = ?`
  ).get(repoId) as { id: string; workspaceId: string; rootPath: string; gitRemote: string | null } | undefined
  if (!repo) throw new HttpError(404, 'repo or snapshot not found')

  const snapshot = explicitSnapshotId
    ? db.prepare(
        `SELECT id, commitSha, createdAt FROM code_snapshots WHERE id = ? AND repoId = ?`
      ).get(explicitSnapshotId, repoId) as { id: string; commitSha: string | null; createdAt: string } | undefined
    : db.prepare(
        `SELECT id, commitSha, createdAt FROM code_snapshots WHERE repoId = ? ORDER BY createdAt DESC LIMIT 1`
      ).get(repoId) as { id: string; commitSha: string | null; createdAt: string } | undefined
  if (!snapshot) throw new HttpError(404, 'repo or snapshot not found')

  const files = db.prepare(
    `SELECT id, relativePath, language, loc, isTest FROM code_files WHERE snapshotId = ?`
  ).all(snapshot.id) as Array<{ id: string; relativePath: string; language: string; loc: number; isTest: number }>

  const HOTSPOT_LIMIT = 10
  const hotspotRows = db.prepare(`
    SELECT cs.id, cs.name, cs.qualifiedName, cs.fanIn, cs.fanOut, cs.isGodNode,
           cf.relativePath AS filePath
    FROM code_symbols cs
    LEFT JOIN code_files cf ON cf.id = cs.fileId
    WHERE cs.snapshotId = ? AND (cf.isTest = 0 OR cf.isTest IS NULL)
    ORDER BY cs.fanIn DESC, cs.fanOut DESC
    LIMIT ?
  `).all(snapshot.id, HOTSPOT_LIMIT * 3) as Array<{ id: string; name: string; qualifiedName: string; fanIn: number; fanOut: number; isGodNode: number; filePath: string | null }>

  const isBinOrCli = (p: string | null) => p ? /(^|\/)(bin|scripts?|cli|cmd)(\/|$)/.test(p) : false
  const hotspotsFiltered = hotspotRows
    .filter(s => !isBinOrCli(s.filePath))
    .slice(0, HOTSPOT_LIMIT)
    .map(s => ({
      id: s.id, qualifiedName: s.qualifiedName, filePath: s.filePath,
      fanIn: s.fanIn, fanOut: s.fanOut, isGodNode: !!s.isGodNode
    }))

  let totalLoc = 0
  const langMap = new Map<string, { fileCount: number; loc: number }>()
  const dirMap = new Map<string, number>()
  for (const f of files) {
    totalLoc += f.loc
    const lang = langMap.get(f.language) ?? { fileCount: 0, loc: 0 }
    lang.fileCount += 1; lang.loc += f.loc
    langMap.set(f.language, lang)
    const slashIdx = f.relativePath.indexOf('/')
    const seg = slashIdx === -1 ? '<root>' : f.relativePath.slice(0, slashIdx)
    dirMap.set(seg, (dirMap.get(seg) ?? 0) + 1)
  }
  const languages = [...langMap.entries()]
    .map(([language, v]) => ({ language, fileCount: v.fileCount, loc: v.loc }))
    .sort((a, b) => b.loc - a.loc).slice(0, 6)
  const topLevelDirs = [...dirMap.entries()]
    .map(([dir, fileCount]) => ({ dir, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount).slice(0, 8)

  const repoName = (() => {
    const clean = repo.rootPath.replace(/\/+$/, '')
    const idx = clean.lastIndexOf('/')
    const candidate = idx === -1 ? clean : clean.slice(idx + 1)
    return candidate || repo.id
  })()

  const data = {
    repoId: repo.id,
    repoName,
    snapshot: {
      id: snapshot.id,
      commitSha: snapshot.commitSha,
      createdAt: snapshot.createdAt
    },
    startHere: {
      topSymbol: hotspotsFiltered[0] ? {
        id: hotspotsFiltered[0].id,
        qualifiedName: hotspotsFiltered[0].qualifiedName,
        filePath: hotspotsFiltered[0].filePath,
        fanIn: hotspotsFiltered[0].fanIn,
        fanOut: hotspotsFiltered[0].fanOut
      } : null,
      topDecision: null,
      topDomain: null
    },
    structure: {
      fileCount: files.length,
      totalLoc,
      languages,
      topLevelDirs
    },
    hotspots: hotspotsFiltered,
    // Enrichment sections are always empty in local mode.
    domains: [],
    domainsTotal: 0,
    decisions: [],
    decisionsTotal: 0,
    contracts: [],
    contractsTotal: 0
  }

  if (format === 'json') return data
  return { __raw__: renderExplainMarkdown(data) }
}

// Minimal local-mode markdown renderer. Matches the hosted version's shape for
// sections we populate; enrichment sections show the same "run enrichment tool"
// hints as the hosted fallback.
function renderExplainMarkdown(data: {
  repoId: string; repoName: string
  snapshot: { id: string; commitSha: string | null; createdAt: string }
  startHere: { topSymbol: { id: string; qualifiedName: string; filePath: string | null; fanIn: number; fanOut: number } | null }
  structure: { fileCount: number; totalLoc: number; languages: Array<{ language: string; fileCount: number; loc: number }>; topLevelDirs: Array<{ dir: string; fileCount: number }> }
  hotspots: Array<{ qualifiedName: string; filePath: string | null; fanIn: number; fanOut: number; isGodNode: boolean }>
}): string {
  const lines: string[] = []
  lines.push(`# ${data.repoName}`)
  lines.push('')
  lines.push('## Start here')
  if (data.startHere.topSymbol) {
    const s = data.startHere.topSymbol
    const loc = s.filePath ? ` (\`${s.filePath}\`)` : ''
    lines.push(`- Most important symbol: **\`${s.qualifiedName}\`**${loc} — fanIn ${s.fanIn}, fanOut ${s.fanOut}`)
  } else {
    lines.push('- Most important symbol: _none indexed yet — run `index_code` to build the graph._')
  }
  lines.push('- Most recent decision: _no ADRs yet — ADRs require hosted mode (record_decision)._')
  lines.push('- Primary domain: _no domains configured — domain memberships require hosted mode._')
  lines.push('')
  lines.push('## Structure')
  lines.push(`- Files: ${data.structure.fileCount}`)
  lines.push(`- Total LOC: ${data.structure.totalLoc}`)
  if (data.structure.languages.length > 0) {
    lines.push('- Languages:')
    for (const l of data.structure.languages) {
      lines.push(`  - ${l.language}: ${l.fileCount} files, ${l.loc} LOC`)
    }
  }
  if (data.structure.topLevelDirs.length > 0) {
    lines.push('- Top-level directories:')
    for (const d of data.structure.topLevelDirs) {
      lines.push(`  - \`${d.dir}\`: ${d.fileCount} files`)
    }
  }
  lines.push('')
  lines.push('## Architectural hotspots')
  if (data.hotspots.length === 0) {
    lines.push('_No symbols indexed yet — run `index_code` first._')
  } else {
    for (const h of data.hotspots) {
      const loc = h.filePath ? ` — \`${h.filePath}\`` : ''
      const god = h.isGodNode ? ' [god-node]' : ''
      lines.push(`- \`${h.qualifiedName}\`${loc} (fanIn ${h.fanIn}, fanOut ${h.fanOut})${god}`)
    }
  }
  lines.push('')
  lines.push('## Snapshot info')
  lines.push(`- Snapshot ID: \`${data.snapshot.id}\``)
  lines.push(`- Commit SHA: ${data.snapshot.commitSha ? `\`${data.snapshot.commitSha}\`` : '_none_'}`)
  lines.push(`- Created: ${data.snapshot.createdAt}`)
  lines.push('')
  return lines.join('\n')
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveLatestSnapshot(db: BetterSqlite3.Database, repoId: string): string | null {
  if (!repoId) return null
  const row = db.prepare(
    `SELECT id FROM code_snapshots WHERE repoId = ? ORDER BY createdAt DESC LIMIT 1`
  ).get(repoId) as { id: string } | undefined
  return row?.id ?? null
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

// ─── Route table ──────────────────────────────────────────────────────────────

const ROUTES: Route[] = []

function register(method: string, pattern: string, handler: Handler, resolveRepoFromPath?: Route['resolveRepoFromPath']) {
  const { regex, params } = compile(pattern)
  ROUTES.push({ method, pattern: regex, paramNames: params, handler, resolveRepoFromPath })
}

// Write path
register('POST', '/code-graph/snapshots', postSnapshot, (_p, body) => (body?.repoId as string) ?? null)
register('POST', '/code-graph/snapshots/:snapshotId/files', postFiles, (p) => lookupRepoForEntity(p.snapshotId))
register('POST', '/code-graph/snapshots/:snapshotId/symbols', postSymbols, (p) => lookupRepoForEntity(p.snapshotId))
register('POST', '/code-graph/snapshots/:snapshotId/edges', postEdges, (p) => lookupRepoForEntity(p.snapshotId))
register('POST', '/code-graph/jobs', postJob, (_p, body) => (body?.repoId as string) ?? null)
register('PATCH', '/code-graph/jobs/:id', patchJob, (p) => lookupRepoForEntity(p.id))
register('POST', '/code-graph/jobs/:id/complete', postJobComplete, (p) => lookupRepoForEntity(p.id))
register('GET', '/code-graph/jobs/:id', getJob, (p) => lookupRepoForEntity(p.id))
register('POST', '/code-graph/semantics', postSemanticNode, (_p, body) => lookupRepoForEntity((body?.snapshotId as string) ?? ''))

// Read path
register('GET', '/code-graph/query/snapshots/:repoId', getSnapshotsByRepo, (p) => p.repoId)
register('GET', '/code-graph/query/symbols', querySymbols, (_p, _b, q) => lookupRepoForEntity(q?.snapshot_id ?? ''))
register('GET', '/code-graph/query/references/:symbolId', findReferences, (p) => lookupRepoForEntity(p.symbolId))
register('GET', '/code-graph/query/neighbors/:symbolId', getNeighbors, (p) => lookupRepoForEntity(p.symbolId))
register('GET', '/code-graph/query/god-nodes', listGodNodes, (_p, _b, q) => q?.repo_id || lookupRepoForEntity(q?.snapshot_id ?? ''))
register('GET', '/code-graph/query/quality-hotspots', getHotspots, (_p, _b, q) => q?.repo_id || lookupRepoForEntity(q?.snapshot_id ?? ''))
register('GET', '/code-graph/query/explain/:repoId', explainCodebase, (p) => p.repoId)
register('GET', '/code-graph/query/diff', diffSnapshots, (_p, _b, q) => lookupRepoForEntity(q?.from_id ?? ''))
register('GET', '/code-graph/query/safe-rename/:symbolId', safeRename, (p) => lookupRepoForEntity(p.symbolId))
register('GET', '/code-graph/query/path', explainCodePath, (_p, _b, q) => lookupRepoForEntity(q?.snapshot_id ?? ''))
register('GET', '/code-graph/query/service/:serviceId', getServiceGraph, (_p, _b, q) => lookupRepoForEntity(q?.snapshot_id ?? ''))

// Route.register signature above takes (p, body, q) but Route's typed contract
// says (params, body?) — keep it practical: TypeScript lets us ignore the third
// arg, but the write-path callers don't have query and the read-path ones don't
// have body. We thread query through via a wrapper below.

// ─── Dispatch entrypoint ─────────────────────────────────────────────────────

const CLOUD_REQUIRED_MESSAGE = 'Requires hosted mode. See trytentra.com/docs/local.'

/**
 * Endpoints that exist on the hosted API but are intentionally disabled in
 * local mode for Phase 1. Returning a structured error here (rather than 404)
 * keeps the MCP tool responses legible — the agent sees "embeddings need hosted"
 * instead of "500 path not found".
 *
 * Exact matches cover the short list of direct endpoints (embeddings). Prefix
 * matches (see CLOUD_ONLY_PREFIXES) handle enrichment routes that carry IDs
 * in the path (contracts/:id/bindings, decisions/:id/links, etc.).
 */
const CLOUD_ONLY = new Set<string>([
  'POST /code-graph/embeddings',
  'POST /code-graph/embeddings/search'
])

// Paths starting with any of these (method-scoped) resolve to the cloud-required
// response. Covers tier-2 enrichment tools that Phase 1 does NOT back with local
// SQLite: contracts, decisions, domain memberships, ownership, service-mapping.
const CLOUD_ONLY_PREFIXES: Array<{ method: string; prefix: string; scope: string }> = [
  { method: 'POST', prefix: '/code-graph/contracts', scope: 'contracts' },
  { method: 'GET',  prefix: '/code-graph/contracts', scope: 'contracts' },
  { method: 'POST', prefix: '/code-graph/decisions', scope: 'decisions' },
  { method: 'GET',  prefix: '/code-graph/decisions', scope: 'decisions' },
  { method: 'POST', prefix: '/code-graph/domains',   scope: 'domains' },
  { method: 'GET',  prefix: '/code-graph/domains',   scope: 'domains' },
  { method: 'GET',  prefix: '/code-graph/ownership', scope: 'ownership' }
]

// Per-request: check whether this (method, path) should short-circuit to
// cloud-required instead of hitting the local route table. Returns the scope
// tag used in the structured error payload, or null if the request is local-ok.
function matchCloudOnly(method: string, rawPath: string): string | null {
  const key = `${method.toUpperCase()} ${rawPath}`
  if (CLOUD_ONLY.has(key)) return 'embeddings'
  for (const { method: m, prefix, scope } of CLOUD_ONLY_PREFIXES) {
    if (m === method.toUpperCase() && rawPath.startsWith(prefix)) return scope
  }
  // Service-mapping sub-route: /code-graph/snapshots/:id/files/map-service.
  // Files endpoint (without /map-service) IS local-backed, so match the suffix.
  if (method.toUpperCase() === 'POST' && /\/files\/map-service$/.test(rawPath)) {
    return 'service-mapping'
  }
  return null
}

export async function localDispatch<T = unknown>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  // Strip query string for routing; parse it for handlers.
  const [rawPath, rawQuery] = path.split('?', 2)
  const query: Record<string, string> = {}
  if (rawQuery) {
    for (const [k, v] of new URLSearchParams(rawQuery).entries()) query[k] = v
  }

  // Short-circuit cloud-only endpoints before opening a DB — keeps tier-2
  // error paths fast and predictable.
  const cloudScope = matchCloudOnly(method, rawPath)
  if (cloudScope) {
    return cloudRequiredResponse(cloudScope) as T
  }

  for (const route of ROUTES) {
    if (route.method !== method.toUpperCase()) continue
    const m = route.pattern.exec(rawPath)
    if (!m) continue
    const params: Record<string, string> = {}
    for (let i = 0; i < route.paramNames.length; i++) params[route.paramNames[i]] = decodeURIComponent(m[i + 1])

    // Resolve repoId from the request so we can get the right SQLite DB.
    // Missing → fall back to a shared "default" DB. Shouldn't happen once
    // writes have primed the side-index.
    const bodyObj = (body ?? undefined) as Record<string, unknown> | undefined
    let repoId: string | null = null
    if (route.resolveRepoFromPath) {
      repoId = await Promise.resolve(route.resolveRepoFromPath(params, bodyObj, query))
    }
    const effectiveRepoId = repoId ?? 'default'
    const db = getDb(effectiveRepoId)

    try {
      return (await route.handler({ db, repoId: effectiveRepoId, params, query, body: bodyObj })) as T
    } catch (err) {
      if (err instanceof HttpError) {
        // Hosted API returns JSON errors; match the shape so api-client's
        // `throw new Error(`${path} → status ...`)` path stays consistent.
        const wrapped = new Error(`${method} ${rawPath} → ${err.status} ${err.message}`)
        throw wrapped
      }
      throw err
    }
  }

  throw new Error(`${method} ${rawPath} → 404 route not found (local mode)`)
}

/**
 * Structured cloud-required response used by:
 *   - The embeddings endpoints in this dispatcher.
 *   - The architecture tool branch in packages/mcp-server/src/index.ts
 *     (via the exported cloudRequired helper below).
 */
export function cloudRequiredResponse(scope = 'this feature'): { error: string; scope: string } {
  return { error: CLOUD_REQUIRED_MESSAGE, scope }
}
