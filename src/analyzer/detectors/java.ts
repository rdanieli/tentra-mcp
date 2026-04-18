import { dirname, relative } from 'path'
import { DetectedService } from '../types.js'

// ─── AWS SDK artifact → external service mapping ────────────────────────────
const AWS_SDK_SERVICES: Record<string, { name: string; responsibility: string }> = {
  's3': { name: 'AWS S3', responsibility: 'Object storage' },
  'sqs': { name: 'AWS SQS', responsibility: 'Message queue service' },
  'sns': { name: 'AWS SNS', responsibility: 'Pub/sub notification service' },
  'cognitoidentityprovider': { name: 'AWS Cognito', responsibility: 'User identity and authentication' },
  'cognito': { name: 'AWS Cognito', responsibility: 'User identity and authentication' },
  'lambda': { name: 'AWS Lambda', responsibility: 'Serverless function execution' },
  'ses': { name: 'AWS SES', responsibility: 'Email delivery' },
  'eventbridge': { name: 'AWS EventBridge', responsibility: 'Serverless event bus' },
}

export function detectFromPomXml(
  content: string,
  filePath: string,
  rootPath: string
): DetectedService[] {
  const services: DetectedService[] = []
  const dir = dirname(filePath)
  const relDir = relative(rootPath, dir)

  // Skip parent poms (they have <modules>)
  if (content.includes('<modules>')) return []

  const artifactId = extractTag(content, 'artifactId')
  const name = humanizeName(artifactId || relDir || 'java-service')
  const id = toSnakeCase(artifactId || relDir || 'java_service')

  const technologies: string[] = ['java']
  let type: 'service' | 'api_gateway' = 'service'
  let responsibility = 'Java application service'

  // Detect frameworks from dependencies
  if (content.includes('spring-boot')) {
    technologies.push('spring-boot')
    responsibility = 'Spring Boot application'
  }
  if (content.includes('spring-cloud-gateway') || content.includes('zuul')) {
    type = 'api_gateway'
    responsibility = 'API gateway routing and filtering'
  }
  if (content.includes('quarkus')) {
    technologies.push('quarkus')
    responsibility = 'Quarkus application'
  }
  if (content.includes('micronaut')) {
    technologies.push('micronaut')
    responsibility = 'Micronaut application'
  }
  if (content.includes('camel')) {
    technologies.push('apache-camel')
    responsibility += ' with Apache Camel integration routes'
  }
  if (content.includes('hibernate') || content.includes('jpa')) {
    technologies.push('jpa')
  }
  if (content.includes('kafka')) technologies.push('kafka')
  if (content.includes('rabbitmq') || content.includes('amqp')) technologies.push('rabbitmq')
  if (content.includes('grpc')) technologies.push('grpc')

  // Detect Flyway/Liquibase → implies a database exists
  if (content.includes('flyway') || content.includes('liquibase')) {
    technologies.push(content.includes('flyway') ? 'flyway' : 'liquibase')
    services.push({
      id: `${id}_database`,
      name: `${name} Database`,
      type: 'database',
      responsibility: 'Relational database (detected via migration tool)',
      scaling: 'vertical',
      confidence: 0.5,
      source: filePath,
      technologies: ['postgresql']
    })
  }

  // Detect AWS SDK dependencies (v2: software.amazon.awssdk)
  if (content.includes('software.amazon.awssdk') || content.includes('com.amazonaws')) {
    for (const [artifactKey, info] of Object.entries(AWS_SDK_SERVICES)) {
      // Match artifact IDs like <artifactId>s3</artifactId>, <artifactId>sqs</artifactId>, etc.
      const pattern = new RegExp(`<artifactId>${artifactKey}</artifactId>`, 'i')
      // Also match aws-java-sdk-<service> for SDK v1
      const v1Pattern = new RegExp(`aws-java-sdk-${artifactKey}`, 'i')
      if (pattern.test(content) || v1Pattern.test(content)) {
        const extId = toSnakeCase(info.name)
        services.push({
          id: extId,
          name: info.name,
          type: 'external',
          responsibility: info.responsibility,
          scaling: 'horizontal',
          confidence: 0.7,
          source: filePath,
          technologies: ['aws', artifactKey]
        })
      }
    }
  }

  // Detect Quarkus AWS extensions and Camel AWS components
  const QUARKUS_AWS: Record<string, { name: string; type: 'external' | 'database' | 'queue'; responsibility: string }> = {
    'quarkus-amazon-cognito': { name: 'AWS Cognito', type: 'external', responsibility: 'User identity and authentication' },
    'quarkus-amazon-s3': { name: 'AWS S3', type: 'database', responsibility: 'Object storage' },
    'quarkus-amazon-sqs': { name: 'AWS SQS', type: 'queue', responsibility: 'Message queue service' },
    'quarkus-amazon-sns': { name: 'AWS SNS', type: 'queue', responsibility: 'Pub/sub notification service' },
    'quarkus-amazon-ses': { name: 'AWS SES', type: 'external', responsibility: 'Email delivery' },
    'quarkus-amazon-lambda': { name: 'AWS Lambda', type: 'external', responsibility: 'Serverless function execution' },
    'quarkus-amazon-rds': { name: 'AWS RDS', type: 'database', responsibility: 'Managed relational database' },
    'quarkus-amazon-eventbridge': { name: 'AWS EventBridge', type: 'queue', responsibility: 'Serverless event bus' },
    'camel-quarkus-aws2-s3': { name: 'AWS S3', type: 'database', responsibility: 'Object storage' },
    'camel-quarkus-aws2-sqs': { name: 'AWS SQS', type: 'queue', responsibility: 'Message queue service' },
    'camel-quarkus-aws2-sns': { name: 'AWS SNS', type: 'queue', responsibility: 'Pub/sub notification service' },
    'camel-quarkus-aws2-ses': { name: 'AWS SES', type: 'external', responsibility: 'Email delivery' },
    'camel-quarkus-aws2-eventbridge': { name: 'AWS EventBridge', type: 'queue', responsibility: 'Serverless event bus' },
  }
  for (const [artifact, info] of Object.entries(QUARKUS_AWS)) {
    if (content.includes(artifact)) {
      const extId = toSnakeCase(info.name)
      if (!services.some(s => s.id === extId)) {
        services.push({
          id: extId, name: info.name, type: info.type,
          responsibility: info.responsibility, scaling: 'horizontal',
          confidence: 0.75, source: filePath, technologies: ['aws', artifact]
        })
      }
    }
  }

  // Detect Stripe dependency
  if (content.includes('com.stripe')) {
    services.push({
      id: 'stripe',
      name: 'Stripe',
      type: 'external',
      responsibility: 'Payment processing and billing',
      scaling: 'horizontal',
      confidence: 0.8,
      source: filePath,
      technologies: ['stripe']
    })
  }

  services.push({
    id, name, type, responsibility,
    scaling: 'horizontal',
    confidence: 0.7,
    source: filePath,
    technologies
  })

  return services
}

