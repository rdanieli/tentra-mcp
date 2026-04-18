import { z } from 'zod'
import { apiGet } from '../code-index/api-client.js'

export const ListGodNodesSchema = z.object({
  repo_id: z.string().optional().describe('Repo ID (uses latest snapshot)'),
  snapshot_id: z.string().optional().describe('Specific snapshot ID'),
  exclude_tests: z.boolean().default(true).describe('Hide symbols defined in test/fixture files (default true). Test helpers like `request`, `makeService`, `createApp` otherwise dominate god-node rankings.'),
  top_n: z.number().int().positive().max(50).default(20).describe('Max god nodes to return')
})

export async function listGodNodesHandler(raw: unknown) {
  const args = ListGodNodesSchema.parse(raw)
  const params = new URLSearchParams({
    top_n: String(args.top_n),
    exclude_tests: String(args.exclude_tests)
  })
  if (args.repo_id) params.set('repo_id', args.repo_id)
  if (args.snapshot_id) params.set('snapshot_id', args.snapshot_id)

  const data = await apiGet(`/code-graph/query/god-nodes?${params}`)
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}
