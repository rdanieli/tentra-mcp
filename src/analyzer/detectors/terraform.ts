import { basename } from 'path'
import { DetectedService, DetectedConnection, ServiceType } from '../types.js'

// ─── Resource type → service mapping ────────────────────────────────────────

interface ResourceMapping {
  type: ServiceType
  name: string
  responsibility: string
  technologies: string[]
  scaling?: 'horizontal' | 'vertical' | 'none'
}

const RESOURCE_MAPPINGS: Record<string, ResourceMapping> = {
  // AWS Databases
  'aws_rds_instance': { type: 'database', name: 'RDS Database', responsibility: 'Managed relational database (RDS)', technologies: ['aws', 'rds'], scaling: 'vertical' },
  'aws_db_instance': { type: 'database', name: 'RDS Database', responsibility: 'Managed relational database (RDS)', technologies: ['aws', 'rds'], scaling: 'vertical' },
  'aws_rds_cluster': { type: 'database', name: 'Aurora Database', responsibility: 'Managed Aurora database cluster', technologies: ['aws', 'aurora'], scaling: 'horizontal' },
  'aws_dynamodb_table': { type: 'database', name: 'DynamoDB', responsibility: 'NoSQL key-value and document database', technologies: ['aws', 'dynamodb'], scaling: 'horizontal' },
  'aws_elasticache_cluster': { type: 'database', name: 'ElastiCache', responsibility: 'Managed in-memory cache (Redis/Memcached)', technologies: ['aws', 'elasticache'], scaling: 'horizontal' },
  'aws_elasticache_replication_group': { type: 'database', name: 'ElastiCache Redis', responsibility: 'Managed Redis replication group', technologies: ['aws', 'redis'], scaling: 'horizontal' },
  'aws_elasticsearch_domain': { type: 'database', name: 'Elasticsearch', responsibility: 'Managed search and analytics', technologies: ['aws', 'elasticsearch'], scaling: 'horizontal' },
  'aws_opensearch_domain': { type: 'database', name: 'OpenSearch', responsibility: 'Managed search and analytics', technologies: ['aws', 'opensearch'], scaling: 'horizontal' },
  'aws_s3_bucket': { type: 'database', name: 'S3 Bucket', responsibility: 'Object storage', technologies: ['aws', 's3'], scaling: 'horizontal' },

  // AWS Queues
  'aws_sqs_queue': { type: 'queue', name: 'SQS Queue', responsibility: 'Managed message queue', technologies: ['aws', 'sqs'], scaling: 'horizontal' },
  'aws_sns_topic': { type: 'queue', name: 'SNS Topic', responsibility: 'Pub/sub notification topic', technologies: ['aws', 'sns'], scaling: 'horizontal' },
  'aws_kinesis_stream': { type: 'queue', name: 'Kinesis Stream', responsibility: 'Real-time data streaming', technologies: ['aws', 'kinesis'], scaling: 'horizontal' },
  'aws_msk_cluster': { type: 'queue', name: 'MSK Kafka', responsibility: 'Managed Kafka cluster', technologies: ['aws', 'kafka'], scaling: 'horizontal' },

  // AWS Compute
  'aws_lambda_function': { type: 'service', name: 'Lambda Function', responsibility: 'Serverless function execution', technologies: ['aws', 'lambda'], scaling: 'horizontal' },
  'aws_ecs_service': { type: 'service', name: 'ECS Service', responsibility: 'Container orchestration service', technologies: ['aws', 'ecs'], scaling: 'horizontal' },
  'aws_ecs_task_definition': { type: 'service', name: 'ECS Task', responsibility: 'Container task definition', technologies: ['aws', 'ecs'], scaling: 'horizontal' },
  'aws_eks_cluster': { type: 'service', name: 'EKS Cluster', responsibility: 'Managed Kubernetes cluster', technologies: ['aws', 'kubernetes'], scaling: 'horizontal' },

  // AWS Gateways
  'aws_api_gateway_rest_api': { type: 'api_gateway', name: 'API Gateway', responsibility: 'REST API gateway', technologies: ['aws', 'api-gateway'], scaling: 'horizontal' },
  'aws_apigatewayv2_api': { type: 'api_gateway', name: 'API Gateway v2', responsibility: 'HTTP/WebSocket API gateway', technologies: ['aws', 'api-gateway'], scaling: 'horizontal' },
  'aws_lb': { type: 'api_gateway', name: 'Load Balancer', responsibility: 'Application/Network load balancer', technologies: ['aws', 'alb'], scaling: 'horizontal' },
  'aws_alb': { type: 'api_gateway', name: 'Application Load Balancer', responsibility: 'Application load balancer', technologies: ['aws', 'alb'], scaling: 'horizontal' },

  // AWS External
  'aws_cognito_user_pool': { type: 'external', name: 'Cognito', responsibility: 'User identity and authentication', technologies: ['aws', 'cognito'], scaling: 'horizontal' },
  'aws_ses_domain_identity': { type: 'external', name: 'SES', responsibility: 'Email delivery service', technologies: ['aws', 'ses'], scaling: 'horizontal' },

  // GCP
  'google_cloud_run_service': { type: 'service', name: 'Cloud Run Service', responsibility: 'Serverless container service', technologies: ['gcp', 'cloud-run'], scaling: 'horizontal' },
  'google_cloud_run_v2_service': { type: 'service', name: 'Cloud Run Service', responsibility: 'Serverless container service', technologies: ['gcp', 'cloud-run'], scaling: 'horizontal' },
  'google_sql_database_instance': { type: 'database', name: 'Cloud SQL', responsibility: 'Managed relational database', technologies: ['gcp', 'cloud-sql'], scaling: 'vertical' },
  'google_redis_instance': { type: 'database', name: 'Memorystore Redis', responsibility: 'Managed Redis instance', technologies: ['gcp', 'redis'], scaling: 'vertical' },
  'google_pubsub_topic': { type: 'queue', name: 'Pub/Sub Topic', responsibility: 'Message pub/sub topic', technologies: ['gcp', 'pubsub'], scaling: 'horizontal' },
  'google_cloudfunctions_function': { type: 'service', name: 'Cloud Function', responsibility: 'Serverless function', technologies: ['gcp', 'cloud-functions'], scaling: 'horizontal' },
  'google_cloudfunctions2_function': { type: 'service', name: 'Cloud Function', responsibility: 'Serverless function (v2)', technologies: ['gcp', 'cloud-functions'], scaling: 'horizontal' },

  // Azure
  'azurerm_app_service': { type: 'service', name: 'App Service', responsibility: 'Managed web application hosting', technologies: ['azure', 'app-service'], scaling: 'horizontal' },
  'azurerm_app_service_plan': { type: 'service', name: 'App Service Plan', responsibility: 'App Service compute plan', technologies: ['azure', 'app-service'], scaling: 'horizontal' },
  'azurerm_function_app': { type: 'service', name: 'Azure Function', responsibility: 'Serverless function execution', technologies: ['azure', 'functions'], scaling: 'horizontal' },
  'azurerm_mssql_server': { type: 'database', name: 'Azure SQL', responsibility: 'Managed SQL Server database', technologies: ['azure', 'sqlserver'], scaling: 'vertical' },
  'azurerm_cosmosdb_account': { type: 'database', name: 'Cosmos DB', responsibility: 'Globally distributed multi-model database', technologies: ['azure', 'cosmosdb'], scaling: 'horizontal' },
  'azurerm_redis_cache': { type: 'database', name: 'Azure Redis', responsibility: 'Managed Redis cache', technologies: ['azure', 'redis'], scaling: 'horizontal' },
  'azurerm_servicebus_namespace': { type: 'queue', name: 'Service Bus', responsibility: 'Enterprise message broker', technologies: ['azure', 'servicebus'], scaling: 'horizontal' },
  'azurerm_eventhub_namespace': { type: 'queue', name: 'Event Hub', responsibility: 'Event streaming platform', technologies: ['azure', 'eventhub'], scaling: 'horizontal' },
}

