import { z } from 'zod'
import { apiPost } from '../code-index/api-client.js'

export const FindSimilarCodeSchema = z.object({
  query_vector: z.array(z.number()).min(1).max(4096)
    .describe('Pre-computed dense embedding of the search query, 1–4096 dims. The agent must embed its own text first (Tentra does NOT embed for you). Must share the same dimension as the vectors recorded via record_embedding — mismatched dims return no matches. Example dim: 1536 for OpenAI text-embedding-3-small.'),
  entity_type: z.enum(['file', 'symbol']).optional()
    .describe('Restrict results to only files OR only symbols. Omit to include both. Default: both. Set to "file" to find similar whole-file summaries; "symbol" for similar functions/classes.'),
  snapshot_id: z.string().optional()
    .describe('Scope the search to one snapshot. Omit to search embeddings across every snapshot in the workspace (useful when embeddings were seeded without a snapshot_id).'),
  limit: z.number().int().positive().max(50).default(10)
    .describe('Max matches to return, ranked by cosine similarity descending. Default 10. Max 50. Lower values cost less context.')
})

export async function findSimilarCodeHandler(raw: unknown) {
  const args = FindSimilarCodeSchema.parse(raw)
  const body: Record<string, unknown> = {
    query_vector: args.query_vector,
    limit: args.limit
  }
  if (args.entity_type) body.entity_type = args.entity_type
  if (args.snapshot_id) body.snapshot_id = args.snapshot_id

  const data = await apiPost('/code-graph/embeddings/search', body)
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}
