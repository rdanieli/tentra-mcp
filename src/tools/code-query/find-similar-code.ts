import { z } from 'zod'
import { apiPost } from '../code-index/api-client.js'

export const FindSimilarCodeSchema = z.object({
  query_vector: z.array(z.number()).min(1).max(4096)
    .describe('Dense embedding vector produced by the agent for the search query'),
  entity_type: z.enum(['file', 'symbol']).optional()
    .describe('Restrict results to files or symbols only'),
  snapshot_id: z.string().optional()
    .describe('Restrict search to a specific snapshot'),
  limit: z.number().int().positive().max(50).default(10)
    .describe('Max results (default 10)')
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
