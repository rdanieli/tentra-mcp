import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { exec } from 'child_process'
import { getCredentials, writeCredentials, deleteCredentials } from './auth.js'
import { IndexCodeSchema, indexCodeHandler } from './tools/code-index/index-code.js'
import { IndexCodeContinueSchema, indexCodeContinueHandler } from './tools/code-index/index-code-continue.js'
import { RecordSemanticNodeSchema, recordSemanticNodeHandler } from './tools/code-index/record-semantic-node.js'
import { GetIndexJobSchema, getIndexJobHandler } from './tools/code-index/get-index-job.js'
import { QuerySymbolsSchema, querySymbolsHandler } from './tools/code-query/query-symbols.js'
import { FindReferencesSchema, findReferencesHandler } from './tools/code-query/find-references.js'
import { GetSymbolNeighborsSchema, getSymbolNeighborsHandler } from './tools/code-query/get-symbol-neighbors.js'
import { GetServiceCodeGraphSchema, getServiceCodeGraphHandler } from './tools/code-query/get-service-code-graph.js'
import { ExplainCodePathSchema, explainCodePathHandler } from './tools/code-query/explain-code-path.js'
import { FindSimilarCodeSchema, findSimilarCodeHandler } from './tools/code-query/find-similar-code.js'
import { ListGodNodesSchema, listGodNodesHandler } from './tools/code-query/list-god-nodes.js'
import { GetQualityHotspotsSchema, getQualityHotspotsHandler } from './tools/code-query/get-quality-hotspots.js'
import { ListSnapshotsSchema, listSnapshotsHandler } from './tools/code-query/list-snapshots.js'
import { DiffSnapshotsSchema, diffSnapshotsHandler } from './tools/code-query/diff-snapshots.js'
import { RecordEmbeddingSchema, recordEmbeddingHandler } from './tools/code-query/record-embedding.js'
import { SetServiceMappingSchema, setServiceMappingHandler } from './tools/mappings/set-service-mapping.js'
import { SetDomainMembershipSchema, setDomainMembershipHandler } from './tools/mappings/set-domain-membership.js'
import { RecordContractSchema, recordContractHandler } from './tools/contracts/record-contract.js'
import { BindContractSchema, bindContractHandler } from './tools/contracts/bind-contract.js'
import { GetContractsSchema, getContractsHandler } from './tools/contracts/get-contracts.js'
import { RecordDecisionSchema, recordDecisionHandler } from './tools/decisions/record-decision.js'
import { LinkDecisionSchema, linkDecisionHandler } from './tools/decisions/link-decision.js'
import { GetDecisionsForSchema, getDecisionsForHandler } from './tools/decisions/get-decisions-for.js'
import { GetOwnershipSchema, getOwnershipHandler } from './tools/ownership/get-ownership.js'

const API_URL = process.env.API_URL || 'https://trytentra.com/api'
const WEB_URL = process.env.WEB_URL || 'https://trytentra.com'

// Track first architecture creation to auto-open browser
let hasOpenedBrowser = false

function openInBrowser(url: string): void {
  if (hasOpenedBrowser) return
  hasOpenedBrowser = true
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  exec(`${cmd} "${url}"`, () => {}) // fire-and-forget
}

// ─── HTTP Helper ──────────────────────────────────────────────────────────────

interface ApiError { error?: string }
interface ArchSummary { id: string; name: string; version: number; createdAt: string }
interface ArchResponse { id: string; name: string; version: number; url?: string }

// Track if auth is currently in progress to prevent concurrent flows
let authInProgress: Promise<string> | null = null

