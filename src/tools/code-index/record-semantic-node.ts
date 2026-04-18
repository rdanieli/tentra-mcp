import { z } from 'zod'
import { apiPost, apiPatch, apiGet } from './api-client.js'

export const RecordSemanticNodeSchema = z.object({
  job_id: z.string().min(1),
  file_id: z.string().optional(),
  symbol_id: z.string().optional(),
  snapshot_id: z.string().min(1),
  purpose: z.string().min(1),
  domain_tags: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.7),
  extracted_by: z.string().min(1),
  semantic_role_slug: z.string().optional(),
  is_god_node: z.boolean().optional(),
  lens_metadata: z.record(z.unknown()).optional()
})

export async function recordSemanticNodeHandler(raw: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const d = RecordSemanticNodeSchema.parse(raw)
  if (!d.file_id && !d.symbol_id) throw new Error('file_id or symbol_id required')

  const created = await apiPost<{ id: string }>('/code-graph/semantics', {
    fileId: d.file_id,
    symbolId: d.symbol_id,
    snapshotId: d.snapshot_id,
    purpose: d.purpose,
    domainTags: d.domain_tags,
    confidence: d.confidence,
    extractedBy: d.extracted_by,
    lensMetadata: d.lens_metadata
  })

  // Advance job processedFiles by 1
  const job = await apiGet<{ processedFiles: number }>(`/code-graph/jobs/${d.job_id}`)
  await apiPatch(`/code-graph/jobs/${d.job_id}`, {
    processedFiles: job.processedFiles + 1,
    lastBatchCursor: job.processedFiles + 1
  })

  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, semantic_id: created.id }) }] }
}