// ─── application.yml / application.properties parsing ───────────────────────

export function detectFromApplicationConfig(
  content: string,
  filePath: string,
  rootPath: string
): DetectedService[] {
  const services: DetectedService[] = []
  const isProperties = filePath.endsWith('.properties')

  // Flatten config to key=value pairs
  const props: Map<string, string> = isProperties
    ? parseProperties(content)
    : flattenYaml(content)

  // Detect database connections
  for (const [key, value] of props) {
    const keyLower = key.toLowerCase()

    // Spring / Quarkus datasource URL
    if (
      keyLower.includes('spring.datasource.url') ||
      keyLower.includes('quarkus.datasource.jdbc.url') ||
      keyLower.includes('spring.r2dbc.url')
    ) {
      const dbType = detectDbTypeFromUrl(value)
      services.push({
        id: `${dbType}_database`,
        name: `${humanizeName(dbType)} Database`,
        type: 'database',
        responsibility: `${humanizeName(dbType)} relational database`,
        scaling: 'vertical',
        confidence: 0.8,
        source: filePath,
        technologies: [dbType]
      })
    }

    // Redis connections
    if (keyLower.includes('spring.redis.host') || keyLower.includes('spring.data.redis.host')) {
      services.push({
        id: 'redis_cache',
        name: 'Redis',
        type: 'database',
        responsibility: 'In-memory cache and data store',
        scaling: 'horizontal',
        confidence: 0.8,
        source: filePath,
        technologies: ['redis']
      })
    }

    // Kafka
    if (keyLower.includes('spring.kafka.bootstrap-servers') || keyLower.includes('spring.kafka.bootstrap.servers')) {
      services.push({
        id: 'kafka',
        name: 'Kafka',
        type: 'queue',
        responsibility: 'Event streaming platform',
        scaling: 'horizontal',
        confidence: 0.8,
        source: filePath,
        technologies: ['kafka']
      })
    }

    // External service URLs — any property ending in .url or .uri
    if ((keyLower.endsWith('.url') || keyLower.endsWith('.uri')) && value.includes('://')) {
      // Skip datasource and internal framework URLs
      if (
        keyLower.includes('datasource') ||
        keyLower.includes('redis') ||
        keyLower.includes('kafka') ||
        keyLower.includes('eureka') ||
        keyLower.includes('config.uri')
      ) continue

      const serviceName = extractServiceNameFromKey(key)
      if (serviceName) {
        const extId = toSnakeCase(serviceName)
        services.push({
          id: `${extId}_external`,
          name: humanizeName(serviceName),
          type: 'external',
          responsibility: `External service (${value.replace(/\/\/.*@/, '//***@')})`,
          scaling: 'horizontal',
          confidence: 0.5,
          source: filePath,
          technologies: []
        })
      }
    }
  }

  return services
}

