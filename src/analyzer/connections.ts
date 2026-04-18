import { readdir, readFile } from 'fs/promises'
import { join, dirname, relative } from 'path'
import { DetectedService, DetectedConnection, ConnectionType } from './types.js'

export async function inferConnections(
  services: DetectedService[],
  configFiles: Map<string, string>,
  rootPath: string
): Promise<DetectedConnection[]> {
  const connections: DetectedConnection[] = []

  // Strategy 1: docker-compose depends_on
  connections.push(...inferFromDockerCompose(services, configFiles))

  // Strategy 2: Service → database (if a service uses a DB tech, connect to the DB service)
  connections.push(...inferDatabaseConnections(services))

  // Strategy 3: Service → queue (if a service uses a queue tech, connect to the queue)
  connections.push(...inferQueueConnections(services))

  // Strategy 4: Service → external (if a service has external deps in its technologies)
  connections.push(...inferExternalConnections(services))

  // Strategy 5: Service → cloud services (shared source file means same package uses the cloud service)
  connections.push(...inferCloudServiceConnections(services))

  // Strategy 6: API gateway → services (gateway connects to all non-infra services)
  connections.push(...inferGatewayConnections(services))

  // Strategy 7: Env var analysis — HTTP URLs pointing to other services
  connections.push(...inferFromEnvVars(services, configFiles))

  return connections
}

// ─── Strategy 1: docker-compose depends_on ─────────────────────────────────

function inferFromDockerCompose(
  services: DetectedService[],
  configFiles: Map<string, string>
): DetectedConnection[] {
  const connections: DetectedConnection[] = []
  const serviceIds = new Set(services.map(s => s.id))

  for (const [path, content] of configFiles) {
    if (!path.includes('docker-compose')) continue

    const lines = content.split('\n')
    let inServices = false
    let currentService: string | null = null
    let inDependsOn = false

    for (const line of lines) {
      const trimmed = line.trimStart()
      const indent = line.length - trimmed.length

      if (trimmed === 'services:' && indent === 0) { inServices = true; continue }
      if (indent === 0 && trimmed.endsWith(':') && trimmed !== 'services:') inServices = false
      if (!inServices) continue

      if (indent === 2 && trimmed.endsWith(':') && !trimmed.startsWith('#')) {
        currentService = trimmed.replace(':', '').trim().replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
        inDependsOn = false
      }

      if (trimmed.startsWith('depends_on:')) { inDependsOn = true; continue }
      if (inDependsOn && trimmed.startsWith('- ') && currentService) {
        const dep = trimmed.replace('- ', '').trim().replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
        if (serviceIds.has(currentService) && serviceIds.has(dep)) {
          const targetType = services.find(s => s.id === dep)?.type
          connections.push({
            from: currentService, to: dep,
            type: targetType === 'database' ? 'db_access' : targetType === 'queue' ? 'async_event' : 'sync_http',
            reason: 'docker-compose depends_on',
            confidence: 0.9
          })
        }
      }
      if (inDependsOn && indent <= 4 && !trimmed.startsWith('- ') && !trimmed.startsWith('condition')) {
        inDependsOn = false
      }
    }
  }

  return connections
}

// ─── Strategy 2: Service → database ────────────────────────────────────────

function inferDatabaseConnections(services: DetectedService[]): DetectedConnection[] {
  const connections: DetectedConnection[] = []
  const dbServices = services.filter(s => s.type === 'database')
  const appServices = services.filter(s => s.type === 'service' || s.type === 'api_gateway')

  for (const app of appServices) {
    for (const db of dbServices) {
      // Check if the app's technologies overlap with the DB
      const dbTechs = db.technologies.map(t => t.toLowerCase())
      const appTechs = app.technologies.map(t => t.toLowerCase())

      const hasMatch = appTechs.some(t =>
        dbTechs.includes(t) ||
        (t === 'prisma' && dbTechs.includes('postgresql')) ||
        (t === 'mongoose' && dbTechs.includes('mongodb')) ||
        (t === 'sequelize' && (dbTechs.includes('postgresql') || dbTechs.includes('mysql'))) ||
        (t === 'typeorm' && (dbTechs.includes('postgresql') || dbTechs.includes('mysql'))) ||
        (t === 'ioredis' && dbTechs.includes('redis')) ||
        (t === 'gorm' && (dbTechs.includes('postgresql') || dbTechs.includes('mysql'))) ||
        (t === 'sqlalchemy' && (dbTechs.includes('postgresql') || dbTechs.includes('mysql'))) ||
        (t === 'jpa' && (dbTechs.includes('postgresql') || dbTechs.includes('mysql')))
      )

      if (hasMatch) {
        connections.push({
          from: app.id, to: db.id, type: 'db_access',
          reason: `Shared technology: ${appTechs.filter(t => dbTechs.includes(t) || t === 'prisma' || t === 'mongoose').join(', ')}`,
          confidence: 0.7
        })
      }
    }
  }

  return connections
}

