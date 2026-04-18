export type Severity = 'error' | 'warning' | 'info'

export interface LintIssue {
  severity: Severity
  rule: string
  message: string
  serviceId?: string
}

interface Service {
  id: string
  name?: string
  type: string
  responsibility: string
  scaling?: string
}

interface Connection {
  from: string
  to: string
  type: string
}

export function lintArchitecture(
  services: Service[],
  connections: Connection[]
): LintIssue[] {
  const issues: LintIssue[] = []

  issues.push(...checkOrphanNodes(services, connections))
  issues.push(...checkDuplicateConnections(connections))
  issues.push(...checkNamingConventions(services))
  issues.push(...checkEmptyResponsibilities(services))
  issues.push(...checkSinglePointsOfFailure(services, connections))
  issues.push(...checkGodServices(services, connections))
  issues.push(...checkMissingDatabase(services, connections))
  issues.push(...checkSyncOverload(services, connections))
  issues.push(...checkZoneBalance(services))
  issues.push(...checkCircularDependencies(services, connections))
  issues.push(...checkQueueWithoutDLQ(services))
  issues.push(...checkDatabaseWithoutBackup(services, connections))
  issues.push(...checkExternalWithoutRetry(services, connections))
  issues.push(...checkHighFanOut(services, connections))

  return issues
}

// ─── Orphan nodes (no connections at all) ──────────────────────────────────

function checkOrphanNodes(services: Service[], connections: Connection[]): LintIssue[] {
  const connected = new Set<string>()
  for (const c of connections) {
    connected.add(c.from)
    connected.add(c.to)
  }

  return services
    .filter(s => !connected.has(s.id))
    .map(s => ({
      severity: 'warning' as Severity,
      rule: 'orphan-node',
      message: `"${s.name || s.id}" has no connections — is it actually part of the system?`,
      serviceId: s.id
    }))
}

// ─── Duplicate connections ─────────────────────────────────────────────────

function checkDuplicateConnections(connections: Connection[]): LintIssue[] {
  const seen = new Map<string, number>()
  for (const c of connections) {
    const key = `${c.from}->${c.to}:${c.type}`
    seen.set(key, (seen.get(key) || 0) + 1)
  }

  return Array.from(seen.entries())
    .filter(([_, count]) => count > 1)
    .map(([key, count]) => ({
      severity: 'error' as Severity,
      rule: 'duplicate-connection',
      message: `Duplicate connection: ${key} appears ${count} times`
    }))
}

// ─── Naming conventions ────────────────────────────────────────────────────

function checkNamingConventions(services: Service[]): LintIssue[] {
  return services
    .filter(s => s.id !== s.id.toLowerCase() || /[^a-z0-9_]/.test(s.id))
    .map(s => ({
      severity: 'warning' as Severity,
      rule: 'naming-convention',
      message: `"${s.id}" should be snake_case (lowercase, underscores only)`,
      serviceId: s.id
    }))
}

// ─── Empty or generic responsibilities ─────────────────────────────────────

function checkEmptyResponsibilities(services: Service[]): LintIssue[] {
  const generic = ['service', 'handles requests', 'does stuff', 'tbd', 'todo', '']
  return services
    .filter(s => generic.includes(s.responsibility.toLowerCase().trim()))
    .map(s => ({
      severity: 'warning' as Severity,
      rule: 'weak-responsibility',
      message: `"${s.name || s.id}" has a vague responsibility: "${s.responsibility}". Be specific about what it does.`,
      serviceId: s.id
    }))
}

// ─── Single points of failure ──────────────────────────────────────────────

function checkSinglePointsOfFailure(services: Service[], connections: Connection[]): LintIssue[] {
  const issues: LintIssue[] = []

  // Count how many services depend on each service
  const inboundCount = new Map<string, number>()
  for (const c of connections) {
    inboundCount.set(c.to, (inboundCount.get(c.to) || 0) + 1)
  }

  for (const [id, count] of inboundCount) {
    const svc = services.find(s => s.id === id)
    if (!svc) continue

    // If many services depend on one and it's not horizontally scaled
    if (count >= 3 && svc.scaling !== 'horizontal') {
      issues.push({
        severity: 'warning',
        rule: 'spof',
        message: `"${svc.name || svc.id}" has ${count} dependents but is not horizontally scaled — potential single point of failure`,
        serviceId: id
      })
    }
  }

  return issues
}

