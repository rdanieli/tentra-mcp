import { z } from 'zod'
import { apiGet } from './api-client.js'

export const GetIndexJobSchema = z.object({
  job_id: z.string().min(1).describe('Indexing job ID to inspect. Obtain from the JSON response of index_code. Required. Example: "cm2abc123". This tool is pure-read — it never advances the job; use index_code_continue for that.')
})

export async function getIndexJobHandler(raw: unknown) {
  const { job_id } = GetIndexJobSchema.parse(raw)
  const job = await apiGet(`/code-graph/jobs/${job_id}`)
  return { content: [{ type: 'text' as const, text: JSON.stringify(job) }] }
}