// ─── Strategy 3: Service → queue ───────────────────────────────────────────

function inferQueueConnections(services: DetectedService[]): DetectedConnection[] {
  const connections: DetectedConnection[] = []
  const queueServices = services.filter(s => s.type === 'queue')
  const appServices = services.filter(s => s.type === 'service' || s.type === 'api_gateway')

  for (const app of appServices) {
    for (const queue of queueServices) {
      const queueTechs = queue.technologies.map(t => t.toLowerCase())
      const appTechs = app.technologies.map(t => t.toLowerCase())

      const hasMatch = appTechs.some(t =>
        queueTechs.includes(t) ||
        (t === 'kafkajs' && queueTechs.includes('kafka')) ||
        (t === 'amqplib' && queueTechs.includes('rabbitmq')) ||
        (t === 'bull' && queueTechs.includes('redis'))
      )

      if (hasMatch) {
        connections.push({
          from: app.id, to: queue.id, type: 'async_event',
          reason: `Queue technology match`,
          confidence: 0.7
        })
      }
    }
  }

  return connections
}

// ─── Strategy: Cloud service connections (same pom.xml source) ─────────────

function inferCloudServiceConnections(services: DetectedService[]): DetectedConnection[] {
  const connections: DetectedConnection[] = []
  const appServices = services.filter(s => s.type === 'service' || s.type === 'api_gateway')
  const cloudServices = services.filter(s =>
    (s.type === 'external' || s.type === 'database' || s.type === 'queue') &&
    s.technologies.includes('aws')
  )

  for (const app of appServices) {
    for (const cloud of cloudServices) {
      // If they share the same source file (same pom.xml detected both)
      if (app.source === cloud.source) {
        const connType: ConnectionType = cloud.type === 'database' ? 'db_access' :
          cloud.type === 'queue' ? 'async_event' : 'sync_http'
        connections.push({
          from: app.id, to: cloud.id, type: connType,
          reason: `Both detected from same project (${app.source.split('/').pop()})`,
          confidence: 0.75
        })
      }
    }
  }

  return connections
}

// ─── Strategy 4: Service → external ────────────────────────────────────────

function inferExternalConnections(services: DetectedService[]): DetectedConnection[] {
  const connections: DetectedConnection[] = []
  const externalServices = services.filter(s => s.type === 'external')
  const appServices = services.filter(s => s.type === 'service' || s.type === 'api_gateway')

  for (const app of appServices) {
    for (const ext of externalServices) {
      // If the app's source is the same package that detected the external service
      // OR if the technologies match
      const extTechs = ext.technologies.map(t => t.toLowerCase())
      const appHasExtDep = app.technologies.some(t => extTechs.includes(t))

      // Also check if both come from the same package.json
      const sameSource = app.source === ext.source

      if (appHasExtDep || sameSource) {
        connections.push({
          from: app.id, to: ext.id, type: 'sync_http',
          reason: 'External dependency detected in same package',
          confidence: 0.6
        })
      }
    }
  }

  return connections
}

// ─── Strategy 5: API gateway → services ────────────────────────────────────

function inferGatewayConnections(services: DetectedService[]): DetectedConnection[] {
  const connections: DetectedConnection[] = []
  const gateways = services.filter(s => s.type === 'api_gateway')
  const backends = services.filter(s => s.type === 'service')

  for (const gw of gateways) {
    for (const backend of backends) {
      connections.push({
        from: gw.id, to: backend.id, type: 'sync_http',
        reason: 'Gateway routes to backend services',
        confidence: 0.5
      })
    }
  }

  return connections
}

// ─── Strategy 6: Env var analysis ──────────────────────────────────────────

function inferFromEnvVars(
  services: DetectedService[],
  configFiles: Map<string, string>
): DetectedConnection[] {
  const connections: DetectedConnection[] = []
  const serviceNames = new Map(services.map(s => [s.id, s]))

  for (const [path, content] of configFiles) {
    if (!path.includes('.env')) continue

    const lines = content.split('\n')
    for (const line of lines) {
      if (line.startsWith('#') || !line.includes('=')) continue
      const value = line.split('=').slice(1).join('=').trim()

      // Look for URLs that mention service names
      if (value.includes('://')) {
        for (const [id, svc] of serviceNames) {
          if (value.toLowerCase().includes(id) || value.toLowerCase().includes(id.replace(/_/g, '-'))) {
            // Find which service this .env belongs to
            const envDir = dirname(path)
            const ownerService = services.find(s => dirname(s.source) === envDir || dirname(s.source).startsWith(envDir))
            if (ownerService && ownerService.id !== id) {
              connections.push({
                from: ownerService.id, to: id, type: 'sync_http',
                reason: `Env var URL references ${id}`,
                confidence: 0.6
              })
            }
          }
        }
      }
    }
  }

  return connections
}
