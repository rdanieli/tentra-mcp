import { getCredentials } from '../../auth.js'

const API_URL = process.env.API_URL || 'https://trytentra.com/api'

async function authHeaders(): Promise<Record<string, string>> {
  const creds = await getCredentials()
  if (!creds) throw new Error('not authenticated')
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${creds.apiKey}` }
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers: await authHeaders(), body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { method: 'PATCH', headers: await authHeaders(), body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { headers: await authHeaders() })
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}