async function ensureAuth(): Promise<string> {
  const creds = await getCredentials()
  if (creds) return creds.apiKey

  if (authInProgress) return authInProgress

  console.error('\n🔐 Authentication required.')
  console.error('Starting device flow authentication...\n')

  authInProgress = (async () => {
    try {
      const codeRes = await fetch(`${API_URL}/auth/device/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })

      if (!codeRes.ok) {
        throw new Error(`Cannot reach ${API_URL}. Check your internet connection.`)
      }

      const codeData = await codeRes.json() as {
        device_code: string
        user_code: string
        verification_url: string
        expires_in: number
        interval: number
      }

      console.error(`Open this URL to sign in:\n  ${codeData.verification_url}\n`)
      console.error(`Your code: ${codeData.user_code}\n`)
      console.error('Waiting for authorization...\n')

      const { device_code, interval } = codeData
      const maxAttempts = Math.ceil(900 / interval)
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise(resolve => setTimeout(resolve, interval * 1000))

        const tokenRes = await fetch(`${API_URL}/auth/device/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_code })
        })

        if (tokenRes.status === 428) continue
        if (tokenRes.status === 410) throw new Error('Device code expired. Please try again.')

        if (tokenRes.ok) {
          const tokenData = await tokenRes.json() as { api_key: string; username: string }

          await writeCredentials(undefined, {
            api_url: API_URL,
            api_key: tokenData.api_key,
            username: tokenData.username,
            created_at: new Date().toISOString()
          })

          console.error(`✅ Authenticated as @${tokenData.username}\n`)
          return tokenData.api_key
        }

        const errBody = await tokenRes.json().catch(() => ({ error: tokenRes.statusText })) as { error?: string }
        throw new Error(`Unexpected auth response (${tokenRes.status}): ${errBody.error || tokenRes.statusText}`)
      }

      throw new Error('Device code expired. Please try again.')
    } finally {
      authInProgress = null
    }
  })()

  return authInProgress
}

async function apiRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  let apiKey: string
  try {
    apiKey = await ensureAuth()
  } catch (err) {
    throw new Error(`Authentication required. ${(err as Error).message}`)
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey
  }
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  })

  if (res.status === 401) {
    await deleteCredentials()
    throw new Error('Session expired. Please call any tool again to re-authenticate.')
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as ApiError
    throw new Error(`API error ${res.status}: ${err.error ?? res.statusText}`)
  }
  if (res.status === 204) return null
  return res.json()
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const ComponentSchema = z.object({
  id: z.string().describe('Unique ID within the service, e.g. payment_controller'),
  name: z.string().optional().describe('Display name'),
  type: z.enum(['controller', 'service_layer', 'repository', 'client', 'handler', 'model', 'util']),
  responsibility: z.string().describe('What this component does')
})

const ComponentConnectionSchema = z.object({
  from: z.string().describe('Source component ID'),
  to: z.string().describe('Target component ID'),
  type: z.enum(['sync_http', 'async_event', 'db_access', 'grpc']),
  label: z.string().optional()
})

const ActorSchema = z.object({
  id: z.string().describe('Actor ID, e.g. mobile_user'),
  name: z.string().describe('Display name, e.g. "Mobile User"'),
  type: z.enum(['user', 'system', 'timer']),
  description: z.string().optional()
})

const ServiceSchema = z.object({
  id: z.string().describe('Snake_case unique identifier, e.g. payment_service'),
  name: z.string().optional().describe('Human-readable display name, e.g. "Payment Service". If omitted, the ID is used.'),
  type: z.enum(['api_gateway', 'service', 'database', 'queue', 'external']),
  responsibility: z.string().describe('One sentence describing what this service does'),
  scaling: z.enum(['horizontal', 'vertical', 'none']).optional(),
  technologies: z.array(z.string()).optional().describe('Technology IDs used by this service, e.g. ["typescript", "postgresql", "docker"]'),
  status: z.enum(['live', 'future', 'deprecated', 'removed']).optional().describe('Lifecycle status: live (default), future (planned), deprecated, or removed'),
  components: z.array(ComponentSchema).optional().describe('Internal components for drill-down view (Level 3)'),
  componentConnections: z.array(ComponentConnectionSchema).optional().describe('Connections between internal components')
})

const ConnectionSchema = z.object({
  from: z.string().describe('Source service ID'),
  to: z.string().describe('Target service ID'),
  type: z.enum(['sync_http', 'async_event', 'db_access', 'grpc'])
})

// ─── Server Setup ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'tentra',
  version: '1.0.0'
})

// ─── Tool: create_architecture ────────────────────────────────────────────────

