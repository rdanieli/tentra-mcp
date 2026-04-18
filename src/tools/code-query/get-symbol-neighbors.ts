import { z } from 'zod'
import { apiGet } from '../code-index/api-client.js'

export const GetSymbolNeighborsSchema = z.object({
  symbol_id: z.string().min(1).describe('Symbol ID to start BFS from'),
  snapshot_id: z.string().min(1).describe('Snapshot to query'),
  depth: z.number().int().min(1).max(5).default(2)
    .describe('BFS depth (default 2, max 5)'),
  edge_types: z.string().optional()
    .describe('Comma-separated edge types to follow: call,import,inherit,implement,reference'),
  direction: z.enum(['outgoing', 'both']).default('outgoing')
    .describe('outgoing = who this calls; both = also who calls this')
})

export async function getSymbolNeighborsHandler(raw: unknown) {
  const args = GetSymbolNeighborsSchema.parse(raw)
  const params = new URLSearchParams({
    snapshot_id: args.snapshot_id,
    depth: String(args.depth),
    direction: args.direction
  })
  if (args.edge_types) params.set('edge_types', args.edge_types)

  const data = await apiGet(`/code-graph/query/neighbors/${args.symbol_id}?${params}`)
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}
