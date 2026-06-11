import { z } from 'zod'
import { apiPost, localCloudRequiredContent } from '../code-index/api-client.js'

export const GetSpecAlignmentSchema = z.object({
  architecture_id: z.string().min(1)
    .describe('Architecture (spec) to align against — from list_architectures or create_architecture'),
  file_paths: z.array(z.string().min(1)).min(1)
    .describe('Relative repo paths the agent just touched, e.g. ["packages/api/src/payments/handler.ts"]'),
  snapshot_id: z.string().optional()
    .describe('Code snapshot to evaluate against. Defaults to the most recent snapshot whose files map to any service in this architecture.')
})

interface SpecAlignmentResponse {
  architecture_id: string
  architecture_name: string
  snapshot_id: string
  services_touched: Array<{
    service_id: string
    name?: string
    type: string
    responsibility: string
    files: string[]
    edges_out: Array<{ to: string; type: string }>
    edges_in: Array<{ from: string; type: string }>
    decisions: {
      on_service: Array<{ slug: string; title: string; status: string; link_kind: string; decision: string }>
      on_files: Array<{ slug: string; title: string; status: string; link_kind: string; file_id: string; decision: string }>
    }
  }>
  unmapped_files: { not_in_snapshot: string[]; no_service_mapping: string[] }
  orphan_services: Array<{ service_id: string; name?: string; responsibility: string }>
}

export async function getSpecAlignmentHandler(raw: unknown) {
  const args = GetSpecAlignmentSchema.parse(raw)
  const guard = localCloudRequiredContent('spec-alignment')
  if (guard) return guard

  const data = await apiPost<SpecAlignmentResponse>('/code-graph/spec-alignment', args)

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(data, null, 2)
    }]
  }
}
