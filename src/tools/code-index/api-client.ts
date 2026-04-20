import { getCredentials } from '../../auth.js'

// Read TENTRA_BACKEND on every access rather than caching at module load. The
// bin launcher (bin/tentra-mcp.js) may set TENTRA_BACKEND=local AFTER this
// module is pulled into the bundle graph, depending on how the bundler hoists
// imports. Keeping this as a getter-shaped export means the first tool call
// sees the right value regardless of evaluation order.
export function currentBackend(): 'hosted' | 'local' {
  return (process.env.TENTRA_BACKEND || 'hosted') as 'hosted' | 'local'
}
// Back-compat alias for tools that referenced the old constant.
export const BACKEND = currentBackend()

const API_URL = process.env.API_URL || 'https://trytentra.com/api'

/**
 * Cloud-required guard for tier-2 tool handlers.
 *
 * Many tools do post-processing on the response shape (`result.id`, `data.contracts.length`).
 * When the local dispatcher short-circuits to `{ error, scope }`, those dereferences crash
 * and the MCP server returns an isError text instead of a structured JSON payload.
 *
 * Call this helper FIRST in every tier-2 tool handler: if it returns a non-null value,
 * return that value straight out of the handler. Otherwise fall through to the hosted
 * api-client path.
 *
 * Returns a canonical MCP tool result whose `content[0].text` is a JSON string matching
 * the `{ error, scope }` shape the rest of the codebase (and the smoke tests) expect.
 */
export function localCloudRequiredContent(scope: string) {
  if (currentBackend() !== 'local') return null
  const payload = {
    error: 'Requires hosted mode. See trytentra.com/docs/local.',
    scope
  }
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(payload)
    }]
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const creds = await getCredentials()
  if (!creds) throw new Error('not authenticated')
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${creds.apiKey}` }
}

// Lazy-import the local dispatcher only when TENTRA_BACKEND=local so the hosted
// path never loads better-sqlite3 (native module) or the local handlers file.
async function localDispatch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const mod = await import('../../local/handlers.js')
  return mod.localDispatch<T>(method, path, body)
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  if (currentBackend() === 'local') return localDispatch<T>('POST', path, body)
  const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers: await authHeaders(), body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  if (currentBackend() === 'local') return localDispatch<T>('PATCH', path, body)
  const res = await fetch(`${API_URL}${path}`, { method: 'PATCH', headers: await authHeaders(), body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function apiGet<T>(path: string): Promise<T> {
  if (currentBackend() === 'local') return localDispatch<T>('GET', path)
  const res = await fetch(`${API_URL}${path}`, { headers: await authHeaders() })
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}
