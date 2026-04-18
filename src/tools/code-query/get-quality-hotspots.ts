import { z } from 'zod'
import { apiGet } from '../code-index/api-client.js'

export const GetQualityHotspotsSchema = z.object({
  repo_id: z.string().optional().describe('Repo ID (uses latest snapshot)'),
  snapshot_id: z.string().optional().describe('Specific snapshot ID'),
  top_n: z.number().int().positive().max(50).default(20)
    .describe('Max hotspots to return, ranked by churn × complexity × (1-coverage)')
})

export async function getQualityHotspotsHandler(raw: unknown) {
  const args = GetQualityHotspotsSchema.parse(raw)
  const params = new URLSearchParams({ top_n: String(args.top_n) })
  if (args.repo_id) params.set('repo_id', args.repo_id)
  if (args.snapshot_id) params.set('snapshot_id', args.snapshot_id)

  const data = await apiGet(`/code-graph/query/quality-hotspots?${params}`)
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}
