import { z } from 'zod'
import { apiGet } from '../code-index/api-client.js'

export const ExplainCodePathSchema = z.object({
  from_symbol: z.string().min(1).describe('Source symbol_id (one end of the path). Obtain from query_symbols. The path is computed as the shortest edge sequence starting at this symbol.'),
  to_symbol: z.string().min(1).describe('Target symbol_id (the other end of the path). Obtain from query_symbols. Both symbols must belong to the same snapshot_id to be connectable.'),
  snapshot_id: z.string().min(1).describe('Snapshot the two symbols live in. Obtain from index_code response or list_snapshots. If the symbols are in different snapshots, the search will return no_path.')
})

export async function explainCodePathHandler(raw: unknown) {
  const args = ExplainCodePathSchema.parse(raw)
  const params = new URLSearchParams({
    from_symbol: args.from_symbol,
    to_symbol: args.to_symbol,
    snapshot_id: args.snapshot_id
  })
  const data = await apiGet(`/code-graph/query/path?${params}`)
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}
