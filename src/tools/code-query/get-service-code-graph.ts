import { z } from 'zod'
import { apiGet } from '../code-index/api-client.js'

export const GetServiceCodeGraphSchema = z.object({
  service_id: z.string().min(1).describe('Tentra canvas service ID'),
  snapshot_id: z.string().min(1).describe('Snapshot to query'),
  depth: z.number().int().min(1).max(5).default(2)
    .describe('Edge traversal depth for cross-service edges'),
  include_semantics: z.boolean().default(false)
    .describe('Include AI-extracted purpose + domain tags per symbol')
})

export async function getServiceCodeGraphHandler(raw: unknown) {
  const args = GetServiceCodeGraphSchema.parse(raw)
  const params = new URLSearchParams({
    snapshot_id: args.snapshot_id,
    depth: String(args.depth),
    include_semantics: String(args.include_semantics)
  })
  const data = await apiGet(`/code-graph/query/service/${args.service_id}?${params}`)
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}
