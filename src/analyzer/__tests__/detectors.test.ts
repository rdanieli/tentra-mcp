import { describe, it, expect } from 'vitest'
import { detectFromPackageJson } from '../detectors/node.js'
import { detectFromDockerCompose } from '../detectors/docker.js'
import { detectFromPomXml } from '../detectors/java.js'
import { detectFromGoMod } from '../detectors/go.js'
import { detectFromPython } from '../detectors/python.js'

// ─── Node.js Detector ────────────────────────────────────────────────────────

describe('detectFromPackageJson', () => {
  const root = '/project'
  const filePath = '/project/services/api/package.json'

  it('should detect an Express service', () => {
    const content = JSON.stringify({
      name: 'my-api',
      dependencies: { express: '^4.18.0' },
    })
    const result = detectFromPackageJson(content, filePath, root)
    const service = result.find(s => s.type === 'service')
    expect(service).toBeDefined()
    expect(service!.id).toBe('my_api')
    expect(service!.technologies).toContain('express')
  })

  it('should detect a React web service', () => {
    const content = JSON.stringify({
      name: 'web-app',
      dependencies: { react: '^18.0.0' },
    })
    const result = detectFromPackageJson(content, filePath, root)
    const service = result.find(s => s.type === 'service')
    expect(service).toBeDefined()
    expect(service!.technologies).toContain('react')
    expect(service!.responsibility).toContain('Web frontend')
  })

  it('should detect PostgreSQL database from prisma dependency', () => {
    const content = JSON.stringify({
      name: 'my-api',
      dependencies: { express: '^4.18.0', prisma: '^5.0.0' },
    })
    const result = detectFromPackageJson(content, filePath, root)
    const db = result.find(s => s.type === 'database' && s.id === 'postgresql')
    expect(db).toBeDefined()
    expect(db!.technologies).toContain('postgresql')
    expect(db!.technologies).toContain('prisma')
  })

  it('should detect Redis from redis dependency', () => {
    const content = JSON.stringify({
      name: 'my-api',
      dependencies: { express: '^4.18.0', redis: '^4.0.0' },
    })
    const result = detectFromPackageJson(content, filePath, root)
    const redis = result.find(s => s.id === 'redis')
    expect(redis).toBeDefined()
    expect(redis!.type).toBe('database')
  })

  it('should detect Stripe as an external service', () => {
    const content = JSON.stringify({
      name: 'my-api',
      dependencies: { express: '^4.18.0', stripe: '^13.0.0' },
    })
    const result = detectFromPackageJson(content, filePath, root)
    const stripe = result.find(s => s.type === 'external' && s.name === 'Stripe')
    expect(stripe).toBeDefined()
    expect(stripe!.responsibility).toContain('Payment')
  })

  it('should NOT create a service for root monorepo package.json with workspaces', () => {
    const content = JSON.stringify({
      name: 'monorepo',
      workspaces: ['packages/*'],
      dependencies: { express: '^4.18.0' },
    })
    const rootPkg = '/project/package.json'
    const result = detectFromPackageJson(content, rootPkg, root)
    // Should not have a service type entry (only externals from deps)
    const service = result.find(s => s.type === 'service')
    expect(service).toBeUndefined()
  })

  it('should detect Kafka queue from kafkajs dependency', () => {
    const content = JSON.stringify({
      name: 'event-processor',
      dependencies: { express: '^4.18.0', kafkajs: '^2.0.0' },
    })
    const result = detectFromPackageJson(content, filePath, root)
    const kafka = result.find(s => s.type === 'queue' && s.id === 'kafka')
    expect(kafka).toBeDefined()
    expect(kafka!.technologies).toContain('kafka')
  })
})

// ─── Docker Compose Detector ─────────────────────────────────────────────────

describe('detectFromDockerCompose', () => {
  const root = '/project'
  const filePath = '/project/docker-compose.yml'

  it('should detect postgres as a database', () => {
    const content = `
services:
  db:
    image: postgres:16
    ports:
      - "5432:5432"
`
    const result = detectFromDockerCompose(content, filePath, root)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('database')
    expect(result[0].name).toBe('PostgreSQL')
    expect(result[0].technologies).toContain('postgresql')
  })

  it('should detect redis, nginx, and custom build service', () => {
    const content = `
services:
  cache:
    image: redis:7
  proxy:
    image: nginx:latest
  app:
    build: ./app
`
    const result = detectFromDockerCompose(content, filePath, root)
    expect(result).toHaveLength(3)

    const redis = result.find(s => s.name === 'Redis')
    expect(redis).toBeDefined()
    expect(redis!.type).toBe('database')

    const nginx = result.find(s => s.name === 'Nginx')
    expect(nginx).toBeDefined()
    expect(nginx!.type).toBe('api_gateway')

    const app = result.find(s => s.id === 'app')
    expect(app).toBeDefined()
    expect(app!.type).toBe('service')
    expect(app!.responsibility).toContain('Custom application')
  })

  it('should still create a service for an unknown image', () => {
    const content = `
services:
  custom-thing:
    image: some-random/image:latest
`
    const result = detectFromDockerCompose(content, filePath, root)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('service')
    expect(result[0].confidence).toBe(0.5)
  })

  it('should detect kafka image as a queue', () => {
    const content = `
services:
  broker:
    image: confluentinc/cp-kafka:7.5.0
`
    const result = detectFromDockerCompose(content, filePath, root)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('queue')
    expect(result[0].name).toBe('Kafka')
  })
})

