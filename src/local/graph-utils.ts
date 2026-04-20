/**
 * Graph helpers — ported verbatim (except for this header) from
 * packages/api/src/lib/code-graph/{analyzer,pathfinder}.ts.
 *
 * These functions are pure (no I/O, no Prisma) so the local backend can reuse
 * them as-is. If either the API or local copy changes, the other should mirror —
 * but for Phase 1 we copy rather than share to avoid yanking the indexer
 * package around. Follow-up: lift both into a shared graph-utils module under
 * packages/indexer so there's a single source of truth.
 */

export interface FanCounts {
  fanIn: number
  fanOut: number
}

export function computeFanCounts(
  symbols: Array<{ id: string }>,
  edges: Array<{ fromSymbolId: string | null; toSymbolId: string | null }>
): Map<string, FanCounts> {
  const map = new Map<string, FanCounts>()
  for (const s of symbols) map.set(s.id, { fanIn: 0, fanOut: 0 })
  for (const e of edges) {
    if (e.fromSymbolId) {
      const from = map.get(e.fromSymbolId)
      if (from) from.fanOut += 1
    }
    if (e.toSymbolId) {
      const to = map.get(e.toSymbolId)
      if (to) to.fanIn += 1
    }
  }
  return map
}

export interface GraphEdge {
  fromSymbolId: string | null
  toSymbolId: string | null
  edgeType: string
}

export interface BfsOptions {
  depth?: number
  edgeTypes?: string[]
  direction?: 'outgoing' | 'both'
}

export interface BfsResult {
  visited: Set<string>
  edges: GraphEdge[]
}

export interface PathResult {
  path: string[]
  edges: GraphEdge[]
}

export function bfsNeighbors(
  startId: string,
  edges: GraphEdge[],
  options: BfsOptions = {}
): BfsResult {
  const maxDepth = options.depth ?? 2
  const typeFilter = options.edgeTypes
  const includeBoth = options.direction === 'both'

  const visited = new Set<string>([startId])
  const traversed: GraphEdge[] = []
  const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }]

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!
    if (depth >= maxDepth) continue

    for (const e of edges) {
      if (typeFilter && !typeFilter.includes(e.edgeType)) continue
      if (e.toSymbolId === null) continue

      if (e.fromSymbolId === id && !visited.has(e.toSymbolId)) {
        visited.add(e.toSymbolId)
        traversed.push(e)
        queue.push({ id: e.toSymbolId, depth: depth + 1 })
      }

      if (includeBoth && e.toSymbolId === id && e.fromSymbolId && !visited.has(e.fromSymbolId)) {
        visited.add(e.fromSymbolId)
        traversed.push(e)
        queue.push({ id: e.fromSymbolId, depth: depth + 1 })
      }
    }
  }

  return { visited, edges: traversed }
}

export function shortestPath(
  fromId: string,
  toId: string,
  edges: GraphEdge[]
): PathResult | null {
  if (fromId === toId) return { path: [fromId], edges: [] }

  const parent = new Map<string, { parentId: string; edge: GraphEdge }>()
  const visited = new Set<string>([fromId])
  const queue: string[] = [fromId]

  while (queue.length > 0) {
    const current = queue.shift()!

    for (const e of edges) {
      if (e.fromSymbolId !== current) continue
      if (e.toSymbolId === null) continue
      if (visited.has(e.toSymbolId)) continue

      visited.add(e.toSymbolId)
      parent.set(e.toSymbolId, { parentId: current, edge: e })

      if (e.toSymbolId === toId) {
        const path: string[] = []
        const pathEdges: GraphEdge[] = []
        let cursor = toId
        while (cursor !== fromId) {
          path.unshift(cursor)
          const p = parent.get(cursor)!
          pathEdges.unshift(p.edge)
          cursor = p.parentId
        }
        path.unshift(fromId)
        return { path, edges: pathEdges }
      }

      queue.push(e.toSymbolId)
    }
  }

  return null
}

// Query-side helper — mirror of `looksLikeLocalVar` from
// packages/api/src/routes/code-graph/query.ts. Used by neighbors() to drop
// noisy external-edge candidates before returning them.
export function looksLikeLocalVar(name: string): boolean {
  if (name.length <= 2) return true
  const commonLocals = new Set([
    'abs', 'rel', 'src', 'dst', 'id', 'idx', 'i', 'j', 'k', 'n', 's',
    'e', 'v', 'x', 'y', 'msg', 'err', 'res', 'req', 'ctx', 'val',
    'key', 'obj', 'arr', 'str', 'num', 'fn', 'cb', 'raw', 'out', 'tmp',
    'buf', 'row', 'col', 'row_', 'col_', 'args', 'opts', 'len',
    'root', 'node', 'name', 'type', 'data'
  ])
  return commonLocals.has(name)
}