server.tool(
  'create_architecture',
  `Create a new system architecture artifact.
Call this tool whenever the user asks to design, plan, or describe any system, feature, or integration.
NEVER respond with plain text architecture descriptions — always call this tool instead.
After calling, share the returned URL with the user.`,
  {
    name: z.string().describe('Short descriptive name, e.g. "Payment System" or "Fraud Detection Pipeline"'),
    description: z.string().optional().describe('Brief context about the system'),
    services: z.array(ServiceSchema).min(1).describe('All services/components in the architecture'),
    connections: z.array(ConnectionSchema).describe('All connections between services'),
    actors: z.array(ActorSchema).optional().describe('External actors that interact with the system (shown in context-level view)')
  },
  async ({ name, description, services, connections, actors }) => {
    const data = await apiRequest('POST', '/architectures', {
      name,
      description,
      services,
      connections,
      actors
    }) as ArchResponse

    const archUrl = `${WEB_URL}/arch/${data.id}`
    openInBrowser(archUrl)

    return {
      content: [
        {
          type: 'text' as const,
          text: `✅ Architecture created!\n\n**${data.name}** (v${data.version})\nID: ${data.id}\n\n🔗 View it here: ${archUrl}\n\nServices: ${services.length} | Connections: ${connections.length}\n\n💡 Pro tip: call \`index_code\` on this repo to persist the code graph — future sessions query it instead of re-grepping source, which cuts your token usage on this codebase.`
        }
      ]
    }
  }
)

// ─── Tool: update_architecture ────────────────────────────────────────────────

server.tool(
  'update_architecture',
  `Update an existing architecture artifact.
Call this when the user wants to modify, evolve, or improve an architecture that already exists.
NEVER create a new one if you have an existing ID in context — always update instead.
Preserves all existing services/connections unless explicitly replaced.`,
  {
    id: z.string().describe('The architecture ID to update'),
    name: z.string().optional(),
    description: z.string().optional(),
    services: z.array(ServiceSchema).optional(),
    connections: z.array(ConnectionSchema).optional()
  },
  async ({ id, ...patch }) => {
    const data = await apiRequest('PATCH', `/architectures/${id}`, patch) as ArchResponse
    return {
      content: [
        {
          type: 'text' as const,
          text: `✅ Architecture updated!\n\n**${data.name}** (v${data.version})\nID: ${data.id}\n\n🔗 View it here: ${WEB_URL}/arch/${data.id}`
        }
      ]
    }
  }
)

// ─── Tool: get_architecture ───────────────────────────────────────────────────

server.tool(
  'get_architecture',
  'Retrieve a specific architecture by ID. Use this to read the current state before making updates.',
  {
    id: z.string().describe('The architecture ID to retrieve')
  },
  async ({ id }) => {
    const data = await apiRequest('GET', `/architectures/${id}`)
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(data, null, 2)
        }
      ]
    }
  }
)

// ─── Tool: list_architectures ─────────────────────────────────────────────────

server.tool(
  'list_architectures',
  'List all saved architectures. Use when the user asks to see, browse or find existing architectures.',
  {},
  async () => {
    const data = await apiRequest('GET', '/architectures') as ArchSummary[]
    if (!data || data.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No architectures found. Create one with create_architecture.' }] }
    }
    const list = data.map((a: ArchSummary) =>
      `• **${a.name}** (v${a.version}) — ID: ${a.id}\n  🔗 ${WEB_URL}/arch/${a.id}\n  Created: ${new Date(a.createdAt).toLocaleDateString()}`
    ).join('\n\n')
    return { content: [{ type: 'text' as const, text: `Found ${data.length} architecture(s):\n\n${list}` }] }
  }
)

// ─── Tool: analyze_codebase ──────────────────────────────────────────────────

