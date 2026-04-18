import { dirname, relative, basename } from 'path'
import { DetectedService } from '../types.js'

export function detectFromPython(
  content: string,
  filePath: string,
  rootPath: string,
  fileName: string
): DetectedService[] {
  const dir = dirname(filePath)
  const relDir = relative(rootPath, dir)
  const projectName = basename(dir) || 'python-service'

  const technologies: string[] = ['python']
  let type: 'service' | 'api_gateway' = 'service'
  let responsibility = 'Python application service'

  const lower = content.toLowerCase()

  // Detect frameworks
  if (lower.includes('fastapi')) { technologies.push('fastapi'); responsibility = 'FastAPI REST service' }
  else if (lower.includes('django')) { technologies.push('django'); responsibility = 'Django web application' }
  else if (lower.includes('flask')) { technologies.push('flask'); responsibility = 'Flask web application' }
  else if (lower.includes('starlette')) { technologies.push('starlette'); responsibility = 'Starlette ASGI service' }
  else if (lower.includes('tornado')) { technologies.push('tornado'); responsibility = 'Tornado async web service' }
  else if (lower.includes('celery')) { technologies.push('celery'); responsibility = 'Celery distributed task worker' }
  else if (lower.includes('airflow')) { technologies.push('airflow'); responsibility = 'Apache Airflow DAG orchestrator' }

  // Detect data/ML
  if (lower.includes('pandas') || lower.includes('numpy') || lower.includes('scikit')) {
    technologies.push('data-science')
    if (responsibility === 'Python application service') responsibility = 'Data processing service'
  }
  if (lower.includes('transformers') || lower.includes('torch') || lower.includes('tensorflow')) {
    technologies.push('ml')
    responsibility = 'ML inference service'
  }

  // Detect database drivers
  if (lower.includes('psycopg') || lower.includes('asyncpg')) technologies.push('postgresql')
  if (lower.includes('sqlalchemy')) technologies.push('sqlalchemy')
  if (lower.includes('pymongo') || lower.includes('motor')) technologies.push('mongodb')
  if (lower.includes('redis') || lower.includes('aioredis')) technologies.push('redis')

  // Detect queues
  if (lower.includes('confluent-kafka') || lower.includes('aiokafka')) technologies.push('kafka')
  if (lower.includes('pika') || lower.includes('aio-pika')) technologies.push('rabbitmq')
  if (lower.includes('boto3') || lower.includes('aioboto')) technologies.push('aws-sdk')

  return [{
    id: toSnakeCase(projectName),
    name: humanizeName(projectName),
    type,
    responsibility,
    scaling: 'horizontal',
    confidence: 0.6,
    source: filePath,
    technologies
  }]
}

function humanizeName(name: string): string {
  return name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim()
}

function toSnakeCase(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase()
}
