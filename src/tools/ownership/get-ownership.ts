import { z } from 'zod'
import { apiGet } from '../code-index/api-client.js'

export const GetOwnershipSchema = z.object({
  workspace_id: z.string().min(1).describe('Workspace to query ownership rules from'),
  path: z.string().min(1)
    .describe('Relative file path to resolve ownership for (e.g. "packages/api/src/index.ts")')
})

export async function getOwnershipHandler(raw: unknown) {
  const args = GetOwnershipSchema.parse(raw)

  const encoded = encodeURIComponent(args.path)
  const params = new URLSearchParams({ workspace_id: args.workspace_id })
  const data = await apiGet<{ path: string; owners: string[] }>(
    `/code-graph/ownership/${encoded}?${params}`
  )

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ path: data.path, owners: data.owners })
    }]
  }
}