function detectDbTypeFromUrl(url: string): string {
  const lower = url.toLowerCase()
  if (lower.includes('postgresql') || lower.includes('postgres')) return 'postgresql'
  if (lower.includes('mysql')) return 'mysql'
  if (lower.includes('mariadb')) return 'mariadb'
  if (lower.includes('oracle')) return 'oracle'
  if (lower.includes('sqlserver') || lower.includes('mssql')) return 'sqlserver'
  if (lower.includes('h2')) return 'h2'
  if (lower.includes('mongodb')) return 'mongodb'
  return 'sql'
}

function extractServiceNameFromKey(key: string): string | null {
  // e.g. "app.payment-service.url" → "payment-service"
  // e.g. "external.api.stripe.url" → "stripe"
  const parts = key.split('.')
  // Remove the trailing .url/.uri
  parts.pop()
  // Take the last meaningful part
  const candidate = parts.pop()
  if (!candidate || candidate.length < 2) return null
  // Skip very generic names
  if (['server', 'spring', 'app', 'application', 'management'].includes(candidate.toLowerCase())) return null
  return candidate
}

// ─── Simple property/YAML parsers ───────────────────────────────────────────

function parseProperties(content: string): Map<string, string> {
  const props = new Map<string, string>()
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.substring(0, eqIdx).trim()
    const value = trimmed.substring(eqIdx + 1).trim()
    props.set(key, value)
  }
  return props
}

function flattenYaml(content: string, prefix: string = ''): Map<string, string> {
  const props = new Map<string, string>()
  const lines = content.split('\n')
  const stack: { indent: number; key: string }[] = []

  for (const line of lines) {
    const trimmed = line.trimStart()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) continue
    // Skip array items for now
    if (trimmed.startsWith('- ')) continue

    const indent = line.length - trimmed.length
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) continue

    const key = trimmed.substring(0, colonIdx).trim()
    const value = trimmed.substring(colonIdx + 1).trim()

    // Pop stack to find parent
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop()
    }

    const fullKey = stack.length > 0
      ? `${stack[stack.length - 1].key}.${key}`
      : key

    if (value && !value.startsWith('{')) {
      // Remove quotes
      props.set(fullKey, value.replace(/^["']|["']$/g, ''))
    }

    stack.push({ indent, key: fullKey })
  }

  return props
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function extractTag(xml: string, tag: string): string | null {
  // Get the first occurrence (project-level, not parent)
  const parentEnd = xml.indexOf('</parent>')
  const searchFrom = parentEnd > -1 ? parentEnd : 0
  const regex = new RegExp(`<${tag}>([^<]+)</${tag}>`)
  const match = xml.substring(searchFrom).match(regex)
  return match ? match[1].trim() : null
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