server.tool(
  'analyze_codebase',
  `Scan a local codebase directory and automatically generate an architecture diagram.
Detects services from package.json, docker-compose, pom.xml, go.mod, and Python configs.
Infers connections from dependencies, imports, env vars, and docker-compose depends_on.
Detects databases, queues, external services, and API gateways automatically.
After analysis, creates the architecture and returns the URL.
Also runs lint rules and reports quality issues.`,
  {
    path: z.string().describe('Absolute path to the codebase root directory to scan'),
    name: z.string().optional().describe('Architecture name. If omitted, inferred from directory name.'),
    description: z.string().optional().describe('Brief description of the system')
  },
  async ({ path, name, description }) => {
    // Dynamic import to avoid loading analyzer at startup
    const { scanCodebase } = await import('./analyzer/scanner.js')
    const { lintArchitecture } = await import('./analyzer/lint.js')

    const result = await scanCodebase(path)

    if (result.services.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: `⚠️ No services detected in ${path}.\n\nMake sure the directory contains recognizable project files (package.json, docker-compose.yml, pom.xml, go.mod, etc.)`
        }]
      }
    }

    // Run lint
    const issues = lintArchitecture(
      result.services.map(s => ({ id: s.id, name: s.name, type: s.type, responsibility: s.responsibility, scaling: s.scaling })),
      result.connections.map(c => ({ from: c.from, to: c.to, type: c.type }))
    )

    // Create the architecture via API
    const archName = name || path.split('/').filter(Boolean).pop()!.replace(/[-_]/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
    const services = result.services.map(s => ({
      id: s.id,
      name: s.name,
      type: s.type,
      responsibility: s.responsibility,
      scaling: s.scaling || 'none'
    }))
    const connections = result.connections.map(c => ({
      from: c.from,
      to: c.to,
      type: c.type
    }))

    const data = await apiRequest('POST', '/architectures', {
      name: archName,
      description: description || `Auto-generated from codebase analysis of ${path}`,
      services,
      connections
    }) as ArchResponse

    // Build report
    const svcReport = result.services
      .map(s => `  • ${s.name} (${s.type}) — ${s.responsibility}\n    techs: ${s.technologies.join(', ') || 'none'} | confidence: ${Math.round(s.confidence * 100)}%`)
      .join('\n')

    const connReport = result.connections
      .map(c => `  • ${c.from} → ${c.to} [${c.type}] — ${c.reason}`)
      .join('\n')

    const issueReport = issues.length > 0
      ? '\n\n🔍 **Lint Results:**\n' + issues.map(i => `  ${i.severity === 'error' ? '❌' : i.severity === 'warning' ? '⚠️' : 'ℹ️'} [${i.rule}] ${i.message}`).join('\n')
      : '\n\n✅ No lint issues found.'

    return {
      content: [{
        type: 'text' as const,
        text: `✅ Architecture generated from codebase!\n\n**${archName}** (v${data.version})\nID: ${data.id}\n🔗 ${WEB_URL}/arch/${data.id}\n\n📊 **Analysis:**\n- Scanned ${result.metadata.scannedFiles} config files\n- Detected ${result.metadata.detectedServices} services\n- Inferred ${result.metadata.detectedConnections} connections\n\n**Services:**\n${svcReport}\n\n**Connections:**\n${connReport}${issueReport}`
      }]
    }
  }
)

// ─── Tool: lint_architecture ─────────────────────────────────────────────────

server.tool(
  'lint_architecture',
  `Validate an existing architecture for quality issues.
Checks for: orphan nodes, duplicate connections, naming violations,
single points of failure, god services, missing databases, sync overload, and more.`,
  {
    id: z.string().describe('The architecture ID to lint')
  },
  async ({ id }) => {
    const { lintArchitecture } = await import('./analyzer/lint.js')
    const data = await apiRequest('GET', `/architectures/${id}`) as {
      name: string
      services: { id: string; name?: string; type: string; responsibility: string; scaling?: string }[]
      connections: { from: string; to: string; type: string }[]
    }

    const issues = lintArchitecture(data.services, data.connections)

    if (issues.length === 0) {
      return { content: [{ type: 'text' as const, text: `✅ **${data.name}** passed all lint checks. No issues found.` }] }
    }

    const errors = issues.filter(i => i.severity === 'error')
    const warnings = issues.filter(i => i.severity === 'warning')
    const infos = issues.filter(i => i.severity === 'info')

    const report = issues
      .map(i => `${i.severity === 'error' ? '❌' : i.severity === 'warning' ? '⚠️' : 'ℹ️'} **[${i.rule}]** ${i.message}`)
      .join('\n')

    return {
      content: [{
        type: 'text' as const,
        text: `🔍 **Lint Results for "${data.name}"**\n\n${errors.length} errors · ${warnings.length} warnings · ${infos.length} info\n\n${report}`
      }]
    }
  }
)

// ─── Tool: sync_architecture ──────────────────────────────────────────────────

