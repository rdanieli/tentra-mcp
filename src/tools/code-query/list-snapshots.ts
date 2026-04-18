import { z } from 'zod'
import { apiGet } from '../code-index/api-client.js'

export const ListSnapshotsSchema = z.object({
  repo_id: z.string().min(1).describe('Repo ID to list snapshots for')
})

export async function listSnapshotsHandler(raw: unknown) {
  const args = ListSnapshotsSchema.parse(raw)
  const data = await apiGet(`/code-graph/query/snapshots/${args.repo_id}`)
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}
