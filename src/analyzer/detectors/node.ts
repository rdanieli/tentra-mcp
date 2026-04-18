import { dirname, relative, basename } from 'path'
import {
  DetectedService, ServiceType,
  API_FRAMEWORKS, WEB_FRAMEWORKS, GATEWAY_INDICATORS,
  DB_TECHNOLOGIES, QUEUE_TECHNOLOGIES, EXTERNAL_SERVICES
} from '../types.js'

interface PkgJson {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

export function detectFromPackageJson(
  content: string,
  filePath: string,
  rootPath: string
): DetectedService[] {
  let pkg: PkgJson
  try {
    pkg = JSON.parse(content)
  } catch {
    return []
  }

  const services: DetectedService[] = []
  const dir = dirname(filePath)
  const relDir = relative(rootPath, dir)
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
  const depNames = new Set(Object.keys(allDeps))

  // Skip root package.json in monorepos (has workspaces but no real service)
  if (relDir === '' && (content.includes('"workspaces"') || content.includes('"packages"'))) {
    // Still scan for docker-compose level things, but don't create a service
    return detectExternalServicesFromDeps(depNames, filePath)
  }

  // Determine service type from dependencies
  const type = classifyService(depNames)
  const name = humanizeName(pkg.name || basename(dir))
  const id = toSnakeCase(pkg.name || basename(dir))
  const technologies = detectTechnologies(depNames)

  if (type) {
    services.push({
      id,
      name,
      type,
      responsibility: inferResponsibility(type, technologies, pkg),
      scaling: type === 'database' ? 'vertical' : 'horizontal',
      confidence: 0.7,
      source: filePath,
      technologies
    })
  }

  // Detect databases from deps
  const dbServices = detectDatabasesFromDeps(depNames, filePath)
  services.push(...dbServices)

  // Detect queues from deps
  const queueServices = detectQueuesFromDeps(depNames, filePath)
  services.push(...queueServices)

  // Detect external services from deps
  const externalServices = detectExternalServicesFromDeps(depNames, filePath)
  services.push(...externalServices)

  return services
}

function classifyService(deps: Set<string>): ServiceType | null {
  // Check for gateway indicators first
  for (const gw of GATEWAY_INDICATORS) {
    if (deps.has(gw)) return 'api_gateway'
  }

  // Check for API frameworks
  for (const api of API_FRAMEWORKS) {
    if (deps.has(api)) return 'service'
  }

  // Check for web frameworks
  for (const web of WEB_FRAMEWORKS) {
    if (deps.has(web)) return 'service'
  }

  return null
}

function detectTechnologies(deps: Set<string>): string[] {
  const techs: string[] = []
  for (const dep of deps) {
    if (API_FRAMEWORKS.has(dep)) techs.push(dep)
    if (WEB_FRAMEWORKS.has(dep)) techs.push(dep)
    if (DB_TECHNOLOGIES.has(dep)) techs.push(dep)
    if (QUEUE_TECHNOLOGIES.has(dep)) techs.push(dep)
  }
  return techs
}

function detectDatabasesFromDeps(deps: Set<string>, source: string): DetectedService[] {
  const services: DetectedService[] = []
  const seen = new Set<string>()

  if ((deps.has('prisma') || deps.has('@prisma/client')) && !seen.has('postgresql')) {
    // Prisma defaults to PostgreSQL — will be refined by schema analysis
    services.push({
      id: 'postgresql', name: 'PostgreSQL', type: 'database',
      responsibility: 'Primary relational database',
      scaling: 'vertical', confidence: 0.6, source, technologies: ['prisma', 'postgresql']
    })
    seen.add('postgresql')
  }

  if ((deps.has('mongoose') || deps.has('mongodb')) && !seen.has('mongodb')) {
    services.push({
      id: 'mongodb', name: 'MongoDB', type: 'database',
      responsibility: 'Document database',
      scaling: 'horizontal', confidence: 0.7, source, technologies: ['mongodb']
    })
    seen.add('mongodb')
  }

  if ((deps.has('redis') || deps.has('ioredis')) && !seen.has('redis')) {
    services.push({
      id: 'redis', name: 'Redis', type: 'database',
      responsibility: 'In-memory cache and data store',
      scaling: 'horizontal', confidence: 0.7, source, technologies: ['redis']
    })
    seen.add('redis')
  }

  if ((deps.has('mysql') || deps.has('mysql2')) && !seen.has('mysql')) {
    services.push({
      id: 'mysql', name: 'MySQL', type: 'database',
      responsibility: 'Relational database',
      scaling: 'vertical', confidence: 0.6, source, technologies: ['mysql']
    })
    seen.add('mysql')
  }

  if (deps.has('@elastic/elasticsearch') && !seen.has('elasticsearch')) {
    services.push({
      id: 'elasticsearch', name: 'Elasticsearch', type: 'database',
      responsibility: 'Search and analytics engine',
      scaling: 'horizontal', confidence: 0.7, source, technologies: ['elasticsearch']
    })
    seen.add('elasticsearch')
  }

  return services
}

function detectQueuesFromDeps(deps: Set<string>, source: string): DetectedService[] {
  const services: DetectedService[] = []

  if (deps.has('kafkajs') || deps.has('kafka-node')) {
    services.push({
      id: 'kafka', name: 'Kafka', type: 'queue',
      responsibility: 'Event streaming and message brokering',
      scaling: 'horizontal', confidence: 0.8, source, technologies: ['kafka']
    })
  }

  if (deps.has('amqplib')) {
    services.push({
      id: 'rabbitmq', name: 'RabbitMQ', type: 'queue',
      responsibility: 'Message queue and routing',
      scaling: 'horizontal', confidence: 0.8, source, technologies: ['rabbitmq']
    })
  }

  if (deps.has('bullmq') || deps.has('bull')) {
    services.push({
      id: 'bull_queue', name: 'Bull Queue', type: 'queue',
      responsibility: 'Job queue backed by Redis',
      scaling: 'horizontal', confidence: 0.7, source, technologies: ['bull', 'redis']
    })
  }

  if (deps.has('@aws-sdk/client-sqs')) {
    services.push({
      id: 'aws_sqs', name: 'AWS SQS', type: 'queue',
      responsibility: 'Managed message queue',
      scaling: 'horizontal', confidence: 0.8, source, technologies: ['aws-sqs']
    })
  }

  return services
}

function detectExternalServicesFromDeps(deps: Set<string>, source: string): DetectedService[] {
  const services: DetectedService[] = []
  const seen = new Set<string>()

  for (const [dep, info] of Object.entries(EXTERNAL_SERVICES)) {
    if (deps.has(dep)) {
      const id = toSnakeCase(info.name)
      if (seen.has(id)) continue
      seen.add(id)
      services.push({
        id,
        name: info.name,
        type: 'external',
        responsibility: info.responsibility,
        scaling: 'none',
        confidence: 0.8,
        source,
        technologies: [dep]
      })
    }
  }

  return services
}

function inferResponsibility(type: ServiceType, technologies: string[], pkg: PkgJson): string {
  const scripts = pkg.scripts || {}

  if (type === 'api_gateway') {
    return 'API gateway routing, authentication, and request proxying'
  }

  // Check if it's a web frontend
  const hasWeb = technologies.some(t => WEB_FRAMEWORKS.has(t))
  const hasApi = technologies.some(t => API_FRAMEWORKS.has(t))

  if (hasWeb && !hasApi) {
    const framework = technologies.find(t => WEB_FRAMEWORKS.has(t)) || 'web'
    return `Web frontend application (${framework})`
  }

  if (hasApi) {
    const framework = technologies.find(t => API_FRAMEWORKS.has(t)) || 'HTTP'
    const dbTech = technologies.find(t => DB_TECHNOLOGIES.has(t))
    if (dbTech) {
      return `${framework} REST API with ${dbTech} persistence`
    }
    return `${framework} REST API service`
  }

  if (scripts.start || scripts.dev) {
    return 'Application service'
  }

  return 'Service'
}

function humanizeName(name: string): string {
  return name
    .replace(/^@[^/]+\//, '') // Remove scope
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim()
}

function toSnakeCase(name: string): string {
  return name
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
}
