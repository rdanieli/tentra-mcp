import { basename } from 'path'
import { DetectedService, DetectedConnection } from '../types.js'

// Known database images for StatefulSet detection
const DB_IMAGES: Record<string, Omit<DetectedService, 'id' | 'confidence' | 'source'>> = {
  'postgres': { name: 'PostgreSQL', type: 'database', responsibility: 'Primary relational database', scaling: 'vertical', technologies: ['postgresql'] },
  'mysql': { name: 'MySQL', type: 'database', responsibility: 'Relational database', scaling: 'vertical', technologies: ['mysql'] },
  'mariadb': { name: 'MariaDB', type: 'database', responsibility: 'Relational database', scaling: 'vertical', technologies: ['mariadb'] },
  'mongo': { name: 'MongoDB', type: 'database', responsibility: 'Document database', scaling: 'horizontal', technologies: ['mongodb'] },
  'redis': { name: 'Redis', type: 'database', responsibility: 'In-memory cache and data store', scaling: 'horizontal', technologies: ['redis'] },
  'elasticsearch': { name: 'Elasticsearch', type: 'database', responsibility: 'Search and analytics engine', scaling: 'horizontal', technologies: ['elasticsearch'] },
  'cassandra': { name: 'Cassandra', type: 'database', responsibility: 'Wide-column distributed database', scaling: 'horizontal', technologies: ['cassandra'] },
}

interface K8sDocument {
  kind: string
  name: string
  namespace?: string
  image?: string
  images: string[]
  envVars: { name: string; value: string }[]
  ports: number[]
  raw: string
}

export function detectFromKubernetesManifest(
  content: string,
  filePath: string,
  _rootPath: string
): { services: DetectedService[]; connections: DetectedConnection[] } {
  const services: DetectedService[] = []
  const connections: DetectedConnection[] = []

  // Split multi-document YAML
  const documents = content.split(/^---$/m).filter(d => d.trim())

  for (const doc of documents) {
    const parsed = parseK8sDocument(doc)
    if (!parsed) continue

    if (parsed.kind === 'Deployment' || parsed.kind === 'ReplicaSet') {
      const svc = detectServiceFromDeployment(parsed, filePath)
      if (svc) services.push(svc)
    } else if (parsed.kind === 'StatefulSet') {
      const svc = detectServiceFromStatefulSet(parsed, filePath)
      if (svc) services.push(svc)
    } else if (parsed.kind === 'Ingress') {
      services.push({
        id: toSnakeCase(parsed.name || 'ingress'),
        name: humanizeName(parsed.name || 'Ingress'),
        type: 'api_gateway',
        responsibility: 'Kubernetes Ingress — routes external traffic to services',
        scaling: 'horizontal',
        confidence: 0.8,
        source: filePath,
        technologies: ['kubernetes', 'ingress']
      })
    } else if (parsed.kind === 'CronJob' || parsed.kind === 'Job') {
      services.push({
        id: toSnakeCase(parsed.name || 'job'),
        name: humanizeName(parsed.name || 'Job'),
        type: 'service',
        responsibility: `Scheduled ${parsed.kind.toLowerCase()} task`,
        scaling: 'none',
        confidence: 0.6,
        source: filePath,
        technologies: ['kubernetes']
      })
    }

    // Detect connections from env vars referencing other services
    for (const envVar of parsed.envVars) {
      const value = envVar.value.toLowerCase()
      // Look for service references in env vars (e.g., http://user-service:8080)
      const serviceRefMatch = value.match(/(?:https?:\/\/|)([a-z][a-z0-9-]+)(?::\d+|\.svc)/)
      if (serviceRefMatch) {
        const targetId = toSnakeCase(serviceRefMatch[1])
        const sourceId = toSnakeCase(parsed.name)
        if (sourceId !== targetId) {
          connections.push({
            from: sourceId,
            to: targetId,
            type: detectConnectionType(envVar.name, value),
            reason: `Env var ${envVar.name} references ${serviceRefMatch[1]}`,
            confidence: 0.6
          })
        }
      }
    }
  }

  return { services, connections }
}

function detectServiceFromDeployment(doc: K8sDocument, filePath: string): DetectedService | null {
  const name = doc.name
  if (!name) return null

  const id = toSnakeCase(name)
  const technologies: string[] = ['kubernetes']

  // Extract tech hints from images
  for (const img of doc.images) {
    const imgLower = img.toLowerCase()
    if (imgLower.includes('nginx') || imgLower.includes('envoy') || imgLower.includes('traefik')) {
      return {
        id, name: humanizeName(name), type: 'api_gateway',
        responsibility: `Reverse proxy / load balancer (${img.split(':')[0]})`,
        scaling: 'horizontal', confidence: 0.8, source: filePath,
        technologies: [...technologies, img.split(':')[0].split('/').pop() || '']
      }
    }
    // Check for known DB images in Deployments too
    for (const [pattern, info] of Object.entries(DB_IMAGES)) {
      if (imgLower.includes(pattern)) {
        return {
          id, ...info, confidence: 0.7, source: filePath,
          technologies: [...info.technologies, 'kubernetes']
        }
      }
    }
  }

  return {
    id,
    name: humanizeName(name),
    type: 'service',
    responsibility: `Kubernetes Deployment service`,
    scaling: 'horizontal',
    confidence: 0.6,
    source: filePath,
    technologies
  }
}

