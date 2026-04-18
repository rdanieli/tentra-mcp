import { z } from 'zod'
import { apiGet } from '../code-index/api-client.js'

export const QuerySymbolsSchema = z.object({
  snapshot_id: z.string().min(1).describe('Snapshot ID to query against'),
  q: z.string().min(1).describe('Search query (symbol name or qualified name). Default is fuzzy trigram match; pass mode="substring" for case-insensitive contains.'),
  kind: z.enum(['function', 'class', 'method', 'interface', 'variable', 'type'])
    .optional()
    .describe('Filter by symbol kind'),
  role: z.string().optional().describe('Filter by semantic role slug (e.g. "service", "repository")'),
  mode: z.enum(['trigram', 'substring']).default('trigram')
    .describe('Match mode. "trigram" (default) ranks by pg_trgm similarity — best for fuzzy / unique lookups. "substring" uses ILIKE %q% — best for broad listings like "Handler" or "Controller"; results ranked by fan-in + fan-out.'),
  exclude_tests: z.boolean().default(true)
    .describe('Hide symbols defined in test/fixture files (default true)'),
  limit: z.number().int().positive().max(100).default(50)
    .describe('Max results to return (default 50)')
})

export async function querySymbolsHandler(raw: unknown) {
  const args = QuerySymbolsSchema.parse(raw)
  const params = new URLSearchParams({
    snapshot_id: args.snapshot_id,
    q: args.q,
    mode: args.mode,
    exclude_tests: String(args.exclude_tests),
    limit: String(args.limit)
  })
  if (args.kind) params.set('kind', args.kind)
  if (args.role) params.set('role', args.role)

  const data = await apiGet<{ symbols: unknown[] }>(`/code-graph/query/symbols?${params}`)
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}
