import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { scanCodebase } from '../scanner.js'
import { tmpdir } from 'os'

describe('scanCodebase (integration)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(tmpdir(), `archflow-test-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('should detect services from package.json and docker-compose in a mock project', async () => {
    // Create a mock project structure
    const apiDir = join(tempDir, 'services', 'api')
    mkdirSync(apiDir, { recursive: true })

    writeFileSync(
      join(apiDir, 'package.json'),
      JSON.stringify({
        name: 'my-api',
        dependencies: {
          express: '^4.18.0',
          prisma: '^5.0.0',
        },
      })
    )

    writeFileSync(
      join(tempDir, 'docker-compose.yml'),
      `services:
  db:
    image: postgres:16
    ports:
      - "5432:5432"
  cache:
    image: redis:7
`
    )

    const result = await scanCodebase(tempDir)

    // Should detect the Express API service
    const api = result.services.find(s => s.id === 'my_api')
    expect(api).toBeDefined()
    expect(api!.type).toBe('service')

    // Should detect PostgreSQL from docker-compose
    const db = result.services.find(s => s.name === 'PostgreSQL')
    expect(db).toBeDefined()
    expect(db!.type).toBe('database')

    // Should detect Redis from docker-compose
    const redis = result.services.find(s => s.name === 'Redis')
    expect(redis).toBeDefined()
    expect(redis!.type).toBe('database')

    // Should have some connections (e.g., api -> postgresql via prisma)
    expect(result.connections.length).toBeGreaterThanOrEqual(1)

    // Metadata should be populated
    expect(result.metadata.rootPath).toBe(tempDir)
    expect(result.metadata.scannedFiles).toBeGreaterThanOrEqual(2)
    expect(result.metadata.detectedServices).toBeGreaterThanOrEqual(3)
  })
})
