/**
 * Local-mode vector search primitives — pure JavaScript.
 *
 * We intentionally avoid native extensions (sqlite-vec, pgvector, FAISS) so the
 * local mode ships as a single portable bundle: no prebuilds, no platform
 * matrix, no install-time compilation. O(n) full-scan cosine scales to the low
 * 10s of thousands of vectors per snapshot, which covers every realistic
 * single-repo index. Enterprise users with >100k embeddings can opt into a
 * native backend later via a build flag — deferred past Phase 2.
 *
 * Storage layout: Float32Array packed into a SQLite BLOB. 4 bytes × dimension
 * per row. 1536-dim vectors cost 6 KB each, so 10k embeddings ≈ 60 MB on disk
 * — still well within local-dev territory.
 */

/**
 * Pack a JS number[] into a Node Buffer holding a Float32Array's bytes.
 * SQLite stores BLOBs as Buffers via better-sqlite3 — no encoding step needed
 * beyond this one.
 */
export function packVector(v: number[] | Float32Array): Buffer {
  const arr = v instanceof Float32Array ? v : Float32Array.from(v)
  // Buffer.from on a TypedArray.buffer shares memory; .slice() on the buffer
  // view gives us a dedicated copy that owns its bytes, so later mutations
  // to `arr` can't corrupt the row. (In practice we never mutate after pack,
  // but the defensive copy costs O(dim) once per insert — negligible.)
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

/**
 * Unpack a BLOB (Node Buffer) back into a Float32Array. Zero-copy view over
 * the buffer's underlying ArrayBuffer — callers MUST NOT mutate.
 */
export function unpackVector(buf: Buffer): Float32Array {
  // Buffer is a Uint8Array subclass. Its byteOffset / byteLength slice out the
  // portion of the backing ArrayBuffer that belongs to this Buffer, which lets
  // us wrap the same bytes in a Float32Array without copying.
  if (buf.byteLength % 4 !== 0) {
    throw new Error(`[embeddings] unpackVector: buffer length ${buf.byteLength} is not a multiple of 4`)
  }
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

/**
 * Cosine similarity between two same-length Float32Array vectors.
 * Returns a value in [-1, 1] where 1 = identical direction.
 *
 * Degenerate cases:
 *   - either vector has zero magnitude → returns 0 (no direction to compare)
 *   - length mismatch → throws (caller bug — dimensions must match)
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`[embeddings] cosineSimilarity: dimension mismatch ${a.length} vs ${b.length}`)
  }
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export interface EmbeddingCandidate {
  id: string
  entityType: string
  entityId: string
  snapshotId: string | null
  model: string
  sourceText: string
  vector: Float32Array
}

export interface SimilarityHit {
  id: string
  entityType: string
  entityId: string
  snapshotId: string | null
  model: string
  sourceText: string
  /** Cosine similarity in [-1, 1], higher = more similar. */
  similarity: number
  /** Cosine distance in [0, 2], lower = more similar (hosted API parity). */
  distance: number
}

/**
 * Top-K by cosine similarity against `query`.
 *
 * Implementation: min-heap of size K keyed by similarity. Each candidate costs
 * O(dim) for the similarity computation and O(log K) for the heap push, which
 * beats full-sort O(n log n) once n is larger than a few thousand. For small
 * n the heap overhead is negligible, so we use the heap path unconditionally.
 */
export function topKByCosine(
  query: Float32Array,
  candidates: EmbeddingCandidate[],
  k: number
): SimilarityHit[] {
  if (k <= 0 || candidates.length === 0) return []
  const effectiveK = Math.min(k, candidates.length)

  // Min-heap: smallest similarity at the top. When a new candidate beats the
  // top, we pop+push. This keeps the heap at size K throughout.
  const heap: SimilarityHit[] = []

  const heapUp = (i: number) => {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (heap[parent].similarity <= heap[i].similarity) break
      ;[heap[parent], heap[i]] = [heap[i], heap[parent]]
      i = parent
    }
  }
  const heapDown = (i: number) => {
    const n = heap.length
    while (true) {
      const l = 2 * i + 1
      const r = 2 * i + 2
      let smallest = i
      if (l < n && heap[l].similarity < heap[smallest].similarity) smallest = l
      if (r < n && heap[r].similarity < heap[smallest].similarity) smallest = r
      if (smallest === i) break
      ;[heap[smallest], heap[i]] = [heap[i], heap[smallest]]
      i = smallest
    }
  }

  for (const cand of candidates) {
    if (cand.vector.length !== query.length) continue // mismatched dim → silently skip
    const sim = cosineSimilarity(query, cand.vector)
    const hit: SimilarityHit = {
      id: cand.id,
      entityType: cand.entityType,
      entityId: cand.entityId,
      snapshotId: cand.snapshotId,
      model: cand.model,
      sourceText: cand.sourceText,
      similarity: sim,
      // Cosine distance = 1 - similarity (matches pgvector's <=> operator in
      // terms of "lower = closer"; the hosted API returns the raw operator
      // value which is also 1 - cos(a, b) for unit-normalized vectors).
      distance: 1 - sim
    }
    if (heap.length < effectiveK) {
      heap.push(hit)
      heapUp(heap.length - 1)
    } else if (sim > heap[0].similarity) {
      heap[0] = hit
      heapDown(0)
    }
  }

  // Sort final K descending by similarity so the caller gets best-first.
  return heap.sort((a, b) => b.similarity - a.similarity)
}
