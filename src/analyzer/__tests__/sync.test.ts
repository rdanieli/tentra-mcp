import { describe, it, expect } from 'vitest'
import { computeDiff } from '../sync.js'

describe('computeDiff', () => {
  it('should return score 100 for identical services and connections', () => {
    const services = [
      { id: 'api', type: 'service', responsibility: 'REST API' },
      { id: 'db', type: 'database', responsibility: 'Storage' },
    ]
    const connections = [{ from: 'api', to: 'db', type: 'db_access' }]
    const diff = computeDiff(services, connections, services, connections)
    expect(diff.score).toBe(100)
    expect(diff.addedServices).toHaveLength(0)
    expect(diff.removedServices).toHaveLength(0)
    expect(diff.addedConnections).toHaveLength(0)
    expect(diff.removedConnections).toHaveLength(0)
    expect(diff.changedServices).toHaveLength(0)
  })

  it('should report an added service and have score < 100', () => {
    const saved = [
      { id: 'api', type: 'service', responsibility: 'REST API' },
    ]
    const detected = [
      { id: 'api', type: 'service', responsibility: 'REST API' },
      { id: 'worker', type: 'service', responsibility: 'Background tasks' },
    ]
    const diff = computeDiff(saved, [], detected, [])
    expect(diff.addedServices).toContain('worker')
    expect(diff.score).toBeLessThan(100)
  })

  it('should report a removed service', () => {
    const saved = [
      { id: 'api', type: 'service', responsibility: 'REST API' },
      { id: 'legacy', type: 'service', responsibility: 'Legacy system' },
    ]
    const detected = [
      { id: 'api', type: 'service', responsibility: 'REST API' },
    ]
    const diff = computeDiff(saved, [], detected, [])
    expect(diff.removedServices).toContain('legacy')
  })

  it('should report a field change when service type differs', () => {
    const saved = [
      { id: 'gateway', type: 'service', responsibility: 'Routing' },
    ]
    const detected = [
      { id: 'gateway', type: 'api_gateway', responsibility: 'Routing' },
    ]
    const diff = computeDiff(saved, [], detected, [])
    expect(diff.changedServices).toHaveLength(1)
    expect(diff.changedServices[0].field).toBe('type')
    expect(diff.changedServices[0].saved).toBe('service')
    expect(diff.changedServices[0].detected).toBe('api_gateway')
  })

  it('should fuzzy match payment_service vs payment_svc', () => {
    const saved = [
      { id: 'payment_service', type: 'service', responsibility: 'Payments' },
    ]
    const detected = [
      { id: 'payment_svc', type: 'service', responsibility: 'Payments' },
    ]
    const diff = computeDiff(saved, [], detected, [])
    // They should match (fuzzy), so no added/removed
    expect(diff.addedServices).toHaveLength(0)
    expect(diff.removedServices).toHaveLength(0)
  })

  it('should return score 100 for empty saved and detected', () => {
    const diff = computeDiff([], [], [], [])
    expect(diff.score).toBe(100)
  })

  // ─── Edge cases ──────────────────────────────────────────────────────────

  it('handles completely different architectures (0% overlap)', () => {
    const saved = [
      { id: 'old_api', type: 'service', responsibility: 'Legacy API' },
      { id: 'old_db', type: 'database', responsibility: 'Legacy DB' },
    ]
    const savedConns = [{ from: 'old_api', to: 'old_db', type: 'db_access' }]

    const detected = [
      { id: 'new_gateway', type: 'api_gateway', responsibility: 'New gateway' },
      { id: 'new_worker', type: 'service', responsibility: 'Background worker' },
    ]
    const detectedConns = [{ from: 'new_gateway', to: 'new_worker', type: 'sync_http' }]

    const diff = computeDiff(saved, savedConns, detected, detectedConns)
    expect(diff.addedServices).toContain('new_gateway')
    expect(diff.addedServices).toContain('new_worker')
    expect(diff.removedServices).toContain('old_api')
    expect(diff.removedServices).toContain('old_db')
    expect(diff.score).toBeLessThan(50)
  })

  it('handles services with changed types', () => {
    const saved = [
      { id: 'auth', type: 'service', responsibility: 'Authentication' },
    ]
    const detected = [
      { id: 'auth', type: 'api_gateway', responsibility: 'Authentication' },
    ]
    const diff = computeDiff(saved, [], detected, [])
    expect(diff.changedServices).toHaveLength(1)
    expect(diff.changedServices[0].id).toBe('auth')
    expect(diff.changedServices[0].field).toBe('type')
    expect(diff.changedServices[0].saved).toBe('service')
    expect(diff.changedServices[0].detected).toBe('api_gateway')
  })

  it('handles responsibility differences with whitespace only', () => {
    const saved = [
      { id: 'api', type: 'service', responsibility: 'REST API' },
    ]
    const detected = [
      { id: 'api', type: 'service', responsibility: 'rest api' },
    ]
    const diff = computeDiff(saved, [], detected, [])
    // Case-insensitive comparison should treat these as the same
    expect(diff.changedServices).toHaveLength(0)
  })

  it('handles connection type changes', () => {
    const services = [
      { id: 'api', type: 'service', responsibility: 'API' },
      { id: 'worker', type: 'service', responsibility: 'Worker' },
    ]
    const savedConns = [{ from: 'api', to: 'worker', type: 'sync_http' }]
    const detectedConns = [{ from: 'api', to: 'worker', type: 'async_event' }]

    const diff = computeDiff(services, savedConns, services, detectedConns)
    // The old sync_http is removed and a new async_event is added
    expect(diff.addedConnections).toHaveLength(1)
    expect(diff.addedConnections[0].type).toBe('async_event')
    expect(diff.removedConnections).toHaveLength(1)
    expect(diff.removedConnections[0].type).toBe('sync_http')
  })

  it('fuzzy matches abbreviated names correctly', () => {
    const saved = [
      { id: 'user_database', type: 'database', responsibility: 'User storage' },
      { id: 'payment_gateway', type: 'api_gateway', responsibility: 'Payment routing' },
      { id: 'message_queue', type: 'queue', responsibility: 'Messaging' },
    ]
    const detected = [
      { id: 'user_db', type: 'database', responsibility: 'User storage' },
      { id: 'payment_gw', type: 'api_gateway', responsibility: 'Payment routing' },
      { id: 'msg_q', type: 'queue', responsibility: 'Messaging' },
    ]
    const diff = computeDiff(saved, [], detected, [])
    // All should fuzzy-match
    expect(diff.addedServices).toHaveLength(0)
    expect(diff.removedServices).toHaveLength(0)
  })

  it('handles large architectures efficiently', () => {
    const count = 200
    const savedServices = Array.from({ length: count }, (_, i) => ({
      id: `svc_${i}`,
      type: 'service',
      responsibility: `Service ${i}`,
    }))
    const detectedServices = Array.from({ length: count }, (_, i) => ({
      id: `svc_${i}`,
      type: 'service',
      responsibility: `Service ${i}`,
    }))
    const savedConns = Array.from({ length: count - 1 }, (_, i) => ({
      from: `svc_${i}`, to: `svc_${i + 1}`, type: 'sync_http',
    }))
    const detectedConns = Array.from({ length: count - 1 }, (_, i) => ({
      from: `svc_${i}`, to: `svc_${i + 1}`, type: 'sync_http',
    }))

    const start = Date.now()
    const diff = computeDiff(savedServices, savedConns, detectedServices, detectedConns)
    const elapsed = Date.now() - start

    expect(diff.score).toBe(100)
    expect(diff.addedServices).toHaveLength(0)
    expect(diff.removedServices).toHaveLength(0)
    // Should complete well under 1 second
    expect(elapsed).toBeLessThan(1000)
  })
})
