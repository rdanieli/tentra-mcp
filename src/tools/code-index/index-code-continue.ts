import { z } from 'zod'
import { apiGet, apiPost } from './api-client.js'

export const IndexCodeContinueSchema = z.object({
  job_id: z.string().min(1)
})

export async function indexCodeContinueHandler(raw: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { job_id } = IndexCodeContinueSchema.parse(raw)
  const job = await apiGet<{ id: string; snapshotId: string; processedFiles: number; totalFiles: number; status: string; lastBatchCursor: number }>(`/code-graph/jobs/${job_id}`)

  if (job.status === 'completed') {
    return { content: [{ type: 'text', text: JSON.stringify({ done: true, summary: { processed: job.processedFiles, total: job.totalFiles } }) }] }
  }

  // If processedFiles caught up to totalFiles, mark complete and return done
  if (job.processedFiles >= job.totalFiles) {
    await apiPost(`/code-graph/jobs/${job.id}/complete`, {})
    return { content: [{ type: 'text', text: JSON.stringify({ done: true, summary: { processed: job.processedFiles, total: job.totalFiles } }) }] }
  }

  // Still work remaining — return status so agent knows to send more
  return { content: [{ type: 'text', text: JSON.stringify({
    pending: job.totalFiles - job.processedFiles,
    cursor: job.lastBatchCursor,
    instruction: 'Send the next batch of semantic extractions via record_semantic_node calls.'
  }) }] }
}
