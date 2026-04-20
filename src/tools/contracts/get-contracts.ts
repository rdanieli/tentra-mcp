import { z } from 'zod'
import { apiGet, localCloudRequiredContent } from '../code-index/api-client.js'

export const GetContractsSchema = z.object({
  workspace_id: z.string().min(1).describe('Workspace to list contracts for'),
  kind: z.enum(['http', 'grpc', 'event', 'graphql', 'rabbit', 'kafka']).optional()
    .describe('Filter by contract kind — omit to return all kinds')
})

export async function getContractsHandler(raw: unknown) {
  const args = GetContractsSchema.parse(raw)
  const guard = localCloudRequiredContent('contracts')
  if (guard) return guard

  const params = new URLSearchParams({ workspace_id: args.workspace_id })
  if (args.kind) params.set('kind', args.kind)

  const data = await apiGet<{
    contracts: Array<{
      id: string
      name: string
      kind: string
      version: string
      specUrl: string | null
      createdAt: string
      _count: { bindings: number }
    }>
  }>(`/code-graph/contracts?${params}`)

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ contracts: data.contracts, total: data.contracts.length })
    }]
  }
}