// ─── Java Detector ───────────────────────────────────────────────────────────

describe('detectFromPomXml', () => {
  const root = '/project'
  const filePath = '/project/services/payment/pom.xml'

  it('should detect a Spring Boot service', () => {
    const content = `
<project>
  <artifactId>payment-service</artifactId>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
</project>
`
    const result = detectFromPomXml(content, filePath, root)
    const svc = result.find(s => s.type === 'service')
    expect(svc).toBeDefined()
    expect(svc!.technologies).toContain('spring-boot')
    expect(svc!.responsibility).toContain('Spring Boot')
  })

  it('should detect a Quarkus service with Camel', () => {
    const content = `
<project>
  <artifactId>integration-service</artifactId>
  <dependencies>
    <dependency>
      <groupId>io.quarkus</groupId>
      <artifactId>quarkus-core</artifactId>
    </dependency>
    <dependency>
      <groupId>org.apache.camel.quarkus</groupId>
      <artifactId>camel-quarkus-core</artifactId>
    </dependency>
  </dependencies>
</project>
`
    const result = detectFromPomXml(content, filePath, root)
    const svc = result.find(s => s.type === 'service')
    expect(svc).toBeDefined()
    expect(svc!.technologies).toContain('quarkus')
    expect(svc!.technologies).toContain('apache-camel')
    expect(svc!.responsibility).toContain('Camel')
  })

  it('should detect a database from Flyway dependency', () => {
    const content = `
<project>
  <artifactId>user-service</artifactId>
  <dependencies>
    <dependency>
      <groupId>org.flywaydb</groupId>
      <artifactId>flyway-core</artifactId>
    </dependency>
  </dependencies>
</project>
`
    const result = detectFromPomXml(content, filePath, root)
    const db = result.find(s => s.type === 'database')
    expect(db).toBeDefined()
    expect(db!.responsibility).toContain('migration tool')
  })

  it('should detect Stripe external service', () => {
    const content = `
<project>
  <artifactId>billing-service</artifactId>
  <dependencies>
    <dependency>
      <groupId>com.stripe</groupId>
      <artifactId>stripe-java</artifactId>
    </dependency>
  </dependencies>
</project>
`
    const result = detectFromPomXml(content, filePath, root)
    const stripe = result.find(s => s.type === 'external' && s.id === 'stripe')
    expect(stripe).toBeDefined()
    expect(stripe!.responsibility).toContain('Payment')
  })

  it('should detect AWS Cognito from quarkus-amazon-cognito', () => {
    const content = `
<project>
  <artifactId>auth-service</artifactId>
  <dependencies>
    <dependency>
      <groupId>io.quarkus</groupId>
      <artifactId>quarkus-amazon-cognito</artifactId>
    </dependency>
  </dependencies>
</project>
`
    const result = detectFromPomXml(content, filePath, root)
    const cognito = result.find(s => s.name === 'AWS Cognito')
    expect(cognito).toBeDefined()
    expect(cognito!.type).toBe('external')
  })

  it('should detect AWS S3 from camel-quarkus-aws2-s3', () => {
    const content = `
<project>
  <artifactId>file-service</artifactId>
  <dependencies>
    <dependency>
      <groupId>org.apache.camel.quarkus</groupId>
      <artifactId>camel-quarkus-aws2-s3</artifactId>
    </dependency>
  </dependencies>
</project>
`
    const result = detectFromPomXml(content, filePath, root)
    const s3 = result.find(s => s.name === 'AWS S3')
    expect(s3).toBeDefined()
    expect(s3!.type).toBe('database')
    expect(s3!.responsibility).toContain('Object storage')
  })
})

// ─── Go Detector ─────────────────────────────────────────────────────────────

describe('detectFromGoMod', () => {
  const root = '/project'
  const filePath = '/project/services/gateway/go.mod'

  it('should detect a Gin service', () => {
    const content = `module github.com/myorg/gateway

go 1.21

require (
    github.com/gin-gonic/gin v1.9.1
)
`
    const result = detectFromGoMod(content, filePath, root)
    expect(result).toHaveLength(1)
    expect(result[0].technologies).toContain('gin')
    expect(result[0].responsibility).toBe('Gin HTTP API service')
  })

  it('should detect a gRPC service', () => {
    const content = `module github.com/myorg/rpc-service

go 1.21

require (
    google.golang.org/grpc/grpc-go v1.60.0
)
`
    const result = detectFromGoMod(content, filePath, root)
    expect(result).toHaveLength(1)
    expect(result[0].technologies).toContain('grpc')
    expect(result[0].responsibility).toBe('gRPC service')
  })
})

// ─── Python Detector ─────────────────────────────────────────────────────────

