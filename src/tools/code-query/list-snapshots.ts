import { z } from 'zod'
import { apiGet } from '../code-index/api-client.js'

export const ListSnapshotsSchema = z.object({
  repo_id: z.string().min(1).describe('Stable repo identifier — same value you passed to index_code (e.g. "acme/api" or "repo_github_owner_name"). Required. Lists every snapshot stored under this repo_id, newest first.')
})

export async function listSnapshotsHandler(raw: unknown) {
  const args = ListSnapshotsSchema.parse(raw)
  const data = await apiGet(`/code-graph/query/snapshots/${args.repo_id}`)
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}
