import { z } from 'zod'
import { apiGet } from '../code-index/api-client.js'

export const ExplainCodebaseSchema = z.object({
  repo_id: z.string().min(1).describe('CodeRepo id (from index_code / list_snapshots). The repo whose graph you want narrated.'),
  snapshot_id: z.string().optional().describe('Specific snapshot to explain. Defaults to the latest snapshot for the repo.'),
  format: z.enum(['markdown', 'json']).default('markdown').describe('"markdown" (default) returns an agent-ready narrative walkthrough. "json" returns the structured aggregation for downstream tooling.')
})

// The markdown endpoint returns raw markdown text, NOT JSON. The JSON endpoint
// returns a structured object. We transparently pass both through as the `text`
// of a single content block so the calling agent can read either shape.
async function fetchRaw(path: string): Promise<string> {
  // Reach into the api-client pattern: same auth + base URL, but we want the
  // raw response body (markdown) instead of JSON. Duplicate just the auth step.
  const { getCredentials } = await import('../../auth.js')
  const creds = await getCredentials()
  if (!creds) throw new Error('not authenticated')
  const API_URL = process.env.API_URL || 'https://trytentra.com/api'
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Authorization': `Bearer ${creds.apiKey}` }
  })
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
  return res.text()
}

export async function explainCodebaseHandler(raw: unknown) {
  const args = ExplainCodebaseSchema.parse(raw)
  const params = new URLSearchParams({ format: args.format })
  if (args.snapshot_id) params.set('snapshot_id', args.snapshot_id)
  const path = `/code-graph/query/explain/${encodeURIComponent(args.repo_id)}?${params}`

  if (args.format === 'markdown') {
    const text = await fetchRaw(path)
    return { content: [{ type: 'text' as const, text }] }
  }
  const data = await apiGet(path)
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}