server.tool(
  'sync_architecture',
  `Compare a saved architecture against the current codebase to detect drift.
Scans the codebase and diffs the detected services/connections against the saved diagram.
Reports added, removed, and changed services/connections with an accuracy score.`,
  {
    architectureId: z.string().describe('The architecture ID to compare against'),
    codebasePath: z.string().describe('Absolute path to the codebase root directory to scan')
  },
  async ({ architectureId, codebasePath }) => {
    const { scanCodebase } = await import('./analyzer/scanner.js')
    const { computeDiff } = await import('./analyzer/sync.js')

    // 1. Fetch saved architecture
    const arch = await apiRequest('GET', `/architectures/${architectureId}`) as {
      name: string
      services: { id: string; type: string; responsibility: string }[]
      connections: { from: string; to: string; type: string }[]
    }

    // 2. Scan codebase
    const result = await scanCodebase(codebasePath)

    // 3. Compute diff
    const savedServices = arch.services.map(s => ({ id: s.id, type: s.type, responsibility: s.responsibility }))
    const savedConnections = arch.connections.map(c => ({ from: c.from, to: c.to, type: c.type }))
    const detectedServices = result.services.map(s => ({ id: s.id, type: s.type, responsibility: s.responsibility }))
    const detectedConnections = result.connections.map(c => ({ from: c.from, to: c.to, type: c.type }))

    const diff = computeDiff(savedServices, savedConnections, detectedServices, detectedConnections)

    // 4. Build report
    const lines: string[] = []

    if (diff.score === 100) {
      lines.push(`✅ **"${arch.name}"** is fully in sync with the codebase! Score: 100/100`)
    } else {
      lines.push(`🔄 **Drift Report for "${arch.name}"**`)
      lines.push(`Accuracy Score: **${diff.score}/100**\n`)
    }

    if (diff.addedServices.length > 0) {
      lines.push('**Services in code but missing from diagram:**')
      diff.addedServices.forEach(id => lines.push(`  + ${id}`))
      lines.push('')
    }

    if (diff.removedServices.length > 0) {
      lines.push('**Services in diagram but not found in code:**')
      diff.removedServices.forEach(id => lines.push(`  - ${id}`))
      lines.push('')
    }

    if (diff.changedServices.length > 0) {
      lines.push('**Changed services:**')
      diff.changedServices.forEach(c =>
        lines.push(`  ~ ${c.id}: ${c.field} changed from "${c.saved}" to "${c.detected}"`)
      )
      lines.push('')
    }

    if (diff.addedConnections.length > 0) {
      lines.push('**Connections in code but missing from diagram:**')
      diff.addedConnections.forEach(c =>
        lines.push(`  + ${c.from} → ${c.to} [${c.type}]`)
      )
      lines.push('')
    }

    if (diff.removedConnections.length > 0) {
      lines.push('**Connections in diagram but not found in code:**')
      diff.removedConnections.forEach(c =>
        lines.push(`  - ${c.from} → ${c.to} [${c.type}]`)
      )
      lines.push('')
    }

    if (diff.score < 100) {
      lines.push(`Use **update_architecture** with ID \`${architectureId}\` to bring the diagram back in sync.`)
    }

    return {
      content: [{
        type: 'text' as const,
        text: lines.join('\n')
      }]
    }
  }
)

// ─── Tool: export_architecture ───────────────────────────────────────────────

