import { z } from 'zod'
import { apiPost, localCloudRequiredContent } from '../code-index/api-client.js'

const LinkInputSchema = z.object({
  entity_type: z.enum(['service', 'file', 'symbol', 'contract', 'domain']),
  entity_id: z.string().min(1),
  link_kind: z.enum(['motivates', 'constrains', 'documents', 'implements'])
})

export const RecordDecisionSchema = z.object({
  workspace_id: z.string().min(1).describe('Workspace to store the decision in'),
  slug: z.string().min(1).describe('Short identifier, e.g. "adr-007" — must be unique per workspace'),
  title: z.string().min(1).describe('One-line decision title'),
  status: z.enum(['proposed', 'accepted', 'deprecated', 'superseded']).default('proposed')
    .describe('Decision lifecycle status'),
  context: z.string().min(1).describe('Background: why this decision was needed'),
  decision: z.string().min(1).describe('The actual decision that was made'),
  consequences: z.string().min(1).describe('Trade-offs, implications, follow-on work'),
  decided_at: z.string().datetime().optional().describe('ISO-8601 datetime when decision was finalized'),
  superseded_by_id: z.string().optional()
    .describe('ID of an OLDER decision that this new one supersedes. The older decision will be marked "superseded".'),
  links: z.array(LinkInputSchema).optional()
    .describe('Entities this decision directly affects — can be added later with link_decision')
})

export async function recordDecisionHandler(raw: unknown) {
  const args = RecordDecisionSchema.parse(raw)
  const guard = localCloudRequiredContent('decisions')
  if (guard) return guard

  const result = await apiPost<{ id: string; slug: string; status: string; links: unknown[] }>(
    '/code-graph/decisions',
    {
      workspace_id: args.workspace_id,
      slug: args.slug,
      title: args.title,
      status: args.status,
      context: args.context,
      decision: args.decision,
      consequences: args.consequences,
      decided_at: args.decided_at,
      superseded_by_id: args.superseded_by_id,
      links: args.links
    }
  )

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        ok: true,
        decision_id: result.id,
        slug: result.slug,
        status: result.status,
        links_created: result.links?.length ?? 0
      })
    }]
  }
}