// ─── God services (too many connections) ───────────────────────────────────

function checkGodServices(services: Service[], connections: Connection[]): LintIssue[] {
  const issues: LintIssue[] = []
  const totalConnections = new Map<string, number>()

  for (const c of connections) {
    totalConnections.set(c.from, (totalConnections.get(c.from) || 0) + 1)
    totalConnections.set(c.to, (totalConnections.get(c.to) || 0) + 1)
  }

  const threshold = Math.max(6, services.length * 0.6)

  for (const [id, count] of totalConnections) {
    if (count >= threshold) {
      const svc = services.find(s => s.id === id)
      if (!svc || svc.type === 'database' || svc.type === 'api_gateway') continue
      issues.push({
        severity: 'warning',
        rule: 'god-service',
        message: `"${svc.name || svc.id}" has ${count} connections — consider splitting into smaller services`,
        serviceId: id
      })
    }
  }

  return issues
}

// ─── Missing database ──────────────────────────────────────────────────────

function checkMissingDatabase(services: Service[], connections: Connection[]): LintIssue[] {
  const hasDb = services.some(s => s.type === 'database')
  const hasService = services.some(s => s.type === 'service')

  if (hasService && !hasDb) {
    return [{
      severity: 'info',
      rule: 'no-database',
      message: 'No database detected — most systems need persistent storage. Is one missing?'
    }]
  }

  return []
}

// ─── Too many sync connections ─────────────────────────────────────────────

function checkSyncOverload(services: Service[], connections: Connection[]): LintIssue[] {
  const syncCount = connections.filter(c => c.type === 'sync_http' || c.type === 'grpc').length
  const asyncCount = connections.filter(c => c.type === 'async_event').length
  const total = connections.length

  if (total >= 6 && asyncCount === 0) {
    return [{
      severity: 'info',
      rule: 'all-sync',
      message: `All ${total} connections are synchronous — consider async patterns (events, queues) for loose coupling`
    }]
  }

  if (total >= 10 && syncCount / total > 0.85) {
    return [{
      severity: 'info',
      rule: 'sync-heavy',
      message: `${Math.round(syncCount / total * 100)}% of connections are synchronous — high coupling risk`
    }]
  }

  return []
}

// ─── Zone balance ──────────────────────────────────────────────────────────

function checkZoneBalance(services: Service[]): LintIssue[] {
  const issues: LintIssue[] = []
  const byType = new Map<string, number>()
  for (const s of services) byType.set(s.type, (byType.get(s.type) || 0) + 1)

  const serviceCount = byType.get('service') || 0
  if (serviceCount > 8) {
    issues.push({
      severity: 'info',
      rule: 'too-many-services',
      message: `${serviceCount} services detected — consider grouping into bounded contexts or domains for better visual clarity`
    })
  }

  return issues
}

// ─── Circular dependencies (DFS cycle detection) ──────────────────────────

function checkCircularDependencies(services: Service[], connections: Connection[]): LintIssue[] {
  const issues: LintIssue[] = []
  const adj = new Map<string, string[]>()
  for (const c of connections) {
    if (!adj.has(c.from)) adj.set(c.from, [])
    adj.get(c.from)!.push(c.to)
  }

  const visited = new Set<string>()
  const reportedCycles = new Set<string>()

  function dfs(node: string, path: string[], pathSet: Set<string>): void {
    if (pathSet.has(node)) {
      const cycleStart = path.indexOf(node)
      const cycle = path.slice(cycleStart)
      cycle.push(node)
      // Normalize cycle to avoid duplicate reports: rotate so smallest ID is first
      const ids = cycle.slice(0, -1)
      const minIdx = ids.indexOf(ids.reduce((a, b) => a < b ? a : b))
      const rotated = [...ids.slice(minIdx), ...ids.slice(0, minIdx), ids[minIdx]]
      const key = rotated.join('->')
      if (!reportedCycles.has(key)) {
        reportedCycles.add(key)
        issues.push({
          severity: 'warning',
          rule: 'circular-dependency',
          message: `Circular dependency detected: ${cycle.join(' \u2192 ')}`
        })
      }
      return
    }
    if (visited.has(node)) return

    pathSet.add(node)
    path.push(node)

    for (const neighbor of adj.get(node) || []) {
      dfs(neighbor, path, pathSet)
    }

    path.pop()
    pathSet.delete(node)
    visited.add(node)
  }

  const allNodes = new Set<string>()
  for (const c of connections) {
    allNodes.add(c.from)
    allNodes.add(c.to)
  }

  for (const node of allNodes) {
    dfs(node, [], new Set())
  }

  return issues
}

