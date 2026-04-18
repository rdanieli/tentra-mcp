import { z } from 'zod'
import { apiGet } from '../code-index/api-client.js'

export const ExplainCodePathSchema = z.object({
  from_symbol: z.string().min(1).describe('Starting symbol ID'),
  to_symbol: z.string().min(1).describe('Target symbol ID'),
  snapshot_id: z.string().min(1).describe('Snapshot to query')
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
