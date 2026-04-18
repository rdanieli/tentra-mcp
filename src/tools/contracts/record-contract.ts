import { z } from 'zod'
import { apiPost } from '../code-index/api-client.js'

export const RecordContractSchema = z.object({
  workspace_id: z.string().min(1).describe('Workspace to store contract in'),
  kind: z.enum(['http', 'grpc', 'event', 'graphql', 'rabbit', 'kafka'])
    .describe('Contract type — matches the parser output kind'),
  name: z.string().min(1).describe('Human-readable contract name (e.g. "Payment Service API")'),
  version: z.string().min(1).describe('Contract version (e.g. "1.2.0" or "payments.v1")'),
  spec_url: z.string().url().optional()
    .describe('Optional URL to the raw spec file (OpenAPI URL, proto repo link, etc.)'),
  schema: z.unknown().optional()
    .describe('Parsed schema snapshot as JSON — set by the contract parser (M4)')
})

export async function recordContractHandler(raw: unknown) {
  const args = RecordContractSchema.parse(raw)

  const result = await apiPost<{ id: string; name: string; kind: string }>(
    '/code-graph/contracts',
    {
      workspace_id: args.workspace_id,
      kind: args.kind,
      name: args.name,
      version: args.version,
      spec_url: args.spec_url,
      schema: args.schema
    }
  )

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ ok: true, contract_id: result.id, name: result.name, kind: result.kind })
    }]
  }
}