describe('detectFromPython', () => {
  const root = '/project'
  const filePath = '/project/services/ml-api/requirements.txt'

  it('should detect a FastAPI service', () => {
    const content = `fastapi==0.104.0
uvicorn==0.24.0
`
    const result = detectFromPython(content, filePath, root, 'requirements.txt')
    expect(result).toHaveLength(1)
    expect(result[0].technologies).toContain('fastapi')
    expect(result[0].responsibility).toBe('FastAPI REST service')
  })

  it('should detect a Celery worker', () => {
    const content = `celery==5.3.0
redis==5.0.0
`
    const result = detectFromPython(content, filePath, root, 'requirements.txt')
    expect(result).toHaveLength(1)
    expect(result[0].technologies).toContain('celery')
    expect(result[0].responsibility).toBe('Celery distributed task worker')
  })

  it('should detect a Django app', () => {
    const content = `django==4.2.0
djangorestframework==3.14.0
`
    const result = detectFromPython(content, filePath, root, 'requirements.txt')
    expect(result).toHaveLength(1)
    expect(result[0].technologies).toContain('django')
    expect(result[0].responsibility).toBe('Django web application')
  })
})

// ─── Edge Cases ─────────────────────────────────────────────────────────────

describe('detectFromPackageJson edge cases', () => {
  const root = '/project'
  const filePath = '/project/services/api/package.json'

  it('handles package.json with no dependencies', () => {
    const content = JSON.stringify({ name: 'empty-app' })
    const result = detectFromPackageJson(content, filePath, root)
    // No recognized framework deps -> no service, no databases, no queues, no externals
    expect(result).toHaveLength(0)
  })

  it('handles package.json with malformed JSON', () => {
    const content = '{ this is not valid json !!!'
    const result = detectFromPackageJson(content, filePath, root)
    expect(result).toEqual([])
  })

  it('handles service names with hyphens correctly', () => {
    const content = JSON.stringify({
      name: 'my-cool-service',
      dependencies: { express: '^4.18.0' },
    })
    const result = detectFromPackageJson(content, filePath, root)
    const service = result.find(s => s.type === 'service')
    expect(service).toBeDefined()
    expect(service!.id).toBe('my_cool_service')
    expect(service!.name).toBe('My Cool Service')
  })

  it('detects multiple databases from same package.json', () => {
    const content = JSON.stringify({
      name: 'multi-db-api',
      dependencies: {
        express: '^4.18.0',
        prisma: '^5.0.0',
        redis: '^4.0.0',
        mongoose: '^7.0.0',
      },
    })
    const result = detectFromPackageJson(content, filePath, root)
    const postgresql = result.find(s => s.id === 'postgresql')
    const redis = result.find(s => s.id === 'redis')
    const mongodb = result.find(s => s.id === 'mongodb')
    expect(postgresql).toBeDefined()
    expect(postgresql!.type).toBe('database')
    expect(redis).toBeDefined()
    expect(redis!.type).toBe('database')
    expect(mongodb).toBeDefined()
    expect(mongodb!.type).toBe('database')
  })
})

describe('detectFromPomXml edge cases', () => {
  const root = '/project'
  const filePath = '/project/services/payment/pom.xml'

  it('handles pom.xml with empty modules section', () => {
    const content = `
<project>
  <artifactId>parent-pom</artifactId>
  <modules>
  </modules>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
</project>
`
    // Parent pom with <modules> is skipped
    const result = detectFromPomXml(content, filePath, root)
    expect(result).toHaveLength(0)
  })
})

describe('detectFromGoMod edge cases', () => {
  const root = '/project'
  const filePath = '/project/services/gateway/go.mod'

  it('handles go.mod with no module line', () => {
    const content = `go 1.21

require (
    github.com/gin-gonic/gin v1.9.1
)
`
    const result = detectFromGoMod(content, filePath, root)
    expect(result).toHaveLength(1)
    // Falls back to directory name
    expect(result[0].technologies).toContain('gin')
    expect(result[0].type).toBe('service')
  })
})

describe('detectFromPython edge cases', () => {
  const root = '/project'
  const filePath = '/project/services/ml-api/requirements.txt'

  it('handles python requirements.txt with comments and blank lines', () => {
    const content = `# This is a comment
# Another comment

fastapi==0.104.0

# Database dependencies
uvicorn==0.24.0

`
    const result = detectFromPython(content, filePath, root, 'requirements.txt')
    expect(result).toHaveLength(1)
    expect(result[0].technologies).toContain('fastapi')
    expect(result[0].responsibility).toBe('FastAPI REST service')
  })
})

describe('detectFromDockerCompose edge cases', () => {
  const root = '/project'
  const filePath = '/project/docker-compose.yml'

  it('handles docker-compose with no services section', () => {
    const content = `
version: '3.8'
networks:
  default:
    driver: bridge
`
    const result = detectFromDockerCompose(content, filePath, root)
    expect(result).toHaveLength(0)
  })

  it('handles service names with hyphens correctly', () => {
    const content = `
services:
  my-cool-service:
    build: ./app
`
    const result = detectFromDockerCompose(content, filePath, root)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('my_cool_service')
    expect(result[0].name).toBe('My Cool Service')
    expect(result[0].type).toBe('service')
  })
})