server.tool(
  'export_architecture',
  `Export an architecture as runnable code, docker-compose, Mermaid diagram, or ADR docs.
Available formats: mermaid, markdown-adr, docker-compose,
java-spring-boot, nodejs-typescript, python-fastapi, go-chi,
dotnet-aspnet, rust-axum, kotlin-ktor, php-laravel, ruby-rails, elixir-phoenix.
For code exports, provide output_dir to save files directly into your project.`,
  {
    id: z.string().describe('The architecture ID to export'),
    format: z.enum([
      'mermaid', 'markdown-adr', 'docker-compose',
      'java-spring-boot', 'nodejs-typescript', 'python-fastapi', 'go-chi',
      'dotnet-aspnet', 'rust-axum', 'kotlin-ktor', 'php-laravel',
      'ruby-rails', 'elixir-phoenix'
    ]).describe('Export format'),
    output_dir: z.string().optional().describe('Directory to save exported files. Required for code formats.')
  },
  async ({ id, format, output_dir }) => {
    const textFormats = ['mermaid', 'markdown-adr', 'docker-compose']
    const isTextFormat = textFormats.includes(format)

    // Fetch from API as zip/text
    const res = await fetch(`${API_URL}/architectures/${id}/export?format=${format}`)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
      return { content: [{ type: 'text' as const, text: `❌ Export failed: ${err.error || res.statusText}` }] }
    }

    // If output_dir provided, save files
    if (output_dir) {
      const { mkdir, writeFile } = await import('fs/promises')
      const { join } = await import('path')

      const contentType = res.headers.get('content-type') || ''

      if (contentType.includes('application/zip')) {
        // Zip response — save as zip file
        const buffer = Buffer.from(await res.arrayBuffer())
        await mkdir(output_dir, { recursive: true })
        const disposition = res.headers.get('content-disposition') || ''
        const filenameMatch = disposition.match(/filename="?([^"]+)"?/)
        const filename = filenameMatch?.[1] || `export-${format}.zip`
        const filePath = join(output_dir, filename)
        await writeFile(filePath, buffer)
        return { content: [{ type: 'text' as const, text: `✅ Exported to ${filePath}\n\nUnzip and explore the generated project structure.` }] }
      } else {
        // Single file response
        const text = await res.text()
        const disposition = res.headers.get('content-disposition') || ''
        const filenameMatch = disposition.match(/filename="?([^"]+)"?/)
        const filename = filenameMatch?.[1] || `export.${format === 'mermaid' ? 'mmd' : format === 'docker-compose' ? 'yml' : 'md'}`
        await mkdir(output_dir, { recursive: true })
        const filePath = join(output_dir, filename)
        await writeFile(filePath, text)
        return { content: [{ type: 'text' as const, text: `✅ Exported to ${filePath}` }] }
      }
    }

    // No output_dir
    if (isTextFormat) {
      const text = await res.text()
      return { content: [{ type: 'text' as const, text: `📄 **${format} export:**\n\n\`\`\`\n${text}\n\`\`\`` }] }
    }

    // Code format without output_dir
    return {
      content: [{
        type: 'text' as const,
        text: `⚠️ Code exports require an output directory.\n\nUsage: export_architecture with output_dir="/path/to/save"\n\nThis will generate the full ${format} project scaffold with all services, routes, and configurations.`
      }]
    }
  }
)

// ─── Tool: create_flow ─────────────────────────────────────────────────────

const FlowStepSchema = z.object({
  id: z.string().describe('Unique step ID, e.g. step_1'),
  type: z.enum(['intro', 'message', 'process', 'info', 'conclusion']).describe('Step type: intro/conclusion for bookends, message for service-to-service, process for single-service action, info for notes'),
  title: z.string().describe('Short title for this step'),
  description: z.string().optional().describe('Longer explanation of what happens in this step'),
  from: z.string().optional().describe('Source service ID (for message steps)'),
  to: z.string().optional().describe('Target service ID (for message steps)'),
  connectionType: z.enum(['sync_http', 'async_event', 'db_access', 'grpc']).optional().describe('Connection type (for message steps)'),
  serviceId: z.string().optional().describe('Service ID that performs the action (for process steps)')
})

const FlowSchema = z.object({
  id: z.string().describe('Unique flow ID, e.g. checkout_flow'),
  name: z.string().describe('Display name, e.g. "Checkout Flow"'),
  description: z.string().optional().describe('Brief description of the flow'),
  steps: z.array(FlowStepSchema).min(1).describe('Ordered list of steps in the flow')
})

server.tool(
  'create_flow',
  `Create a step-by-step flow on an existing architecture. Flows visualize
request paths, data pipelines, or business processes as sequential steps.
Use when the user asks to describe, trace, or explain a flow through the system.`,
  {
    architectureId: z.string().describe('The architecture ID to add the flow to'),
    flow: FlowSchema
  },
  async ({ architectureId, flow }) => {
    // 1. GET the architecture
    const arch = await apiRequest('GET', `/architectures/${architectureId}`) as {
      name: string
      flows?: unknown[]
    }

    // 2. Append the new flow to existing flows array
    const existingFlows = Array.isArray(arch.flows) ? arch.flows : []
    const updatedFlows = [...existingFlows, flow]

    // 3. PATCH the architecture with updated flows
    const data = await apiRequest('PATCH', `/architectures/${architectureId}`, {
      flows: updatedFlows
    }) as ArchResponse

    // 4. Return confirmation
    return {
      content: [
        {
          type: 'text' as const,
          text: `✅ Flow created!\n\n**${flow.name}** (${flow.steps.length} steps) added to "${arch.name}"\nID: ${data.id}\n\n🔗 View it here: ${WEB_URL}/arch/${data.id}\n\nSteps:\n${flow.steps.map((s, i) => `  ${i + 1}. [${s.type}] ${s.title}`).join('\n')}`
        }
      ]
    }
  }
)

// ─── Tool: index_code ────────────────────────────────────────────────────────

