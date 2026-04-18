import { readFile, writeFile, unlink, rename, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'

const API_URL = process.env.API_URL || 'https://trytentra.com/api'
const DEFAULT_CREDS_PATH = join(homedir(), '.tentra', 'credentials')

export interface Credentials {
  apiKey: string
  apiUrl: string
}

export interface CredentialsFile {
  api_url: string
  api_key: string
  username: string
  created_at: string
}

export async function getCredentials(credsPath: string = DEFAULT_CREDS_PATH): Promise<Credentials | null> {
  const envKey = process.env.TENTRA_API_KEY
  if (envKey) {
    return { apiKey: envKey, apiUrl: API_URL }
  }

  try {
    const content = await readFile(credsPath, 'utf-8')
    const data: CredentialsFile = JSON.parse(content)
    if (data.api_key) {
      return { apiKey: data.api_key, apiUrl: data.api_url || API_URL }
    }
  } catch {
    // File doesn't exist or invalid JSON
  }

  return null
}

export async function writeCredentials(credsPath: string = DEFAULT_CREDS_PATH, data: CredentialsFile): Promise<void> {
  await mkdir(dirname(credsPath), { recursive: true })
  const tmpPath = `${credsPath}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  await rename(tmpPath, credsPath)
}

export async function deleteCredentials(credsPath: string = DEFAULT_CREDS_PATH): Promise<void> {
  try {
    await unlink(credsPath)
  } catch {
    // File doesn't exist — fine
  }
}
