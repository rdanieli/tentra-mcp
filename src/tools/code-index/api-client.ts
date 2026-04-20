import { getCredentials } from '../../auth.js'

export const BACKEND = (process.env.TENTRA_BACKEND || 'hosted') as 'hosted' | 'local'

const API_URL = process.env.API_URL || 'https://trytentra.com/api'

const LOCAL_NOT_IMPLEMENTED =
  'Local backend not implemented in this version. Run without --local, or wait for tentra-mcp@1.3.0.'

async function authHeaders(): Promise<Record<string, string>> {
  const creds = await getCredentials()
  if (!creds) throw new Error('not authenticated')
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${creds.apiKey}` }
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  if (BACKEND === 'local') throw new Error(LOCAL_NOT_IMPLEMENTED)
  const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers: await authHeaders(), body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  if (BACKEND === 'local') throw new Error(LOCAL_NOT_IMPLEMENTED)
  const res = await fetch(`${API_URL}${path}`, { method: 'PATCH', headers: await authHeaders(), body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function apiGet<T>(path: string): Promise<T> {
  if (BACKEND === 'local') throw new Error(LOCAL_NOT_IMPLEMENTED)
  const res = await fetch(`${API_URL}${path}`, { headers: await authHeaders() })
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}
