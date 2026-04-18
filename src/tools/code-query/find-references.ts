import { z } from 'zod'
import { apiGet } from '../code-index/api-client.js'

export const FindReferencesSchema = z.object({
  symbol_id: z.string().min(1).describe('Symbol ID whose references to find (from query_symbols)'),
  snapshot_id: z.string().min(1).describe('Snapshot ID to query against'),
  include_unresolved: z.boolean().default(false).describe('Also include unresolved callers (matched by short name but not by graph). Noisy — leave off for rename plans, enable for broad audits.'),
  include_tests: z.boolean().default(true).describe('Include references from test/fixture files (default true). Safe renames usually need these.'),
  limit: z.number().int().positive().max(500).default(200).describe('Max references per bucket (resolved / unresolved)')
})

export async function findReferencesHandler(raw: unknown) {
  const args = FindReferencesSchema.parse(raw)
  const params = new URLSearchParams({
    snapshot_id: args.snapshot_id,
    include_unresolved: String(args.include_unresolved),
    include_tests: String(args.include_tests),
    limit: String(args.limit)
  })
  const data = await apiGet(`/code-graph/query/references/${encodeURIComponent(args.symbol_id)}?${params}`)
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}
