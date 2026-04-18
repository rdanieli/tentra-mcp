import { z } from 'zod'
import { apiPost } from '../code-index/api-client.js'

export const SetDomainMembershipSchema = z.object({
  domain_id: z.string().min(1).describe('Domain ID to add the entity to'),
  entity_type: z.enum(['file', 'symbol', 'service']).describe('Kind of entity being assigned'),
  entity_id: z.string().min(1).describe('ID of the file, symbol, or service'),
  confidence: z.number().min(0).max(1).default(1.0)
    .describe('Confidence score 0–1 (default 1.0 for human assignments)'),
  source: z.enum(['ai', 'human']).default('human')
    .describe('Whether this assignment was AI-inferred or set by a human')
})

export async function setDomainMembershipHandler(raw: unknown) {
  const args = SetDomainMembershipSchema.parse(raw)

  const result = await apiPost<{ id: string }>(
    `/code-graph/domains/${args.domain_id}/memberships`,
    {
      entity_type: args.entity_type,
      entity_id: args.entity_id,
      confidence: args.confidence,
      source: args.source
    }
  )

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ ok: true, membership_id: result.id })
    }]
  }
}
