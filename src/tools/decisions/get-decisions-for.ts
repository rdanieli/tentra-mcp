import { z } from 'zod'
import { apiGet } from '../code-index/api-client.js'

export const GetDecisionsForSchema = z.object({
  entity_type: z.enum(['service', 'file', 'symbol', 'contract', 'domain'])
    .describe('Type of entity to look up decisions for'),
  entity_id: z.string().min(1)
    .describe('ID of the entity (service ID, file ID, symbol ID, etc.)'),
  include_superseded: z.boolean().default(true)
    .describe('Whether to include decisions with status "superseded" in results (default true — full lineage)')
})

export async function getDecisionsForHandler(raw: unknown) {
  const args = GetDecisionsForSchema.parse(raw)

  const data = await apiGet<{
    decisions: Array<{
      id: string
      slug: string
      title: string
      status: string
      context: string
      decision: string
      consequences: string
      createdAt: string
      decidedAt: string | null
      linkKind: string
    }>
  }>(`/code-graph/decisions/for/${args.entity_type}/${encodeURIComponent(args.entity_id)}`)

  const results = args.include_superseded
    ? data.decisions
    : data.decisions.filter(d => d.status !== 'superseded')

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ decisions: results, total: results.length })
    }]
  }
}
