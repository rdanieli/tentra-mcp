import { z } from 'zod'
import { apiGet } from '../code-index/api-client.js'

export const SafeRenameSchema = z.object({
  symbol_id: z.string().min(1).describe('Symbol ID to rename, from query_symbols. The target whose declaration AND every call site will be included in the plan.'),
  new_name: z.string().min(1).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
    message: 'new_name must be a valid identifier (letters, digits, underscores; cannot start with a digit)'
  }).describe('New identifier for the symbol. Must be a valid identifier: letters, digits, underscores only, cannot start with a digit. Whitespace and special characters are rejected.'),
  snapshot_id: z.string().min(1).describe('Snapshot the symbol lives in, from index_code / list_snapshots.'),
  include_tests: z.boolean().default(true).describe('Include references from test/fixture files. Default true — safe renames almost always need to cover tests too, otherwise they break CI.'),
  include_unresolved: z.boolean().default(false).describe('Also include best-effort short-name matches the call-graph resolver could not prove target this symbol. Default false — enable only if you want broader coverage and are willing to review each unresolved hit manually.')
})

export async function safeRenameHandler(raw: unknown) {
  const args = SafeRenameSchema.parse(raw)
  const params = new URLSearchParams({
    snapshot_id: args.snapshot_id,
    new_name: args.new_name,
    include_unresolved: String(args.include_unresolved),
    include_tests: String(args.include_tests)
  })
  const data = await apiGet(`/code-graph/query/safe-rename/${encodeURIComponent(args.symbol_id)}?${params}`)
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}