server.tool(
  'index_code',
  'Index a code repository (Tier 1 local, Tier 2 via agent)',
  IndexCodeSchema.shape,
  async (args) => { await ensureAuth(); return indexCodeHandler(args) }
)

// ─── Tool: index_code_continue ───────────────────────────────────────────────

server.tool(
  'index_code_continue',
  'Continue an in-progress indexing job',
  IndexCodeContinueSchema.shape,
  async (args) => { await ensureAuth(); return indexCodeContinueHandler(args) }
)

// ─── Tool: record_semantic_node ──────────────────────────────────────────────

server.tool(
  'record_semantic_node',
  'Persist an agent-extracted semantic node for a file or symbol',
  RecordSemanticNodeSchema.shape,
  async (args) => { await ensureAuth(); return recordSemanticNodeHandler(args) }
)

// ─── Tool: get_index_job ──────────────────────────────────────────────────────

server.tool(
  'get_index_job',
  'Get the status of an indexing job',
  GetIndexJobSchema.shape,
  async (args) => { await ensureAuth(); return getIndexJobHandler(args) }
)

// ─── Tool: query_symbols ─────────────────────────────────────────────────────

server.tool(
  'query_symbols',
  'Search for symbols by name or qualified name. Default mode="trigram" for fuzzy lookups. Pass mode="substring" for broad listings like "Handler" or "Controller" (ranked by fan-in+fan-out). Replaces 10+ grep calls. Returns symbol kind, file path, fan-in/out, semantic role.',
  QuerySymbolsSchema.shape,
  async (args) => { await ensureAuth(); return querySymbolsHandler(args) }
)

// ─── Tool: find_references ───────────────────────────────────────────────────

server.tool(
  'find_references',
  'Find every location that references a symbol — the refactor-safety tool. Returns resolved call/import/reference edges (from graph) and optionally unresolved short-name matches. Use before a rename to see every caller, or before deletion to confirm nothing depends on it. Safer than grep for TypeScript/JavaScript because it follows the call graph, not just text.',
  FindReferencesSchema.shape,
  async (args) => { await ensureAuth(); return findReferencesHandler(args) }
)

// ─── Tool: get_symbol_neighbors ──────────────────────────────────────────────

server.tool(
  'get_symbol_neighbors',
  'BFS graph traversal from a symbol — who calls it, what it calls, imports, inheritance. Eliminates 20+ file reads per question.',
  GetSymbolNeighborsSchema.shape,
  async (args) => { await ensureAuth(); return getSymbolNeighborsHandler(args) }
)

// ─── Tool: get_service_code_graph ────────────────────────────────────────────

server.tool(
  'get_service_code_graph',
  'Returns the full code subgraph for a Tentra canvas service: files, symbols, and cross-service edges.',
  GetServiceCodeGraphSchema.shape,
  async (args) => { await ensureAuth(); return getServiceCodeGraphHandler(args) }
)

// ─── Tool: explain_code_path ─────────────────────────────────────────────────

server.tool(
  'explain_code_path',
  'Finds the shortest call/import path between two symbols and annotates each hop with semantic purpose. Answers "how does X reach Y?"',
  ExplainCodePathSchema.shape,
  async (args) => { await ensureAuth(); return explainCodePathHandler(args) }
)

// ─── Tool: find_similar_code ─────────────────────────────────────────────────

server.tool(
  'find_similar_code',
  'Vector similarity search using pgvector cosine distance. Pass a query_vector (embed your text with your native embedding capability first). Returns semantically similar symbols or files.',
  FindSimilarCodeSchema.shape,
  async (args) => { await ensureAuth(); return findSimilarCodeHandler(args) }
)

// ─── Tool: record_embedding ──────────────────────────────────────────────────

server.tool(
  'record_embedding',
  'Store an embedding vector for a symbol or file. Call this after generating an embedding with your native capability. Used to populate the vector search index.',
  RecordEmbeddingSchema.shape,
  async (args) => { await ensureAuth(); return recordEmbeddingHandler(args) }
)

// ─── Tool: list_god_nodes ────────────────────────────────────────────────────

server.tool(
  'list_god_nodes',
  'List symbols flagged as god nodes (very high fan-in or fan-out). Use to identify architectural coupling hotspots.',
  ListGodNodesSchema.shape,
  async (args) => { await ensureAuth(); return listGodNodesHandler(args) }
)

