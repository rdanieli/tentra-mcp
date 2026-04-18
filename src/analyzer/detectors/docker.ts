import { DetectedService } from '../types.js'

// Simple YAML-ish parser for docker-compose — avoids adding a YAML dependency
// Handles the common patterns: services with image, build, ports, depends_on

const KNOWN_IMAGES: Record<string, Omit<DetectedService, 'id' | 'confidence' | 'source'>> = {
  'postgres': { name: 'PostgreSQL', type: 'database', responsibility: 'Primary relational database', scaling: 'vertical', technologies: ['postgresql'] },
  'mysql': { name: 'MySQL', type: 'database', responsibility: 'Relational database', scaling: 'vertical', technologies: ['mysql'] },
  'mariadb': { name: 'MariaDB', type: 'database', responsibility: 'Relational database', scaling: 'vertical', technologies: ['mariadb'] },
  'mongo': { name: 'MongoDB', type: 'database', responsibility: 'Document database', scaling: 'horizontal', technologies: ['mongodb'] },
  'redis': { name: 'Redis', type: 'database', responsibility: 'In-memory cache and data store', scaling: 'horizontal', technologies: ['redis'] },
  'memcached': { name: 'Memcached', type: 'database', responsibility: 'Distributed memory cache', scaling: 'horizontal', technologies: ['memcached'] },
  'elasticsearch': { name: 'Elasticsearch', type: 'database', responsibility: 'Search and analytics engine', scaling: 'horizontal', technologies: ['elasticsearch'] },
  'opensearch': { name: 'OpenSearch', type: 'database', responsibility: 'Search and analytics engine', scaling: 'horizontal', technologies: ['opensearch'] },
  'kafka': { name: 'Kafka', type: 'queue', responsibility: 'Event streaming platform', scaling: 'horizontal', technologies: ['kafka'] },
  'confluentinc/cp-kafka': { name: 'Kafka', type: 'queue', responsibility: 'Event streaming platform', scaling: 'horizontal', technologies: ['kafka'] },
  'rabbitmq': { name: 'RabbitMQ', type: 'queue', responsibility: 'Message broker', scaling: 'horizontal', technologies: ['rabbitmq'] },
  'nats': { name: 'NATS', type: 'queue', responsibility: 'Cloud-native messaging system', scaling: 'horizontal', technologies: ['nats'] },
  'zookeeper': { name: 'ZooKeeper', type: 'service', responsibility: 'Distributed coordination service', scaling: 'horizontal', technologies: ['zookeeper'] },
  'nginx': { name: 'Nginx', type: 'api_gateway', responsibility: 'Reverse proxy and load balancer', scaling: 'horizontal', technologies: ['nginx'] },
  'traefik': { name: 'Traefik', type: 'api_gateway', responsibility: 'Edge router and load balancer', scaling: 'horizontal', technologies: ['traefik'] },
  'envoyproxy/envoy': { name: 'Envoy', type: 'api_gateway', responsibility: 'Service mesh proxy', scaling: 'horizontal', technologies: ['envoy'] },
  'minio/minio': { name: 'MinIO', type: 'database', responsibility: 'S3-compatible object storage', scaling: 'horizontal', technologies: ['minio'] },
  'localstack/localstack': { name: 'LocalStack', type: 'external', responsibility: 'Local AWS cloud emulator', scaling: 'none', technologies: ['localstack'] },
  'mailhog/mailhog': { name: 'MailHog', type: 'external', responsibility: 'Email testing tool', scaling: 'none', technologies: ['mailhog'] },
}

export function detectFromDockerCompose(
  content: string,
  filePath: string,
  _rootPath: string
): DetectedService[] {
  const services: DetectedService[] = []
  const lines = content.split('\n')

  let inServices = false
  let currentService: string | null = null
  let currentImage: string | null = null
  let currentBuild: string | null = null
  let indent = 0

  for (const line of lines) {
    const trimmed = line.trimStart()
    const lineIndent = line.length - trimmed.length

    // Detect top-level "services:" section
    if (trimmed === 'services:' && lineIndent === 0) {
      inServices = true
      indent = 0
      continue
    }

    // Exit services section on next top-level key
    if (inServices && lineIndent === 0 && trimmed.endsWith(':') && trimmed !== 'services:') {
      inServices = false
    }

    if (!inServices) continue

    // Detect service name (2-space indent under services)
    if (lineIndent === 2 && trimmed.endsWith(':') && !trimmed.startsWith('#')) {
      // Flush previous service
      if (currentService) {
        const svc = buildService(currentService, currentImage, currentBuild, filePath)
        if (svc) services.push(svc)
      }
      currentService = trimmed.replace(':', '').trim()
      currentImage = null
      currentBuild = null
    }

    // Detect image
    if (currentService && trimmed.startsWith('image:')) {
      currentImage = trimmed.replace('image:', '').trim().replace(/["']/g, '')
    }

    // Detect build
    if (currentService && trimmed.startsWith('build:')) {
      currentBuild = trimmed.replace('build:', '').trim().replace(/["']/g, '')
    }
  }

  // Flush last service
  if (currentService) {
    const svc = buildService(currentService, currentImage, currentBuild, filePath)
    if (svc) services.push(svc)
  }

  return services
}

function buildService(
  serviceName: string,
  image: string | null,
  build: string | null,
  source: string
): DetectedService | null {
  // Check if image matches a known infrastructure service
  if (image) {
    const imageBase = image.split(':')[0] // Remove tag
    for (const [pattern, info] of Object.entries(KNOWN_IMAGES)) {
      if (imageBase === pattern || imageBase.endsWith(`/${pattern}`) || imageBase.includes(pattern)) {
        return {
          id: toSnakeCase(serviceName),
          ...info,
          confidence: 0.9,
          source
        }
      }
    }
  }

  // If it has a build context, it's a custom service
  if (build) {
    return {
      id: toSnakeCase(serviceName),
      name: humanizeName(serviceName),
      type: 'service',
      responsibility: `Custom application service (${serviceName})`,
      scaling: 'horizontal',
      confidence: 0.8,
      source,
      technologies: []
    }
  }

  // Unknown image — still create a service
  if (image) {
    return {
      id: toSnakeCase(serviceName),
      name: humanizeName(serviceName),
      type: 'service',
      responsibility: `Container service (${image})`,
      scaling: 'horizontal',
      confidence: 0.5,
      source,
      technologies: [image.split(':')[0]]
    }
  }

  return null
}

function humanizeName(name: string): string {
  return name
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim()
}

function toSnakeCase(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
}
