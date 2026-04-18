import { z } from 'zod'
import { apiPost } from '../code-index/api-client.js'

export const RecordEmbeddingSchema = z.object({
  entity_type: z.enum(['file', 'symbol'])
    .describe('What kind of entity this embedding represents'),
  entity_id: z.string().min(1)
    .describe('ID of the file or symbol being embedded'),
  snapshot_id: z.string().optional()
    .describe('Snapshot this embedding belongs to'),
  model: z.string().min(1)
    .describe('Embedding model identifier (e.g. text-embedding-3-small)'),
  vector: z.array(z.number()).min(1).max(4096)
    .describe('The embedding vector produced by the agent'),
  source_text: z.string().min(1)
    .describe('The text that was embedded (for audit / re-embed on model change)')
})

export async function recordEmbeddingHandler(raw: unknown) {
  const args = RecordEmbeddingSchema.parse(raw)
  const data = await apiPost('/code-graph/embeddings', {
    entity_type: args.entity_type,
    entity_id: args.entity_id,
    snapshot_id: args.snapshot_id,
    model: args.model,
    vector: args.vector,
    source_text: args.source_text
  })
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}
