import { describe, it, expect } from 'vitest'
import { lintArchitecture } from '../lint.js'

describe('lintArchitecture', () => {
  it('should warn about orphan nodes (no connections)', () => {
    const services = [
      { id: 'api', name: 'API', type: 'service', responsibility: 'REST API' },
      { id: 'orphan', name: 'Orphan', type: 'service', responsibility: 'Lonely service' },
    ]
    const connections = [{ from: 'api', to: 'db', type: 'db_access' }]
    // Note: orphan and db are relevant — orphan is not in connections at all
    // db is in connections but not in services, but lint only checks services in connections
    const issues = lintArchitecture(services, connections)
    const orphanIssue = issues.find(i => i.rule === 'orphan-node' && i.serviceId === 'orphan')
    expect(orphanIssue).toBeDefined()
    expect(orphanIssue!.severity).toBe('warning')
  })

  it('should error on duplicate connections', () => {
    const services = [
      { id: 'api', name: 'API', type: 'service', responsibility: 'REST API' },
      { id: 'db', name: 'DB', type: 'database', responsibility: 'Storage' },
    ]
    const connections = [
      { from: 'api', to: 'db', type: 'db_access' },
      { from: 'api', to: 'db', type: 'db_access' },
    ]
    const issues = lintArchitecture(services, connections)
    const dupIssue = issues.find(i => i.rule === 'duplicate-connection')
    expect(dupIssue).toBeDefined()
    expect(dupIssue!.severity).toBe('error')
  })

  it('should warn about non-snake_case IDs', () => {
    const services = [
      { id: 'myService', name: 'My Service', type: 'service', responsibility: 'Does things' },
    ]
    const connections = [{ from: 'myService', to: 'db', type: 'db_access' }]
    const issues = lintArchitecture(services, connections)
    const namingIssue = issues.find(i => i.rule === 'naming-convention' && i.serviceId === 'myService')
    expect(namingIssue).toBeDefined()
    expect(namingIssue!.severity).toBe('warning')
  })

  it('should warn about generic responsibility "service"', () => {
    const services = [
      { id: 'payment', name: 'Payment', type: 'service', responsibility: 'Service' },
    ]
    const connections = [{ from: 'payment', to: 'db', type: 'db_access' }]
    const issues = lintArchitecture(services, connections)
    const weakIssue = issues.find(i => i.rule === 'weak-responsibility' && i.serviceId === 'payment')
    expect(weakIssue).toBeDefined()
    expect(weakIssue!.severity).toBe('warning')
  })

  it('should warn about single point of failure (5 dependents, no horizontal scaling)', () => {
    const services = [
      { id: 'core_db', name: 'Core DB', type: 'database', responsibility: 'Main database', scaling: 'vertical' },
      { id: 'svc_a', name: 'A', type: 'service', responsibility: 'A' },
      { id: 'svc_b', name: 'B', type: 'service', responsibility: 'B' },
      { id: 'svc_c', name: 'C', type: 'service', responsibility: 'C' },
      { id: 'svc_d', name: 'D', type: 'service', responsibility: 'D' },
      { id: 'svc_e', name: 'E', type: 'service', responsibility: 'E' },
    ]
    const connections = [
      { from: 'svc_a', to: 'core_db', type: 'db_access' },
      { from: 'svc_b', to: 'core_db', type: 'db_access' },
      { from: 'svc_c', to: 'core_db', type: 'db_access' },
      { from: 'svc_d', to: 'core_db', type: 'db_access' },
      { from: 'svc_e', to: 'core_db', type: 'db_access' },
    ]
    const issues = lintArchitecture(services, connections)
    const spofIssue = issues.find(i => i.rule === 'spof' && i.serviceId === 'core_db')
    expect(spofIssue).toBeDefined()
    expect(spofIssue!.severity).toBe('warning')
    expect(spofIssue!.message).toContain('5 dependents')
  })

  it('should warn about god-service with many connections', () => {
    // god-service threshold is max(6, services.length * 0.6)
    // With 8 services: threshold = max(6, 4.8) = 6
    // We need a service with >= 6 total connections (from + to)
    const services = [
      { id: 'god', name: 'God', type: 'service', responsibility: 'Does everything' },
      { id: 'a', name: 'A', type: 'service', responsibility: 'A' },
      { id: 'b', name: 'B', type: 'service', responsibility: 'B' },
      { id: 'c', name: 'C', type: 'service', responsibility: 'C' },
      { id: 'd', name: 'D', type: 'service', responsibility: 'D' },
      { id: 'e', name: 'E', type: 'service', responsibility: 'E' },
      { id: 'f', name: 'F', type: 'service', responsibility: 'F' },
    ]
    // god has 7 connections total (from god to a,b,c,d,e,f and one from e to god)
    // threshold = max(6, 7 * 0.6) = max(6, 4.2) = 6
    const connections = [
      { from: 'god', to: 'a', type: 'sync_http' },
      { from: 'god', to: 'b', type: 'sync_http' },
      { from: 'god', to: 'c', type: 'sync_http' },
      { from: 'god', to: 'd', type: 'sync_http' },
      { from: 'god', to: 'e', type: 'sync_http' },
      { from: 'god', to: 'f', type: 'sync_http' },
    ]
    const issues = lintArchitecture(services, connections)
    const godIssue = issues.find(i => i.rule === 'god-service' && i.serviceId === 'god')
    expect(godIssue).toBeDefined()
    expect(godIssue!.severity).toBe('warning')
  })

  it('should info when no database is present', () => {
    const services = [
      { id: 'api', name: 'API', type: 'service', responsibility: 'REST API' },
      { id: 'worker', name: 'Worker', type: 'service', responsibility: 'Background worker' },
    ]
    const connections = [{ from: 'api', to: 'worker', type: 'sync_http' }]
    const issues = lintArchitecture(services, connections)
    const noDbIssue = issues.find(i => i.rule === 'no-database')
    expect(noDbIssue).toBeDefined()
    expect(noDbIssue!.severity).toBe('info')
  })

  it('should info about all-sync architecture when >= 6 sync connections and no async', () => {
    const services = [
      { id: 'gw', name: 'Gateway', type: 'api_gateway', responsibility: 'Routing' },
      { id: 'a', name: 'A', type: 'service', responsibility: 'A' },
      { id: 'b', name: 'B', type: 'service', responsibility: 'B' },
      { id: 'c', name: 'C', type: 'service', responsibility: 'C' },
      { id: 'd', name: 'D', type: 'service', responsibility: 'D' },
      { id: 'e', name: 'E', type: 'service', responsibility: 'E' },
      { id: 'f', name: 'F', type: 'service', responsibility: 'F' },
    ]
    const connections = [
      { from: 'gw', to: 'a', type: 'sync_http' },
      { from: 'gw', to: 'b', type: 'sync_http' },
      { from: 'a', to: 'c', type: 'sync_http' },
      { from: 'b', to: 'd', type: 'sync_http' },
      { from: 'c', to: 'e', type: 'sync_http' },
      { from: 'd', to: 'f', type: 'sync_http' },
    ]
    const issues = lintArchitecture(services, connections)
    const syncIssue = issues.find(i => i.rule === 'all-sync')
    expect(syncIssue).toBeDefined()
    expect(syncIssue!.severity).toBe('info')
  })

  it('should info about grouping when > 8 services', () => {
    const services = Array.from({ length: 9 }, (_, i) => ({
      id: `svc_${i}`,
      name: `Service ${i}`,
      type: 'service',
      responsibility: `Handles domain ${i}`,
    }))
    const connections = services.slice(1).map(s => ({
      from: 'svc_0', to: s.id, type: 'sync_http',
    }))
    const issues = lintArchitecture(services, connections)
    const groupIssue = issues.find(i => i.rule === 'too-many-services')
    expect(groupIssue).toBeDefined()
    expect(groupIssue!.severity).toBe('info')
  })

  // ─── Edge cases ──────────────────────────────────────────────────────────

  it('handles empty services array without crashing', () => {
    const issues = lintArchitecture([], [])
    // Should return an array (possibly empty) and not throw
    expect(Array.isArray(issues)).toBe(true)
    // No services => no orphan, no naming, no responsibility, no god-service, no too-many-services
    // No services of type 'service' => no no-database info either
    expect(issues.filter(i => i.rule === 'orphan-node')).toHaveLength(0)
    expect(issues.filter(i => i.rule === 'naming-convention')).toHaveLength(0)
  })

  it('handles empty connections array without crashing', () => {
    const services = [
      { id: 'api', name: 'API', type: 'service', responsibility: 'REST API' },
    ]
    const issues = lintArchitecture(services, [])
    // api should be an orphan node since there are no connections
    const orphanIssue = issues.find(i => i.rule === 'orphan-node' && i.serviceId === 'api')
    expect(orphanIssue).toBeDefined()
    expect(orphanIssue!.severity).toBe('warning')
    // With one service and no database, expect no-database info
    const noDb = issues.find(i => i.rule === 'no-database')
    expect(noDb).toBeDefined()
  })

  it('handles services with undefined scaling', () => {
    const services = [
      { id: 'core_db', name: 'Core DB', type: 'database', responsibility: 'Main database' },
      { id: 'svc_a', name: 'A', type: 'service', responsibility: 'A' },
      { id: 'svc_b', name: 'B', type: 'service', responsibility: 'B' },
      { id: 'svc_c', name: 'C', type: 'service', responsibility: 'C' },
    ]
    const connections = [
      { from: 'svc_a', to: 'core_db', type: 'db_access' },
      { from: 'svc_b', to: 'core_db', type: 'db_access' },
      { from: 'svc_c', to: 'core_db', type: 'db_access' },
    ]
    // core_db has no scaling field (undefined) — should still trigger SPOF since 3 >= 3
    const issues = lintArchitecture(services, connections)
    const spof = issues.find(i => i.rule === 'spof' && i.serviceId === 'core_db')
    expect(spof).toBeDefined()
    expect(spof!.severity).toBe('warning')
    expect(spof!.message).toContain('3 dependents')
  })

  it('handles responsibility with only whitespace', () => {
    const services = [
      { id: 'payment', name: 'Payment', type: 'service', responsibility: '   ' },
    ]
    const connections = [{ from: 'payment', to: 'db', type: 'db_access' }]
    const issues = lintArchitecture(services, connections)
    // '   '.toLowerCase().trim() === '' which is in the generic list
    const weakIssue = issues.find(i => i.rule === 'weak-responsibility' && i.serviceId === 'payment')
    expect(weakIssue).toBeDefined()
    expect(weakIssue!.severity).toBe('warning')
  })

  it('does not flag database as god-service even with many connections', () => {
    const services = [
      { id: 'main_db', name: 'Main DB', type: 'database', responsibility: 'Primary storage' },
      { id: 'a', name: 'A', type: 'service', responsibility: 'A' },
      { id: 'b', name: 'B', type: 'service', responsibility: 'B' },
      { id: 'c', name: 'C', type: 'service', responsibility: 'C' },
      { id: 'd', name: 'D', type: 'service', responsibility: 'D' },
      { id: 'e', name: 'E', type: 'service', responsibility: 'E' },
      { id: 'f', name: 'F', type: 'service', responsibility: 'F' },
    ]
    const connections = [
      { from: 'a', to: 'main_db', type: 'db_access' },
      { from: 'b', to: 'main_db', type: 'db_access' },
      { from: 'c', to: 'main_db', type: 'db_access' },
      { from: 'd', to: 'main_db', type: 'db_access' },
      { from: 'e', to: 'main_db', type: 'db_access' },
      { from: 'f', to: 'main_db', type: 'db_access' },
    ]
    const issues = lintArchitecture(services, connections)
    const godIssue = issues.find(i => i.rule === 'god-service' && i.serviceId === 'main_db')
    expect(godIssue).toBeUndefined()
  })

  // ─── Rule 10: Circular Dependencies ────────────────────────────────────

  it('should warn about circular dependencies (A → B → C → A)', () => {
    const services = [
      { id: 'a', name: 'A', type: 'service', responsibility: 'Service A' },
      { id: 'b', name: 'B', type: 'service', responsibility: 'Service B' },
      { id: 'c', name: 'C', type: 'service', responsibility: 'Service C' },
    ]
    const connections = [
      { from: 'a', to: 'b', type: 'sync_http' },
      { from: 'b', to: 'c', type: 'sync_http' },
      { from: 'c', to: 'a', type: 'sync_http' },
    ]
    const issues = lintArchitecture(services, connections)
    const cycleIssue = issues.find(i => i.rule === 'circular-dependency')
    expect(cycleIssue).toBeDefined()
    expect(cycleIssue!.severity).toBe('warning')
    expect(cycleIssue!.message).toContain('Circular dependency detected')
  })

  it('should not warn about circular dependencies when none exist', () => {
    const services = [
      { id: 'a', name: 'A', type: 'service', responsibility: 'Service A' },
      { id: 'b', name: 'B', type: 'service', responsibility: 'Service B' },
      { id: 'c', name: 'C', type: 'service', responsibility: 'Service C' },
    ]
    const connections = [
      { from: 'a', to: 'b', type: 'sync_http' },
      { from: 'b', to: 'c', type: 'sync_http' },
    ]
    const issues = lintArchitecture(services, connections)
    const cycleIssue = issues.find(i => i.rule === 'circular-dependency')
    expect(cycleIssue).toBeUndefined()
  })

  // ─── Rule 11: Queue Without Dead Letter ─────────────────────────────────

  it('should info when queue has no dead-letter queue', () => {
    const services = [
      { id: 'order_queue', name: 'Order Queue', type: 'queue', responsibility: 'Order processing queue' },
      { id: 'api', name: 'API', type: 'service', responsibility: 'REST API' },
    ]
    const connections = [{ from: 'api', to: 'order_queue', type: 'async_event' }]
    const issues = lintArchitecture(services, connections)
    const dlqIssue = issues.find(i => i.rule === 'missing-dlq' && i.serviceId === 'order_queue')
    expect(dlqIssue).toBeDefined()
    expect(dlqIssue!.severity).toBe('info')
    expect(dlqIssue!.message).toContain('no dead-letter queue')
  })

  it('should not warn about missing DLQ when one exists', () => {
    const services = [
      { id: 'order_queue', name: 'Order Queue', type: 'queue', responsibility: 'Order processing queue' },
      { id: 'order_dlq', name: 'Order DLQ', type: 'queue', responsibility: 'Dead letter queue for orders' },
      { id: 'api', name: 'API', type: 'service', responsibility: 'REST API' },
    ]
    const connections = [{ from: 'api', to: 'order_queue', type: 'async_event' }]
    const issues = lintArchitecture(services, connections)
    const dlqIssue = issues.find(i => i.rule === 'missing-dlq')
    expect(dlqIssue).toBeUndefined()
  })

  // ─── Rule 12: Database Without Backup Access ────────────────────────────

  it('should info when database has no backup service', () => {
    const services = [
      { id: 'main_db', name: 'Main DB', type: 'database', responsibility: 'Primary storage' },
      { id: 'api', name: 'API', type: 'service', responsibility: 'REST API' },
    ]
    const connections = [{ from: 'api', to: 'main_db', type: 'db_access' }]
    const issues = lintArchitecture(services, connections)
    const backupIssue = issues.find(i => i.rule === 'no-db-backup' && i.serviceId === 'main_db')
    expect(backupIssue).toBeDefined()
    expect(backupIssue!.severity).toBe('info')
    expect(backupIssue!.message).toContain('no backup or replication service')
  })

  it('should not warn about missing backup when backup service exists', () => {
    const services = [
      { id: 'main_db', name: 'Main DB', type: 'database', responsibility: 'Primary storage' },
      { id: 'db_backup', name: 'DB Backup', type: 'service', responsibility: 'Backs up database' },
      { id: 'api', name: 'API', type: 'service', responsibility: 'REST API' },
    ]
    const connections = [
      { from: 'api', to: 'main_db', type: 'db_access' },
      { from: 'main_db', to: 'db_backup', type: 'sync_http' },
    ]
    const issues = lintArchitecture(services, connections)
    const backupIssue = issues.find(i => i.rule === 'no-db-backup' && i.serviceId === 'main_db')
    expect(backupIssue).toBeUndefined()
  })

  // ─── Rule 13: External Service Without Retry Pattern ────────────────────

  it('should warn when external service is called sync without retry/queue fallback', () => {
    const services = [
      { id: 'payment_svc', name: 'Payment Service', type: 'service', responsibility: 'Processes payments' },
      { id: 'stripe_api', name: 'Stripe API', type: 'external', responsibility: 'Payment gateway' },
    ]
    const connections = [
      { from: 'payment_svc', to: 'stripe_api', type: 'sync_http' },
    ]
    const issues = lintArchitecture(services, connections)
    const retryIssue = issues.find(i => i.rule === 'external-no-retry' && i.serviceId === 'stripe_api')
    expect(retryIssue).toBeDefined()
    expect(retryIssue!.severity).toBe('warning')
    expect(retryIssue!.message).toContain('called synchronously without a retry/queue fallback')
  })

  it('should not warn about external service when caller has async connection', () => {
    const services = [
      { id: 'payment_svc', name: 'Payment Service', type: 'service', responsibility: 'Processes payments' },
      { id: 'stripe_api', name: 'Stripe API', type: 'external', responsibility: 'Payment gateway' },
      { id: 'retry_queue', name: 'Retry Queue', type: 'queue', responsibility: 'Retry failed calls' },
    ]
    const connections = [
      { from: 'payment_svc', to: 'stripe_api', type: 'sync_http' },
      { from: 'payment_svc', to: 'retry_queue', type: 'async_event' },
    ]
    const issues = lintArchitecture(services, connections)
    const retryIssue = issues.find(i => i.rule === 'external-no-retry' && i.serviceId === 'stripe_api')
    expect(retryIssue).toBeUndefined()
  })

  // ─── Rule 14: High Fan-Out (>5 outgoing connections) ────────────────────

  it('should warn about high fan-out service with >5 outgoing connections', () => {
    const services = [
      { id: 'orchestrator', name: 'Orchestrator', type: 'service', responsibility: 'Orchestrates everything' },
      { id: 'a', name: 'A', type: 'service', responsibility: 'A' },
      { id: 'b', name: 'B', type: 'service', responsibility: 'B' },
      { id: 'c', name: 'C', type: 'service', responsibility: 'C' },
      { id: 'd', name: 'D', type: 'service', responsibility: 'D' },
      { id: 'e', name: 'E', type: 'service', responsibility: 'E' },
      { id: 'f', name: 'F', type: 'service', responsibility: 'F' },
    ]
    const connections = [
      { from: 'orchestrator', to: 'a', type: 'sync_http' },
      { from: 'orchestrator', to: 'b', type: 'sync_http' },
      { from: 'orchestrator', to: 'c', type: 'sync_http' },
      { from: 'orchestrator', to: 'd', type: 'sync_http' },
      { from: 'orchestrator', to: 'e', type: 'sync_http' },
      { from: 'orchestrator', to: 'f', type: 'sync_http' },
    ]
    const issues = lintArchitecture(services, connections)
    const fanOutIssue = issues.find(i => i.rule === 'high-fan-out' && i.serviceId === 'orchestrator')
    expect(fanOutIssue).toBeDefined()
    expect(fanOutIssue!.severity).toBe('warning')
    expect(fanOutIssue!.message).toContain('6 outgoing connections')
  })

  it('should not warn about fan-out when service has 5 or fewer outgoing connections', () => {
    const services = [
      { id: 'orchestrator', name: 'Orchestrator', type: 'service', responsibility: 'Orchestrates things' },
      { id: 'a', name: 'A', type: 'service', responsibility: 'A' },
      { id: 'b', name: 'B', type: 'service', responsibility: 'B' },
      { id: 'c', name: 'C', type: 'service', responsibility: 'C' },
      { id: 'd', name: 'D', type: 'service', responsibility: 'D' },
      { id: 'e', name: 'E', type: 'service', responsibility: 'E' },
    ]
    const connections = [
      { from: 'orchestrator', to: 'a', type: 'sync_http' },
      { from: 'orchestrator', to: 'b', type: 'sync_http' },
      { from: 'orchestrator', to: 'c', type: 'sync_http' },
      { from: 'orchestrator', to: 'd', type: 'sync_http' },
      { from: 'orchestrator', to: 'e', type: 'sync_http' },
    ]
    const issues = lintArchitecture(services, connections)
    const fanOutIssue = issues.find(i => i.rule === 'high-fan-out' && i.serviceId === 'orchestrator')
    expect(fanOutIssue).toBeUndefined()
  })

  it('does not flag api_gateway as god-service even with many connections', () => {
    const services = [
      { id: 'gw', name: 'Gateway', type: 'api_gateway', responsibility: 'Routing' },
      { id: 'a', name: 'A', type: 'service', responsibility: 'A' },
      { id: 'b', name: 'B', type: 'service', responsibility: 'B' },
      { id: 'c', name: 'C', type: 'service', responsibility: 'C' },
      { id: 'd', name: 'D', type: 'service', responsibility: 'D' },
      { id: 'e', name: 'E', type: 'service', responsibility: 'E' },
      { id: 'f', name: 'F', type: 'service', responsibility: 'F' },
    ]
    const connections = [
      { from: 'gw', to: 'a', type: 'sync_http' },
      { from: 'gw', to: 'b', type: 'sync_http' },
      { from: 'gw', to: 'c', type: 'sync_http' },
      { from: 'gw', to: 'd', type: 'sync_http' },
      { from: 'gw', to: 'e', type: 'sync_http' },
      { from: 'gw', to: 'f', type: 'sync_http' },
    ]
    const issues = lintArchitecture(services, connections)
    const godIssue = issues.find(i => i.rule === 'god-service' && i.serviceId === 'gw')
    expect(godIssue).toBeUndefined()
  })
})
