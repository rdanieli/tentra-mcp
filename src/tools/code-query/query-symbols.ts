import { z } from 'zod'
import { apiGet } from '../code-index/api-client.js'

export const QuerySymbolsSchema = z.object({
  snapshot_id: z.string().min(1).describe('Snapshot ID to query against'),
  q: z.string().min(1).describe('Fuzzy search query (symbol name or qualified name)'),
  kind: z.enum(['function', 'class', 'method', 'interface', 'variable', 'type'])
    .optional()
    .describe('Filter by symbol kind'),
  role: z.string().optional().describe('Filter by semantic role slug (e.g. "service", "repository")'),
  limit: z.number().int().positive().max(100).default(50)
    .describe('Max results to return (default 50)')
})

export async function querySymbolsHandler(raw: unknown) {
  const args = QuerySymbolsSchema.parse(raw)
  const params = new URLSearchParams({
    snapshot_id: args.snapshot_id,
    q: args.q,
    limit: String(args.limit)
  })
  if (args.kind) params.set('kind', args.kind)
  if (args.role) params.set('role', args.role)

  const data = await apiGet<{ symbols: unknown[] }>(`/code-graph/query/symbols?${params}`)
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}
