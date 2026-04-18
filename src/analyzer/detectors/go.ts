import { dirname, relative } from 'path'
import { DetectedService } from '../types.js'

export function detectFromGoMod(
  content: string,
  filePath: string,
  rootPath: string
): DetectedService[] {
  const dir = dirname(filePath)
  const relDir = relative(rootPath, dir)
  const moduleLine = content.split('\n').find(l => l.startsWith('module '))
  const moduleName = moduleLine?.replace('module ', '').trim() || relDir || 'go-service'
  const shortName = moduleName.split('/').pop() || moduleName

  const technologies: string[] = ['go']
  let type: 'service' | 'api_gateway' = 'service'
  let responsibility = 'Go application service'

  if (content.includes('gin-gonic/gin')) { technologies.push('gin'); responsibility = 'Gin HTTP API service' }
  if (content.includes('go-chi/chi')) { technologies.push('chi'); responsibility = 'Chi HTTP API service' }
  if (content.includes('gofiber/fiber')) { technologies.push('fiber'); responsibility = 'Fiber HTTP API service' }
  if (content.includes('labstack/echo')) { technologies.push('echo'); responsibility = 'Echo HTTP API service' }
  if (content.includes('grpc/grpc-go')) { technologies.push('grpc'); responsibility = 'gRPC service' }
  if (content.includes('gorilla/mux')) technologies.push('gorilla-mux')
  if (content.includes('gorm.io/gorm')) technologies.push('gorm')
  if (content.includes('jmoiron/sqlx')) technologies.push('sqlx')
  if (content.includes('segmentio/kafka-go') || content.includes('confluentinc/confluent-kafka-go')) technologies.push('kafka')
  if (content.includes('streadway/amqp') || content.includes('rabbitmq/amqp091-go')) technologies.push('rabbitmq')
  if (content.includes('go-redis/redis') || content.includes('redis/go-redis')) technologies.push('redis')
  if (content.includes('KongHQ') || content.includes('traefik')) type = 'api_gateway'

  return [{
    id: toSnakeCase(shortName),
    name: humanizeName(shortName),
    type,
    responsibility,
    scaling: 'horizontal',
    confidence: 0.7,
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
