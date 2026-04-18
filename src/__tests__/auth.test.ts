import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFile, writeFile, unlink, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

describe('auth module', () => {
  const testDir = join(tmpdir(), `tentra-test-${Date.now()}`)
  const testCredsPath = join(testDir, 'credentials')

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true })
    delete process.env.TENTRA_API_KEY
  })

  afterEach(async () => {
    try { await unlink(testCredsPath) } catch {}
  })

  describe('getCredentials', () => {
    it('should return env var API key when TENTRA_API_KEY is set', async () => {
      process.env.TENTRA_API_KEY = 'tk_envkey123'
      const { getCredentials } = await import('../auth.js')
      const creds = await getCredentials(testCredsPath)
      expect(creds).toEqual({ apiKey: 'tk_envkey123', apiUrl: 'https://trytentra.com/api' })
    })

    it('should return credentials from file when env var is not set', async () => {
      await writeFile(testCredsPath, JSON.stringify({
        api_url: 'https://trytentra.com/api',
        api_key: 'tk_filekey456',
        username: 'testuser',
        created_at: '2026-04-02T00:00:00Z'
      }))

      const mod = await import('../auth.js')
      const creds = await mod.getCredentials(testCredsPath)
      expect(creds).toEqual({ apiKey: 'tk_filekey456', apiUrl: 'https://trytentra.com/api' })
    })

    it('should return null when no env var and no file', async () => {
      const { getCredentials } = await import('../auth.js')
      const creds = await getCredentials(join(testDir, 'nonexistent'))
      expect(creds).toBeNull()
    })

    it('should return null when file contains invalid JSON', async () => {
      await writeFile(testCredsPath, 'not json')
      const { getCredentials } = await import('../auth.js')
      const creds = await getCredentials(testCredsPath)
      expect(creds).toBeNull()
    })
  })

  describe('writeCredentials', () => {
    it('should write credentials atomically', async () => {
      const { writeCredentials } = await import('../auth.js')
      await writeCredentials(testCredsPath, {
        api_url: 'https://trytentra.com/api',
        api_key: 'tk_written789',
        username: 'testuser',
        created_at: '2026-04-02T00:00:00Z'
      })

      const content = JSON.parse(await readFile(testCredsPath, 'utf-8'))
      expect(content.api_key).toBe('tk_written789')
      expect(content.username).toBe('testuser')
    })
  })

  describe('deleteCredentials', () => {
    it('should delete the credentials file', async () => {
      await writeFile(testCredsPath, '{}')
      const { deleteCredentials } = await import('../auth.js')
      await deleteCredentials(testCredsPath)

      const { getCredentials } = await import('../auth.js')
      const creds = await getCredentials(testCredsPath)
      expect(creds).toBeNull()
    })

    it('should not throw if file does not exist', async () => {
      const { deleteCredentials } = await import('../auth.js')
      await expect(deleteCredentials(join(testDir, 'nope'))).resolves.not.toThrow()
    })
  })
})
