import { z } from 'zod'
import { apiPost, localCloudRequiredContent } from '../code-index/api-client.js'

export const LinkDecisionSchema = z.object({
  decision_id: z.string().min(1).describe('ID of the decision to link from'),
  entity_type: z.enum(['service', 'file', 'symbol', 'contract', 'domain'])
    .describe('Type of entity being linked'),
  entity_id: z.string().min(1).describe('ID of the entity'),
  link_kind: z.enum(['motivates', 'constrains', 'documents', 'implements'])
    .describe(
      '"motivates" = decision prompted this entity to exist, ' +
      '"constrains" = decision limits how this entity may evolve, ' +
      '"documents" = decision explains this entity, ' +
      '"implements" = entity is the concrete realization of the decision'
    )
})

export async function linkDecisionHandler(raw: unknown) {
  const args = LinkDecisionSchema.parse(raw)
  const guard = localCloudRequiredContent('decisions')
  if (guard) return guard

  const result = await apiPost<{ id: string }>(
    `/code-graph/decisions/${args.decision_id}/links`,
    {
      entity_type: args.entity_type,
      entity_id: args.entity_id,
      link_kind: args.link_kind
    }
  )

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ ok: true, link_id: result.id })
    }]
  }
}
