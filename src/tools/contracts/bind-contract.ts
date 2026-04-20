import { z } from 'zod'
import { apiPost, localCloudRequiredContent } from '../code-index/api-client.js'

export const BindContractSchema = z.object({
  contract_id: z.string().min(1).describe('Contract ID (from record_contract result)'),
  symbol_id: z.string().min(1).describe('CodeSymbol ID that implements or consumes the contract'),
  snapshot_id: z.string().min(1).describe('Snapshot the symbol belongs to'),
  relation: z.enum(['provides', 'consumes', 'documents'])
    .describe('"provides" = symbol implements it, "consumes" = symbol calls it, "documents" = symbol describes it')
})

export async function bindContractHandler(raw: unknown) {
  const args = BindContractSchema.parse(raw)
  const guard = localCloudRequiredContent('contracts')
  if (guard) return guard

  const result = await apiPost<{ id: string; relation: string }>(
    `/code-graph/contracts/${args.contract_id}/bindings`,
    {
      symbol_id: args.symbol_id,
      snapshot_id: args.snapshot_id,
      relation: args.relation
    }
  )

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ ok: true, binding_id: result.id, relation: result.relation })
    }]
  }
}