export function detectFromTerraform(
  content: string,
  filePath: string,
  _rootPath: string
): { services: DetectedService[]; connections: DetectedConnection[] } {
  const services: DetectedService[] = []
  const connections: DetectedConnection[] = []

  // Parse resource blocks
  const resources = parseResourceBlocks(content)

  for (const resource of resources) {
    const mapping = RESOURCE_MAPPINGS[resource.type]
    if (!mapping) continue

    const resourceName = resource.name
    const id = toSnakeCase(`${mapping.name}_${resourceName}`)

    // Try to extract a better name from tags or the resource name
    const displayName = resource.tags?.Name || resource.tags?.name || `${mapping.name} (${resourceName})`

    services.push({
      id,
      name: displayName,
      type: mapping.type,
      responsibility: mapping.responsibility,
      scaling: mapping.scaling || 'horizontal',
      confidence: 0.7,
      source: filePath,
      technologies: [...mapping.technologies]
    })

    // Detect connections from resource references
    // Lambda → API Gateway integration
    if (resource.type === 'aws_api_gateway_integration' || resource.type === 'aws_apigatewayv2_integration') {
      // These typically reference a lambda
      if (resource.body.includes('lambda') || resource.body.includes('aws_lambda_function')) {
        // Connection will be inferred by the connection engine
      }
    }
  }

  // Also detect connections from references in resource bodies
  // e.g., aws_lambda_function referencing an SQS queue ARN
  const serviceIds = new Set(services.map(s => s.id))
  for (const resource of resources) {
    const mapping = RESOURCE_MAPPINGS[resource.type]
    if (!mapping) continue

    const sourceId = toSnakeCase(`${mapping.name}_${resource.name}`)
    if (!serviceIds.has(sourceId)) continue

    // Look for references to other resources in the body
    for (const svc of services) {
      if (svc.id === sourceId) continue
      // Check if this resource body references the other resource's Terraform name
      // Terraform references look like: aws_sqs_queue.my_queue.arn
      const refPattern = new RegExp(`\\b${escapeRegex(svc.id)}\\b|\\b${escapeRegex(svc.name)}\\b`, 'i')
      if (refPattern.test(resource.body)) {
        const connType = svc.type === 'database' ? 'db_access' as const
          : svc.type === 'queue' ? 'async_event' as const
          : 'sync_http' as const
        connections.push({
          from: sourceId,
          to: svc.id,
          type: connType,
          reason: `Terraform resource references ${svc.name}`,
          confidence: 0.5
        })
      }
    }
  }

  return { services, connections }
}

