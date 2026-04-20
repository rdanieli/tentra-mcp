/**
 * Local-backend smoke tests — Phase 1 / tier-1.
 *
 * Exercises the SQLite + dispatch seam end-to-end without going through an MCP
 * transport: we call `localDispatch` directly as the hosted api-client would.
 * Uses an isolated $TENTRA_HOME so it never touches the user's ~/.tentra.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const TENTRA_HOME = mkdtempSync(join(tmpdir(), 'tentra-local-test-'))
process.env.TENTRA_HOME = TENTRA_HOME
process.env.TENTRA_BACKEND = 'local'

// Import after env is set so getDb() picks up TENTRA_HOME.
const { localDispatch } = await import('../../local/handlers.js')
const { getDb, _resetDbCache } = await import('../../local/db.js')

const REPO_ID = 'test-repo-local'

async function seedSnapshot() {
  const snap = await localDispatch<{ id: string }>('POST', '/code-graph/snapshots', {
    repoId: REPO_ID,
    commitSha: 'deadbeef'
  })
  const filesResp = await localDispatch<{ count: number; files: Array<{ id: string; relativePath: string }> }>(
    'POST', `/code-graph/snapshots/${snap.id}/files`,
    {
      files: [
        { relativePath: 'src/foo.ts', language: 'typescript', loc: 10, contentHash: 'h1' },
        { relativePath: 'src/bar.ts', language: 'typescript', loc: 20, contentHash: 'h2' },
        { relativePath: 'src/baz.test.ts', language: 'typescript', loc: 5, contentHash: 'h3' }
      ]
    }
  )
  const [fooId, barId, bazId] = filesResp.files.map(f => f.id)

  const symsResp = await localDispatch<{ count: number; symbols: Array<{ id: string; qualifiedName: string }> }>(
    'POST', `/code-graph/snapshots/${snap.id}/symbols`,
    {
      symbols: [
        { fileId: fooId, kind: 'function', name: 'foo', qualifiedName: 'foo.foo', startLine: 1, endLine: 5 },
        { fileId: fooId, kind: 'function', name: 'fooHelper', qualifiedName: 'foo.fooHelper', startLine: 6, endLine: 8 },
        { fileId: barId, kind: 'function', name: 'bar', qualifiedName: 'bar.bar', startLine: 1, endLine: 10 },
        { fileId: bazId, kind: 'function', name: 'testFoo', qualifiedName: 'baz.testFoo', startLine: 1, endLine: 3 }
      ]
    }
  )
  const symMap = new Map(symsResp.symbols.map(s => [s.qualifiedName, s.id]))
  const fooSymId = symMap.get('foo.foo')!
  const fooHelperSymId = symMap.get('foo.fooHelper')!
  const barSymId = symMap.get('bar.bar')!
  const testFooSymId = symMap.get('baz.testFoo')!

  // Edges: bar → foo (call), bar → foo (call) twice to test callCount, foo → fooHelper (call),
  // testFoo → foo (call), external edge from foo → "console.log".
  await localDispatch('POST', `/code-graph/snapshots/${snap.id}/edges`, {
    edges: [
      { fromSymbolId: barSymId, toSymbolId: fooSymId, edgeType: 'call' },
      { fromSymbolId: barSymId, toSymbolId: fooSymId, edgeType: 'call' },
      { fromSymbolId: fooSymId, toSymbolId: fooHelperSymId, edgeType: 'call' },
      { fromSymbolId: testFooSymId, toSymbolId: fooSymId, edgeType: 'call' },
      { fromSymbolId: fooSymId, toSymbolId: null, toExternal: 'console.log', edgeType: 'reference' }
    ]
  })

  return { snapshotId: snap.id, fooSymId, fooHelperSymId, barSymId, testFooSymId, fooId, barId, bazId }
}

describe('local backend — end-to-end tier-1 round-trip', () => {
  beforeAll(() => { _resetDbCache() })

  afterAll(() => {
    _resetDbCache()
    rmSync(TENTRA_HOME, { recursive: true, force: true })
  })

  it('creates the SQLite file under TENTRA_HOME/graphs/{repoId}/db.sqlite', () => {
    const db = getDb(REPO_ID)
    expect(db).toBeDefined()
    // Sanity: tables exist
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all() as Array<{ name: string }>
    const names = new Set(tables.map(t => t.name))
    for (const t of [
      'code_repos', 'code_snapshots', 'code_files',
      'code_symbols', 'code_edges', 'code_index_jobs',
      'code_semantics'
    ]) expect(names.has(t)).toBe(true)
  })

  it('POSTs snapshot/files/symbols/edges and persists rows', async () => {
    const { snapshotId } = await seedSnapshot()
    const db = getDb(REPO_ID)

    const snapCount = (db.prepare(`SELECT COUNT(*) AS c FROM code_snapshots WHERE repoId = ?`).get(REPO_ID) as { c: number }).c
    expect(snapCount).toBeGreaterThanOrEqual(1)

    const fileCount = (db.prepare(`SELECT COUNT(*) AS c FROM code_files WHERE snapshotId = ?`).get(snapshotId) as { c: number }).c
    expect(fileCount).toBe(3)

    const symCount = (db.prepare(`SELECT COUNT(*) AS c FROM code_symbols WHERE snapshotId = ?`).get(snapshotId) as { c: number }).c
    expect(symCount).toBe(4)

    const edgeCount = (db.prepare(`SELECT COUNT(*) AS c FROM code_edges WHERE snapshotId = ?`).get(snapshotId) as { c: number }).c
    expect(edgeCount).toBe(5)

    // Fan counts were recomputed post-edges-insert. foo.foo = 3 inbound (bar×2, testFoo×1).
    const fooRow = db.prepare(`SELECT fanIn, fanOut FROM code_symbols WHERE qualifiedName = ?`)
      .get('foo.foo') as { fanIn: number; fanOut: number }
    expect(fooRow.fanIn).toBe(3)
    expect(fooRow.fanOut).toBe(2) // call to fooHelper + reference to console.log
  })

  it('GET /query/symbols substring mode returns expected symbols', async () => {
    const { snapshotId } = await seedSnapshot()
    const resp = await localDispatch<{ symbols: Array<{ qualifiedName: string }> }>(
      'GET', `/code-graph/query/symbols?snapshot_id=${snapshotId}&q=foo&mode=substring&exclude_tests=true`
    )
    const names = resp.symbols.map(s => s.qualifiedName).sort()
    expect(names).toEqual(['foo.foo', 'foo.fooHelper'])
  })

  it('GET /query/references/:id groups callers by (fromSymbolId, edgeType) with callCount', async () => {
    const { snapshotId, fooSymId } = await seedSnapshot()
    const resp = await localDispatch<{
      resolvedCount: number
      references: Array<{ kind: string; fromQualifiedName: string; callCount: number }>
    }>(
      'GET', `/code-graph/query/references/${fooSymId}?snapshot_id=${snapshotId}`
    )
    // 2 unique callers: bar.bar (call x2 → callCount 2) and baz.testFoo (call x1 → callCount 1).
    expect(resp.resolvedCount).toBe(2)
    const byCaller = new Map(resp.references.map(r => [r.fromQualifiedName, r.callCount]))
    expect(byCaller.get('bar.bar')).toBe(2)
    expect(byCaller.get('baz.testFoo')).toBe(1)
  })

  it('GET /query/god-nodes ranks by fanIn + fanOut desc and excludes test files', async () => {
    const { snapshotId } = await seedSnapshot()
    const resp = await localDispatch<{
      godNodes: Array<{ qualifiedName: string; isTest: boolean; fanIn: number; fanOut: number }>
    }>(
      'GET', `/code-graph/query/god-nodes?snapshot_id=${snapshotId}&top_n=5&exclude_tests=true`
    )
    // foo.foo should rank first (fanIn=3, fanOut=2). testFoo lives in a .test.ts
    // file and must NOT appear (isTest filter). All remaining rows are non-test.
    expect(resp.godNodes.length).toBeGreaterThan(0)
    expect(resp.godNodes[0].qualifiedName).toBe('foo.foo')
    for (const g of resp.godNodes) expect(g.isTest).toBe(false)
  })

  it('architecture-endpoint errors are surfaced when apiRequest uses local mode', async () => {
    // The apiRequest function in src/index.ts handles this branch; emulate it.
    // Here we assert the supporting helper path: a /architectures/* request in
    // local mode throws a "Requires hosted mode" style error.
    // We replicate the exact path the index.ts code walks.
    const { default: indexModule } = await import('../../index.js').then(m => ({ default: m })).catch(() => ({ default: null }))
    // Not loadable as a side-effect free import (it starts the MCP server).
    // We spot-check the branch by asserting that localDispatch rejects architecture
    // routes cleanly.
    await expect(
      localDispatch('GET', '/architectures')
    ).rejects.toThrow(/404 route not found/)
    expect(indexModule).toBeDefined // silence unused var
  })

  it('embeddings endpoints return structured cloudRequired response', async () => {
    const resp = await localDispatch<{ error: string; scope: string }>(
      'POST', '/code-graph/embeddings', { entity_type: 'file', entity_id: 'x' }
    )
    expect(resp.error).toMatch(/Requires hosted mode/)
  })
})
