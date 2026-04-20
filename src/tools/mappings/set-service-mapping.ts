import { z } from 'zod'
import { apiPost, localCloudRequiredContent } from '../code-index/api-client.js'

export const SetServiceMappingSchema = z.object({
  snapshot_id: z.string().min(1).describe('Snapshot ID to update file mappings in'),
  mappings: z.array(z.object({
    path: z.string().min(1).describe('Relative file path (exact match against CodeFile.relativePath)'),
    service_id: z.string().min(1).describe('Tentra canvas service ID to assign to this file')
  })).min(1).describe('One or more path → service_id pairs to apply')
})

export async function setServiceMappingHandler(raw: unknown) {
  const args = SetServiceMappingSchema.parse(raw)
  const guard = localCloudRequiredContent('service-mapping')
  if (guard) return guard

  const result = await apiPost<{ ok: boolean; updatedFiles: number }>(
    `/code-graph/snapshots/${args.snapshot_id}/files/map-service`,
    { mappings: args.mappings }
  )

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ ok: result.ok, updatedFiles: result.updatedFiles })
    }]
  }
}
