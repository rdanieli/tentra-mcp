export type ServiceType = 'api_gateway' | 'service' | 'database' | 'queue' | 'external'
export type ConnectionType = 'sync_http' | 'async_event' | 'db_access' | 'grpc'

export interface DetectedService {
  id: string
  name: string
  type: ServiceType
  responsibility: string
  scaling?: 'horizontal' | 'vertical' | 'none'
  /** 0-1 confidence score — higher wins in dedup */
  confidence: number
  /** Source file that detected this service */
  source: string
  /** Technologies detected (e.g., ['express', 'prisma', 'postgresql']) */
  technologies: string[]
}

export interface DetectedConnection {
  from: string
  to: string
  type: ConnectionType
  /** Why we think this connection exists */
  reason: string
  confidence: number
}

export interface AnalysisResult {
  services: DetectedService[]
  connections: DetectedConnection[]
  metadata: {
    rootPath: string
    scannedFiles: number
    detectedServices: number
    detectedConnections: number
  }
}

// ─── Known technology → service type mappings ────────────────────────────────

export const DB_TECHNOLOGIES = new Set([
  'pg', 'postgres', 'postgresql', 'mysql', 'mysql2', 'mariadb',
  'mongodb', 'mongoose', 'sequelize', 'typeorm', 'prisma', 'knex',
  'better-sqlite3', 'sqlite3', 'drizzle-orm', 'mikro-orm',
  'cassandra-driver', 'couchbase', 'dynamodb', 'neo4j-driver',
  'redis', 'ioredis'
])

export const QUEUE_TECHNOLOGIES = new Set([
  'kafkajs', 'kafka', 'amqplib', 'rabbitmq', 'bullmq', 'bull',
  'bee-queue', 'aws-sdk/client-sqs', '@aws-sdk/client-sqs',
  'aws-sdk/client-sns', '@aws-sdk/client-sns',
  'nats', '@google-cloud/pubsub', 'zeromq'
])

export const EXTERNAL_SERVICES: Record<string, { name: string; responsibility: string }> = {
  'stripe': { name: 'Stripe', responsibility: 'Payment processing and billing' },
  '@stripe/stripe-js': { name: 'Stripe', responsibility: 'Payment processing and billing' },
  'auth0': { name: 'Auth0', responsibility: 'Identity and access management' },
  '@auth0/nextjs-auth0': { name: 'Auth0', responsibility: 'Identity and access management' },
  'firebase': { name: 'Firebase', responsibility: 'Backend-as-a-service (auth, database, hosting)' },
  'firebase-admin': { name: 'Firebase', responsibility: 'Backend-as-a-service (auth, database, hosting)' },
  'twilio': { name: 'Twilio', responsibility: 'SMS and voice communication' },
  '@sendgrid/mail': { name: 'SendGrid', responsibility: 'Transactional email delivery' },
  'nodemailer': { name: 'Email Service', responsibility: 'Email delivery' },
  '@aws-sdk/client-s3': { name: 'AWS S3', responsibility: 'Object storage' },
  '@aws-sdk/client-ses': { name: 'AWS SES', responsibility: 'Email delivery' },
  '@aws-sdk/client-lambda': { name: 'AWS Lambda', responsibility: 'Serverless function execution' },
  '@aws-sdk/client-cognito-identity-provider': { name: 'AWS Cognito', responsibility: 'User identity and authentication' },
  '@google-cloud/storage': { name: 'Google Cloud Storage', responsibility: 'Object storage' },
  'openai': { name: 'OpenAI', responsibility: 'AI/LLM inference API' },
  '@anthropic-ai/sdk': { name: 'Anthropic', responsibility: 'AI/LLM inference API' },
  'cloudinary': { name: 'Cloudinary', responsibility: 'Image and video management' },
  'algolia': { name: 'Algolia', responsibility: 'Search-as-a-service' },
  '@elastic/elasticsearch': { name: 'Elasticsearch', responsibility: 'Search and analytics engine' },
  'datadog-metrics': { name: 'Datadog', responsibility: 'Monitoring and observability' },
  '@sentry/node': { name: 'Sentry', responsibility: 'Error tracking and monitoring' },
  'newrelic': { name: 'New Relic', responsibility: 'Application performance monitoring' },
  'launchdarkly-node-server-sdk': { name: 'LaunchDarkly', responsibility: 'Feature flag management' }
}

export const WEB_FRAMEWORKS = new Set([
  'react', 'next', 'vue', 'nuxt', 'svelte', '@sveltejs/kit', 'angular',
  'gatsby', 'remix', 'astro', 'solid-js', 'vite'
])

export const API_FRAMEWORKS = new Set([
  'express', 'fastify', 'koa', 'hapi', '@hapi/hapi', 'nestjs', '@nestjs/core',
  'hono', 'elysia', 'restify', 'polka', 'micro'
])

export const GATEWAY_INDICATORS = new Set([
  'http-proxy-middleware', 'express-gateway', 'kong', 'nginx',
  '@fastify/http-proxy', 'express-http-proxy', 'graphql-gateway',
  '@apollo/gateway', 'mercurius'
])
