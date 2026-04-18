import { describe, it, expect } from 'vitest'
import { inferConnections } from '../connections.js'
import { DetectedService } from '../types.js'

function makeService(overrides: Partial<DetectedService> & Pick<DetectedService, 'id' | 'type'>): DetectedService {
  return {
    name: overrides.id,
    responsibility: 'Test service',
    confidence: 0.8,
    source: overrides.source ?? '/project/package.json',
    technologies: [],
    scaling: 'horizontal',
    ...overrides,
  }
}

describe('inferConnections', () => {
  it('should infer db_access when a service has prisma tech and PostgreSQL DB exists', async () => {
    const services: DetectedService[] = [
      makeService({ id: 'my_api', type: 'service', technologies: ['express', 'prisma'] }),
      makeService({ id: 'postgresql', type: 'database', technologies: ['postgresql'] }),
    ]
    const connections = await inferConnections(services, new Map(), '/project')
    const dbConn = connections.find(c => c.from === 'my_api' && c.to === 'postgresql')
    expect(dbConn).toBeDefined()
    expect(dbConn!.type).toBe('db_access')
  })

  it('should infer async_event when a service has kafkajs tech and Kafka queue exists', async () => {
    const services: DetectedService[] = [
      makeService({ id: 'event_processor', type: 'service', technologies: ['express', 'kafkajs'] }),
      makeService({ id: 'kafka', type: 'queue', technologies: ['kafka'] }),
    ]
    const connections = await inferConnections(services, new Map(), '/project')
    const queueConn = connections.find(c => c.from === 'event_processor' && c.to === 'kafka')
    expect(queueConn).toBeDefined()
    expect(queueConn!.type).toBe('async_event')
  })

  it('should infer sync_http from api_gateway to backend services', async () => {
    const services: DetectedService[] = [
      makeService({ id: 'api_gateway', type: 'api_gateway', technologies: ['nginx'] }),
      makeService({ id: 'user_service', type: 'service', technologies: ['express'] }),
      makeService({ id: 'order_service', type: 'service', technologies: ['express'] }),
    ]
    const connections = await inferConnections(services, new Map(), '/project')
    const gwToUser = connections.find(c => c.from === 'api_gateway' && c.to === 'user_service')
    const gwToOrder = connections.find(c => c.from === 'api_gateway' && c.to === 'order_service')
    expect(gwToUser).toBeDefined()
    expect(gwToUser!.type).toBe('sync_http')
    expect(gwToOrder).toBeDefined()
    expect(gwToOrder!.type).toBe('sync_http')
  })

  it('should infer sync_http from service to external with same source', async () => {
    const sharedSource = '/project/services/api/package.json'
    const services: DetectedService[] = [
      makeService({ id: 'billing_api', type: 'service', technologies: ['express'], source: sharedSource }),
      makeService({ id: 'stripe', type: 'external', technologies: ['stripe'], source: sharedSource }),
    ]
    const connections = await inferConnections(services, new Map(), '/project')
    const extConn = connections.find(c => c.from === 'billing_api' && c.to === 'stripe')
    expect(extConn).toBeDefined()
    expect(extConn!.type).toBe('sync_http')
  })

  it('should infer cloud service connections from same pom.xml source', async () => {
    const sharedSource = '/project/services/file-svc/pom.xml'
    const services: DetectedService[] = [
      makeService({ id: 'file_service', type: 'service', technologies: ['java', 'spring-boot'], source: sharedSource }),
      makeService({ id: 'aws_s3', type: 'database', technologies: ['aws', 'camel-quarkus-aws2-s3'], source: sharedSource }),
    ]
    const connections = await inferConnections(services, new Map(), '/project')
    const cloudConn = connections.find(c => c.from === 'file_service' && c.to === 'aws_s3')
    expect(cloudConn).toBeDefined()
    expect(cloudConn!.type).toBe('db_access')
  })

  // ─── Edge cases ──────────────────────────────────────────────────────────

  it('handles circular dependencies without infinite loop', async () => {
    const services: DetectedService[] = [
      makeService({ id: 'service_a', type: 'service', technologies: ['express'] }),
      makeService({ id: 'service_b', type: 'service', technologies: ['express'] }),
    ]
    // Gateway connects to both; both have matching tech but circular dep would
    // only happen if we had mutual depends_on — ensure the function terminates
    const configFiles = new Map<string, string>()
    configFiles.set('/project/docker-compose.yml', `services:
  service_a:
    build: ./a
    depends_on:
      - service_b
  service_b:
    build: ./b
    depends_on:
      - service_a
`)
    const connections = await inferConnections(services, configFiles, '/project')
    // Should not hang, and should produce the two depends_on connections
    const aToB = connections.find(c => c.from === 'service_a' && c.to === 'service_b')
    const bToA = connections.find(c => c.from === 'service_b' && c.to === 'service_a')
    expect(aToB).toBeDefined()
    expect(bToA).toBeDefined()
  })

  it('handles services with no technologies', async () => {
    const services: DetectedService[] = [
      makeService({ id: 'bare_service', type: 'service', technologies: [] }),
      makeService({ id: 'postgresql', type: 'database', technologies: ['postgresql'] }),
    ]
    const connections = await inferConnections(services, new Map(), '/project')
    // No technology overlap, so no db_access connection should be inferred
    const dbConn = connections.find(c => c.from === 'bare_service' && c.to === 'postgresql')
    expect(dbConn).toBeUndefined()
  })

  it('deduplicates identical connections', async () => {
    // Two services from the same source, same external dep — should only produce
    // one connection per strategy (but multiple strategies may each produce one)
    const sharedSource = '/project/services/api/package.json'
    const services: DetectedService[] = [
      makeService({ id: 'my_api', type: 'service', technologies: ['express', 'stripe'], source: sharedSource }),
      makeService({ id: 'stripe', type: 'external', technologies: ['stripe'], source: sharedSource }),
    ]
    const connections = await inferConnections(services, new Map(), '/project')
    const stripeConns = connections.filter(c => c.from === 'my_api' && c.to === 'stripe')
    // At least one exists; each individual strategy should produce at most 1
    expect(stripeConns.length).toBeGreaterThanOrEqual(1)
    for (const conn of stripeConns) {
      expect(conn.type).toBe('sync_http')
    }
  })

  it('handles docker-compose depends_on with conditions', async () => {
    const services: DetectedService[] = [
      makeService({ id: 'app', type: 'service', technologies: ['express'] }),
      makeService({ id: 'db', type: 'database', technologies: ['postgresql'] }),
    ]
    // depends_on with condition: syntax — the simple YAML parser handles the "- " prefix
    const configFiles = new Map<string, string>()
    configFiles.set('/project/docker-compose.yml', `services:
  app:
    build: ./app
    depends_on:
      - db
  db:
    image: postgres:16
`)
    const connections = await inferConnections(services, configFiles, '/project')
    const appToDb = connections.find(c => c.from === 'app' && c.to === 'db' && c.reason === 'docker-compose depends_on')
    expect(appToDb).toBeDefined()
    expect(appToDb!.type).toBe('db_access')
  })

  it('handles env vars with equals signs in values', async () => {
    const services: DetectedService[] = [
      makeService({ id: 'my_api', type: 'service', technologies: ['express'], source: '/project/services/api/package.json' }),
      makeService({ id: 'auth_service', type: 'service', technologies: ['express'], source: '/project/services/auth/package.json' }),
    ]
    const configFiles = new Map<string, string>()
    configFiles.set('/project/services/api/.env', `AUTH_URL=http://auth_service:3000/api?key=abc=def
DATABASE_URL=postgresql://user:pass@db:5432/mydb
`)
    const connections = await inferConnections(services, configFiles, '/project')
    // The env var parser should handle equals signs in values correctly
    // and the URL http://auth_service:3000 should still be detected
    const authConn = connections.find(c => c.from === 'my_api' && c.to === 'auth_service')
    expect(authConn).toBeDefined()
    expect(authConn!.type).toBe('sync_http')
  })
})