// ─── Simple .tf parser ──────────────────────────────────────────────────────

interface TerraformResource {
  type: string
  name: string
  body: string
  tags: Record<string, string>
}

function parseResourceBlocks(content: string): TerraformResource[] {
  const resources: TerraformResource[] = []

  // Match resource "type" "name" { ... }
  const resourceRegex = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g
  let match

  while ((match = resourceRegex.exec(content)) !== null) {
    const type = match[1]
    const name = match[2]
    const startIdx = match.index + match[0].length

    // Find matching closing brace
    let depth = 1
    let i = startIdx
    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++
      if (content[i] === '}') depth--
      i++
    }

    const body = content.substring(startIdx, i - 1)
    const tags = extractTags(body)

    resources.push({ type, name, body, tags })
  }

  return resources
}

function extractTags(body: string): Record<string, string> {
  const tags: Record<string, string> = {}

  // Look for tags = { ... } or tags block
  const tagsMatch = body.match(/tags\s*=\s*\{([^}]*)\}/s)
  if (tagsMatch) {
    const tagsBlock = tagsMatch[1]
    const tagLines = tagsBlock.split('\n')
    for (const line of tagLines) {
      const trimmed = line.trim()
      const eqMatch = trimmed.match(/^(\w+)\s*=\s*"([^"]*)"/)
      if (eqMatch) {
        tags[eqMatch[1]] = eqMatch[2]
      }
    }
  }

  return tags
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