// ─── Queue without dead-letter queue ──────────────────────────────────────

function checkQueueWithoutDLQ(services: Service[]): LintIssue[] {
  const queues = services.filter(s => s.type === 'queue')
  if (queues.length === 0) return []

  const hasDLQ = services.some(s =>
    s.type === 'queue' && (/dlq/i.test(s.id) || /dead/i.test(s.id) || /dlq/i.test(s.name || '') || /dead/i.test(s.name || ''))
  )

  if (hasDLQ) return []

  return queues.map(q => ({
    severity: 'info' as Severity,
    rule: 'missing-dlq',
    message: `Queue "${q.name || q.id}" has no dead-letter queue \u2014 failed messages may be lost`,
    serviceId: q.id
  }))
}

// ─── Database without backup/replication service ──────────────────────────

function checkDatabaseWithoutBackup(services: Service[], connections: Connection[]): LintIssue[] {
  const issues: LintIssue[] = []
  const databases = services.filter(s => s.type === 'database')

  for (const db of databases) {
    // Check if the database has any outgoing connection to a backup/replication service
    const hasBackup = connections.some(c =>
      c.from === db.id && services.some(s =>
        s.id === c.to && (/backup/i.test(s.id) || /backup/i.test(s.name || '') || /replica/i.test(s.id) || /replica/i.test(s.name || ''))
      )
    )
    if (!hasBackup) {
      issues.push({
        severity: 'info',
        rule: 'no-db-backup',
        message: `Database "${db.name || db.id}" has no backup or replication service`,
        serviceId: db.id
      })
    }
  }

  return issues
}

// ─── External service without retry pattern ───────────────────────────────

function checkExternalWithoutRetry(services: Service[], connections: Connection[]): LintIssue[] {
  const issues: LintIssue[] = []
  const externals = services.filter(s => s.type === 'external')

  for (const ext of externals) {
    // Find services that call this external via sync_http
    const callers = connections
      .filter(c => c.to === ext.id && c.type === 'sync_http')
      .map(c => c.from)

    for (const callerId of callers) {
      // Check if the caller has any queue connection (suggesting async retry capability)
      const hasQueueConnection = connections.some(c =>
        (c.from === callerId || c.to === callerId) && c.type === 'async_event'
      )
      if (!hasQueueConnection) {
        issues.push({
          severity: 'warning',
          rule: 'external-no-retry',
          message: `External service "${ext.name || ext.id}" is called synchronously without a retry/queue fallback`,
          serviceId: ext.id
        })
        break // One issue per external service is enough
      }
    }
  }

  return issues
}

// ─── High fan-out (>5 outgoing connections) ───────────────────────────────

function checkHighFanOut(services: Service[], connections: Connection[]): LintIssue[] {
  const issues: LintIssue[] = []
  const outgoing = new Map<string, number>()

  for (const c of connections) {
    outgoing.set(c.from, (outgoing.get(c.from) || 0) + 1)
  }

  for (const [id, count] of outgoing) {
    if (count > 5) {
      const svc = services.find(s => s.id === id)
      if (!svc) continue
      issues.push({
        severity: 'warning',
        rule: 'high-fan-out',
        message: `Service "${svc.name || svc.id}" has ${count} outgoing connections \u2014 consider splitting into smaller services`,
        serviceId: id
      })
    }
  }

  return issues
}