function detectServiceFromStatefulSet(doc: K8sDocument, filePath: string): DetectedService | null {
  const name = doc.name
  if (!name) return null

  const id = toSnakeCase(name)

  // Check images against known DB images
  for (const img of doc.images) {
    const imgLower = img.toLowerCase()
    for (const [pattern, info] of Object.entries(DB_IMAGES)) {
      if (imgLower.includes(pattern)) {
        return {
          id, ...info, confidence: 0.8, source: filePath,
          technologies: [...info.technologies, 'kubernetes']
        }
      }
    }
  }

  // StatefulSet with unknown image — likely a database or stateful service
  return {
    id,
    name: humanizeName(name),
    type: 'service',
    responsibility: 'Kubernetes StatefulSet (stateful application)',
    scaling: 'vertical',
    confidence: 0.6,
    source: filePath,
    technologies: ['kubernetes']
  }
}

function detectConnectionType(envName: string, value: string): 'sync_http' | 'async_event' | 'db_access' | 'grpc' {
  const nameLower = envName.toLowerCase()
  if (nameLower.includes('database') || nameLower.includes('db_') || nameLower.includes('_db') || nameLower.includes('datasource')) {
    return 'db_access'
  }
  if (nameLower.includes('kafka') || nameLower.includes('rabbit') || nameLower.includes('amqp') || nameLower.includes('queue')) {
    return 'async_event'
  }
  if (nameLower.includes('grpc') || value.includes('grpc')) {
    return 'grpc'
  }
  return 'sync_http'
}

// ─── Simple K8s YAML parser ─────────────────────────────────────────────────

function parseK8sDocument(doc: string): K8sDocument | null {
  const lines = doc.split('\n')
  let kind = ''
  let name = ''
  let namespace = ''
  const images: string[] = []
  const envVars: { name: string; value: string }[] = []
  const ports: number[] = []

  let inMetadata = false
  let inContainers = false
  let inEnv = false
  let currentEnvName = ''

  for (const line of lines) {
    const trimmed = line.trimStart()
    const indent = line.length - trimmed.length

    // Top-level kind
    if (trimmed.startsWith('kind:') && indent === 0) {
      kind = trimmed.replace('kind:', '').trim()
    }

    // metadata block
    if (trimmed === 'metadata:' && indent <= 2) {
      inMetadata = true
      inContainers = false
      inEnv = false
      continue
    }

    // Extract name from metadata
    if (inMetadata && trimmed.startsWith('name:') && indent <= 6) {
      const val = trimmed.replace('name:', '').trim().replace(/["']/g, '')
      if (!name) name = val
    }

    if (inMetadata && trimmed.startsWith('namespace:')) {
      namespace = trimmed.replace('namespace:', '').trim().replace(/["']/g, '')
    }

    // Detect end of metadata
    if (inMetadata && indent <= 0 && trimmed.endsWith(':') && !trimmed.startsWith('kind') && !trimmed.startsWith('apiVersion')) {
      inMetadata = false
    }

    // spec/template sections
    if (trimmed.startsWith('containers:') || trimmed.startsWith('initContainers:')) {
      inContainers = true
      inEnv = false
      continue
    }

    // Image detection
    if (inContainers && trimmed.startsWith('image:')) {
      const img = trimmed.replace('image:', '').trim().replace(/["']/g, '')
      if (img) images.push(img)
    }

    // Env detection
    if (trimmed === 'env:' || trimmed === 'envFrom:') {
      inEnv = true
      continue
    }

    if (inEnv && trimmed.startsWith('- name:')) {
      currentEnvName = trimmed.replace('- name:', '').trim().replace(/["']/g, '')
    }

    if (inEnv && trimmed.startsWith('value:') && currentEnvName) {
      const val = trimmed.replace('value:', '').trim().replace(/["']/g, '')
      envVars.push({ name: currentEnvName, value: val })
      currentEnvName = ''
    }

    // Port detection
    if (trimmed.startsWith('containerPort:') || trimmed.startsWith('port:')) {
      const portStr = trimmed.split(':')[1].trim()
      const port = parseInt(portStr, 10)
      if (!isNaN(port)) ports.push(port)
    }

    // Reset context on top-level keys
    if (indent === 0 && trimmed.endsWith(':') && trimmed !== 'kind:' && trimmed !== 'apiVersion:') {
      if (trimmed !== 'metadata:' && trimmed !== 'spec:') {
        inContainers = false
        inEnv = false
      }
    }
  }

  if (!kind) return null

  return { kind, name, namespace, images, envVars, ports, raw: doc }
}

// ─── Check if a file looks like a K8s manifest ─────────────────────────────

export function isKubernetesManifest(content: string): boolean {
  return /^kind:\s*(Deployment|Service|Ingress|StatefulSet|DaemonSet|CronJob|Job|ReplicaSet|ConfigMap|HorizontalPodAutoscaler)/m.test(content)
    && /^apiVersion:/m.test(content)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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
