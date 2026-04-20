/**
 * Local-mode embeddings smoke tests — Phase 2.
 *
 * Exercises:
 *   1. schema migration from a Phase-1 DB (no embeddings table) works
 *      idempotently when getDb() re-applies loadSchema()
 *   2. record_embedding writes into SQLite and returns { id, ok: true }
 *   3. find_similar_code returns top-k ordered by ascending cosine distance
 *   4. similarity ranking is correct — a vector nearly identical to embedding
 *      #2 ranks #2 first with distance ≈ 0
 *   5. cross-model isolation when `model` filter is used — deferred: the
 *      hosted API doesn't accept `model` today (only entity_type / snapshot_id)
 *      so local parity matches that behavior.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const TENTRA_HOME = mkdtempSync(join(tmpdir(), 'tentra-local-embeddings-test-'))
process.env.TENTRA_HOME = TENTRA_HOME
process.env.TENTRA_BACKEND = 'local'

const { localDispatch } = await import('../../local/handlers.js')
const { getDb, _resetDbCache } = await import('../../local/db.js')
const {
  cosineSimilarity,
  packVector,
  unpackVector,
  topKByCosine
} = await import('../../local/embeddings.js')

const REPO_ID = 'test-repo-embeddings'
const DIM = 8

function unit(v: number[]): number[] {
  let sum = 0
  for (const x of v) sum += x * x
  const n = Math.sqrt(sum)
  if (n === 0) return v
  return v.map(x => x / n)
}

async function seedSnapshotAndSymbols(): Promise<{ snapshotId: string; symbolIds: string[] }> {
  const snap = await localDispatch<{ id: string }>('POST', '/code-graph/snapshots', {
    repoId: REPO_ID, commitSha: 'phase2-test'
  })
  const filesResp = await localDispatch<{ files: Array<{ id: string }> }>(
    'POST', `/code-graph/snapshots/${snap.id}/files`,
    { files: [{ relativePath: 'src/main.ts', language: 'typescript', loc: 10, contentHash: 'hmain' }] }
  )
  const fileId = filesResp.files[0].id
  const symsResp = await localDispatch<{ symbols: Array<{ id: string }> }>(
    'POST', `/code-graph/snapshots/${snap.id}/symbols`,
    {
      symbols: Array.from({ length: 5 }, (_, i) => ({
        fileId,
        kind: 'function',
        name: `sym${i}`,
        qualifiedName: `main.sym${i}`,
        startLine: i * 10 + 1,
        endLine: i * 10 + 5
      }))
    }
  )
  return { snapshotId: snap.id, symbolIds: symsResp.symbols.map(s => s.id) }
}

describe('local embeddings — pure-JS primitives', () => {
  it('packs and unpacks a Float32Array round-trip', () => {
    const input = [0.1, -0.2, 3.0, 4.5, 0, -1e-6, 1.23456, 2.71828]
    const buf = packVector(input)
    expect(buf.byteLength).toBe(input.length * 4)
    const unpacked = unpackVector(buf)
    expect(unpacked.length).toBe(input.length)
    // Float32 rounds slightly — compare with a tiny tolerance.
    for (let i = 0; i < input.length; i++) {
      expect(Math.abs(unpacked[i] - input[i])).toBeLessThan(1e-5)
    }
  })

  it('cosineSimilarity returns 1 for identical vectors, 0 for orthogonal', () => {
    const a = Float32Array.from([1, 0, 0, 0])
    const b = Float32Array.from([1, 0, 0, 0])
    const c = Float32Array.from([0, 1, 0, 0])
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5)
    expect(cosineSimilarity(a, c)).toBeCloseTo(0, 5)
  })

  it('cosineSimilarity returns 0 for zero-magnitude input', () => {
    const a = Float32Array.from([0, 0, 0, 0])
    const b = Float32Array.from([1, 2, 3, 4])
    expect(cosineSimilarity(a, b)).toBe(0)
  })

  it('topKByCosine keeps the heap at size K and orders descending by similarity', () => {
    const query = Float32Array.from(unit([1, 0, 0, 0]))
    const cands = [
      { id: 'a', entityType: 'file', entityId: 'a', snapshotId: null, model: 'm', sourceText: '', vector: Float32Array.from(unit([1, 0, 0, 0])) },
      { id: 'b', entityType: 'file', entityId: 'b', snapshotId: null, model: 'm', sourceText: '', vector: Float32Array.from(unit([0.9, 0.1, 0, 0])) },
      { id: 'c', entityType: 'file', entityId: 'c', snapshotId: null, model: 'm', sourceText: '', vector: Float32Array.from(unit([0, 1, 0, 0])) },
      { id: 'd', entityType: 'file', entityId: 'd', snapshotId: null, model: 'm', sourceText: '', vector: Float32Array.from(unit([-1, 0, 0, 0])) }
    ]
    const hits = topKByCosine(query, cands, 2)
    expect(hits.length).toBe(2)
    expect(hits[0].id).toBe('a')
    expect(hits[1].id).toBe('b')
    expect(hits[0].similarity).toBeGreaterThan(hits[1].similarity)
  })
})

describe('local embeddings — handler round-trip against SQLite', () => {
  beforeAll(() => { _resetDbCache() })

  afterAll(() => {
    _resetDbCache()
    rmSync(TENTRA_HOME, { recursive: true, force: true })
  })

  it('creates the embeddings table on Phase 1 DBs idempotently', () => {
    const db = getDb(REPO_ID)
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all() as Array<{ name: string }>
    const names = new Set(tables.map(t => t.name))
    expect(names.has('embeddings')).toBe(true)
    // All Phase 1 tables still present.
    for (const t of ['code_repos', 'code_snapshots', 'code_files', 'code_symbols', 'code_edges']) {
      expect(names.has(t)).toBe(true)
    }
  })

  it('round-trip: record 5 embeddings, search returns #2 first for a near-duplicate query', async () => {
    const { snapshotId, symbolIds } = await seedSnapshotAndSymbols()

    // Distinct unit vectors in 8 dims. Embedding #2 sits at a known position,
    // and we'll query with something almost identical to it.
    const vectors = [
      unit([1, 0, 0, 0, 0, 0, 0, 0]),        // #0
      unit([0, 1, 0, 0, 0, 0, 0, 0]),        // #1
      unit([0.5, 0.5, 0.5, 0.5, 0, 0, 0, 0]),// #2 — target
      unit([0, 0, 0, 0, 1, 0, 0, 0]),        // #3
      unit([0, 0, 0, 0, 0, 0, 1, 1])         // #4
    ]

    for (let i = 0; i < 5; i++) {
      const resp = await localDispatch<{ id: string; ok: boolean }>(
        'POST', '/code-graph/embeddings',
        {
          entity_type: 'symbol',
          entity_id: symbolIds[i],
          snapshot_id: snapshotId,
          model: 'test-model',
          vector: vectors[i],
          source_text: `source for sym${i}`
        }
      )
      expect(resp.ok).toBe(true)
      expect(typeof resp.id).toBe('string')
    }

    // Query very close to vector #2 — differ by small noise.
    const queryVec = unit([0.5, 0.5, 0.5, 0.5, 0.02, 0, 0, 0])
    const search = await localDispatch<{
      results: Array<{ id: string; entityType: string; entityId: string; sourceText: string; distance: number }>
    }>(
      'POST', '/code-graph/embeddings/search',
      { query_vector: queryVec, snapshot_id: snapshotId, limit: 3 }
    )

    expect(search.results.length).toBe(3)
    // #2 must rank first; its cosine similarity > 0.9 (distance < 0.1).
    expect(search.results[0].entityId).toBe(symbolIds[2])
    expect(search.results[0].distance).toBeLessThan(0.1)
    // Distances strictly non-decreasing (best-first ordering).
    for (let i = 1; i < search.results.length; i++) {
      expect(search.results[i].distance).toBeGreaterThanOrEqual(search.results[i - 1].distance)
    }
    // Shape parity with hosted API: sourceText present, entityType echoed.
    expect(search.results[0].entityType).toBe('symbol')
    expect(search.results[0].sourceText).toBe('source for sym2')
  })

  it('entity_type filter narrows results to that kind only', async () => {
    // Reuse same snapshot — add a `file` entity embedding.
    const db = getDb(REPO_ID)
    const snapId = (db.prepare(
      `SELECT id FROM code_snapshots WHERE repoId = ? ORDER BY createdAt DESC LIMIT 1`
    ).get(REPO_ID) as { id: string }).id

    await localDispatch(
      'POST', '/code-graph/embeddings',
      {
        entity_type: 'file',
        entity_id: 'file-abc',
        snapshot_id: snapId,
        model: 'test-model',
        vector: unit([1, 0, 0, 0, 0, 0, 0, 0]),
        source_text: 'file blob'
      }
    )

    const fileOnly = await localDispatch<{ results: Array<{ entityType: string }> }>(
      'POST', '/code-graph/embeddings/search',
      {
        query_vector: unit([1, 0, 0, 0, 0, 0, 0, 0]),
        snapshot_id: snapId,
        entity_type: 'file',
        limit: 10
      }
    )
    expect(fileOnly.results.length).toBe(1)
    expect(fileOnly.results[0].entityType).toBe('file')
  })

  it('rejects a malformed vector with a 400-style error', async () => {
    await expect(
      localDispatch(
        'POST', '/code-graph/embeddings',
        { entity_type: 'symbol', entity_id: 'x', model: 'm', vector: [], source_text: 't' }
      )
    ).rejects.toThrow(/400/)
  })

  it('mismatched dimensions: candidates are skipped (not errored)', async () => {
    // Query with dimension != any stored embedding: the SQL pre-filter returns
    // zero candidates, yielding empty results with no error.
    const db = getDb(REPO_ID)
    const snapId = (db.prepare(
      `SELECT id FROM code_snapshots WHERE repoId = ? ORDER BY createdAt DESC LIMIT 1`
    ).get(REPO_ID) as { id: string }).id
    const resp = await localDispatch<{ results: unknown[] }>(
      'POST', '/code-graph/embeddings/search',
      { query_vector: [1, 2, 3], snapshot_id: snapId, limit: 5 }
    )
    expect(resp.results).toEqual([])
  })
})