// ─── Tool: get_quality_hotspots ──────────────────────────────────────────────

server.tool(
  'get_quality_hotspots',
  'Rank files by a composite score of cyclomatic complexity × churn × (1 - test coverage). Top refactor candidates.',
  GetQualityHotspotsSchema.shape,
  async (args) => { await ensureAuth(); return getQualityHotspotsHandler(args) }
)

// ─── Tool: list_snapshots ────────────────────────────────────────────────────

server.tool(
  'list_snapshots',
  'List all indexed snapshots for a repo, newest first. Use for time-travel — pick two snapshot IDs and call diff_snapshots.',
  ListSnapshotsSchema.shape,
  async (args) => { await ensureAuth(); return listSnapshotsHandler(args) }
)

// ─── Tool: diff_snapshots ────────────────────────────────────────────────────

server.tool(
  'diff_snapshots',
  'Compare two snapshots: files added/removed/modified, new/disappeared symbols, god-node deltas. Architectural diff between two commits.',
  DiffSnapshotsSchema.shape,
  async (args) => { await ensureAuth(); return diffSnapshotsHandler(args) }
)

// ─── Tool: set_service_mapping ───────────────────────────────────────────────

server.tool(
  'set_service_mapping',
  'Assign one or more files in a snapshot to a Tentra canvas service ID. Use after indexing to declare which service owns each file.',
  SetServiceMappingSchema.shape,
  async (args) => { await ensureAuth(); return setServiceMappingHandler(args) }
)

// ─── Tool: set_domain_membership ─────────────────────────────────────────────

server.tool(
  'set_domain_membership',
  'Assign a file, symbol, or service to a domain. Supports AI-inferred or human-confirmed assignments with a confidence score.',
  SetDomainMembershipSchema.shape,
  async (args) => { await ensureAuth(); return setDomainMembershipHandler(args) }
)

// ─── Tool: record_contract ────────────────────────────────────────────────────

server.tool(
  'record_contract',
  'Persist a service contract (OpenAPI, proto, event schema, etc.) to the code graph. Returns a contract_id to use with bind_contract.',
  RecordContractSchema.shape,
  async (args) => { await ensureAuth(); return recordContractHandler(args) }
)

// ─── Tool: bind_contract ──────────────────────────────────────────────────────

server.tool(
  'bind_contract',
  'Link a symbol to a contract as "provides", "consumes", or "documents". Use after record_contract to attach implementation evidence.',
  BindContractSchema.shape,
  async (args) => { await ensureAuth(); return bindContractHandler(args) }
)

// ─── Tool: get_contracts ──────────────────────────────────────────────────────

server.tool(
  'get_contracts',
  'List all contracts in a workspace, optionally filtered by kind (http, grpc, event, graphql, rabbit, kafka).',
  GetContractsSchema.shape,
  async (args) => { await ensureAuth(); return getContractsHandler(args) }
)

// ─── Tool: record_decision ────────────────────────────────────────────────────

server.tool(
  'record_decision',
  'Persist an Architecture Decision Record (ADR) to the code graph. Supports supersession, lifecycle status, and immediate entity links.',
  RecordDecisionSchema.shape,
  async (args) => { await ensureAuth(); return recordDecisionHandler(args) }
)

// ─── Tool: link_decision ──────────────────────────────────────────────────────

server.tool(
  'link_decision',
  'Link an existing decision to a service, file, symbol, contract, or domain with a typed relationship (motivates, constrains, documents, implements).',
  LinkDecisionSchema.shape,
  async (args) => { await ensureAuth(); return linkDecisionHandler(args) }
)

// ─── Tool: get_decisions_for ──────────────────────────────────────────────────

server.tool(
  'get_decisions_for',
  'Retrieve all decisions that affect a specific entity (service, file, symbol, contract, or domain). Use to surface architectural rationale while reviewing code.',
  GetDecisionsForSchema.shape,
  async (args) => { await ensureAuth(); return getDecisionsForHandler(args) }
)

// ─── Tool: get_ownership ──────────────────────────────────────────────────────

server.tool(
  'get_ownership',
  'Resolve the owner(s) of a file path according to the workspace CODEOWNERS rules. Returns a list of team or user handles.',
  GetOwnershipSchema.shape,
  async (args) => { await ensureAuth(); return getOwnershipHandler(args) }
)

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('🧩 Tentra MCP server running')
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
