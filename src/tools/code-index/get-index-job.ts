import { z } from 'zod'
import { apiGet } from './api-client.js'

export const GetIndexJobSchema = z.object({ job_id: z.string().min(1) })

export async function getIndexJobHandler(raw: unknown) {
  const { job_id } = GetIndexJobSchema.parse(raw)
  const job = await apiGet(`/code-graph/jobs/${job_id}`)
  return { content: [{ type: 'text' as const, text: JSON.stringify(job) }] }
}
