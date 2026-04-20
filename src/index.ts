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
import { SafeRenameSchema, safeRenameHandler } from './tools/code-query/safe-rename.js'
import { ExplainCodebaseSchema, explainCodebaseHandler } from './tools/code-query/explain-codebase.js'
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
  // Local backend short-circuit: skip credential lookup and device flow entirely.
  if (process.env.TENTRA_BACKEND === 'local') {
    return 'local-mode'
  }

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
  `Create a new, versioned architecture diagram from a set of services, connections, and (optionally) external actors, and return a shareable web URL.

Use instead of describing an architecture in chat: whenever the user asks to design, plan, sketch, or document any system/feature/integration, call this tool and share the returned URL. Use update_architecture instead if you already have an architecture ID in context (from list_architectures or an earlier create call) — this tool always creates a NEW artifact.

Prerequisites: Tentra API auth (device-flow on first call, then a cached API key). Network access required. Side effects: writes a new Architecture row (v1) to Tentra, auto-makes it publicly shareable, and opens the web URL in the user's browser on first call per session. Response shape: { id, name, version, url } plus a text summary with counts. After creation, pass the returned id to update_architecture to evolve it, lint_architecture to validate it, or create_flow to add walkthroughs.`,
  {
    name: z.string().describe('Short, human-readable Title Case name, max ~60 chars. Examples: "Payment Processing System", "Fraud Detection Pipeline", "Checkout BFF". Used as the diagram title.'),
    description: z.string().optional().describe('One-paragraph context: business problem, scope, or key constraints. Shown as subtitle on the canvas. Omit if the services list is self-explanatory.'),
    services: z.array(ServiceSchema).min(1).describe('Every service / data store / queue / external dep in the system. Must include at least one. IDs must be snake_case and unique within the architecture (e.g. "payment_service", "fraud_api"). Every target of a connection must appear here.'),
    connections: z.array(ConnectionSchema).describe('Directed edges between services, using service IDs from the services array. Use sync_http for REST/GraphQL, async_event for pub/sub, db_access for service→DB, grpc for internal gRPC. May be empty array if the system is truly standalone, but typically is not.'),
    actors: z.array(ActorSchema).optional().describe('External humans / systems / timers that trigger the system (e.g. "mobile_user", "cron_scheduler"). Rendered in the C4 Level-1 context view. Omit for purely internal / backend-only diagrams.')
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
  `Mutate an existing architecture — bump its version, snapshot the prior state as a version record, and replace whichever top-level fields you pass.

Use instead of create_architecture whenever you already have an architecture id in context from a previous call, list_architectures, or the URL. Unlike create_architecture (which always makes a brand-new artifact), this preserves identity and lineage: version auto-increments and the old state is kept in the ArchitectureVersion history. Each field is replace-not-merge — if you pass services, you REPLACE the full services array; fields you omit are left untouched.

Prerequisites: Tentra API auth + a valid architecture id owned by the caller. Side effects: writes a new ArchitectureVersion row, PATCHes the Architecture. Response: { id, name, version, url } — share the URL back to the user.`,
  {
    id: z.string().describe('Architecture ID to update, e.g. "cm2abc123" — the opaque ID returned by create_architecture or list_architectures. Required.'),
    name: z.string().optional().describe('New Title Case name. Omit to leave unchanged.'),
    description: z.string().optional().describe('New description paragraph. Omit to leave unchanged.'),
    services: z.array(ServiceSchema).optional().describe('FULL replacement services array — include everything that should remain (not a patch). Omit to leave the services list untouched.'),
    connections: z.array(ConnectionSchema).optional().describe('FULL replacement connections array — same replace-not-merge semantics as services. Omit to leave connections untouched.')
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
  `Fetch ONE architecture by ID with the full services + connections + flows graph inline.

Use instead of list_architectures when you already know the ID and need the contents (e.g. before calling update_architecture, or to re-explain an existing diagram). list_architectures returns IDs + names only for browsing; get_architecture returns the entire payload for a single diagram. If the user hasn't given you an ID, call list_architectures first.

Prerequisites: Tentra API auth. Read-only, no side effects. Response: the full Architecture row as JSON (name, version, description, services[], connections[], actors?, flows?, createdAt, updatedAt).`,
  {
    id: z.string().describe('Architecture ID to fetch, e.g. "cm2abc123". Obtain from create_architecture, list_architectures, or a /arch/<id> URL.')
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
  `List every saved architecture in this workspace as a lightweight summary (id + name + version + createdAt + URL), newest first.

Use for BROWSING / DISCOVERY — "what have I designed already?", "find an architecture named X". Unlike get_architecture, this does NOT return services or connections; once the user picks one, call get_architecture with the returned id to load the full graph before editing.

Prerequisites: Tentra API auth. Read-only. Response: Array of { id, name, version, createdAt } rendered as a human-readable bullet list with share URLs. Empty workspaces receive a hint to call create_architecture.`,
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
  `Scan a local monorepo / project directory, auto-detect its services (from package.json, docker-compose, pom.xml, go.mod, Python configs), infer their connections (from deps, imports, env vars, docker depends_on), and materialize the result as a new Tentra architecture diagram in one shot.

Use when the user says "analyze / reverse-engineer / document my codebase" or when starting from an existing repo rather than from scratch. Unlike create_architecture (manual services array) and unlike index_code (symbol-level code graph with no diagram), this produces a high-level service-level diagram from config files only — cheap and fast, but coarse. For symbol-level understanding afterwards, also run index_code.

Prerequisites: Tentra API auth + local filesystem access (not available over the SSE transport — use the stdio server). Heavy local scan, then one POST. Side effects: creates a NEW Architecture (via create_architecture under the hood) and opens the browser. Response: the created architecture id + URL + detected services list + lint report. If no services are detected, returns a warning with no artifact created.`,
  {
    path: z.string().describe('Absolute path to the codebase root to scan, e.g. "/Users/alex/code/my-monorepo". Must contain at least one recognizable manifest (package.json, docker-compose.yml, pom.xml, go.mod, pyproject.toml, etc.).'),
    name: z.string().optional().describe('Title Case name for the resulting architecture. Defaults to a Title-Cased version of the directory name (e.g. my-monorepo → "My Monorepo").'),
    description: z.string().optional().describe('One-sentence description to attach to the diagram. Defaults to "Auto-generated from codebase analysis of <path>".')
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
  `Run 8 architecture-quality rules against a saved diagram and return a severity-tagged list of issues (errors / warnings / info).

Rules covered: orphan_node, duplicate_connection, dangling_connection (references non-existent service), naming_convention (snake_case IDs), god_service (>6 connections), spof (single non-horizontal database with >1 dependent), missing_database, sync_overload (>5 sync HTTP edges on one service).

Use BEFORE updating or exporting an architecture, or when the user asks "is this design OK?" / "what's wrong with X?". Unlike sync_architecture (which compares the diagram to real code), lint_architecture only inspects the diagram itself — no codebase needed, pure static checks. Run lint_architecture first to catch modeling errors; run sync_architecture afterwards to catch drift.

Prerequisites: Tentra API auth + an existing architecture id. Read-only. Response: markdown report with counts (errors/warnings/info) and per-issue [rule] message lines, or a "passed all lint checks" message if clean.`,
  {
    id: z.string().describe('Architecture ID to lint, e.g. "cm2abc123". Obtain from create_architecture or list_architectures.')
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
  `Diff a saved Tentra architecture against the current state of a local codebase and return a drift report: services added / removed / changed, connections added / removed, plus a 0–100 accuracy score.

Use when the user asks "is my diagram still accurate?", "what's drifted?", or after significant refactors. Unlike lint_architecture (which only validates the diagram in isolation), this tool reads the codebase and compares. Unlike analyze_codebase (which creates a new diagram from scratch), this compares to an EXISTING diagram without overwriting it — use update_architecture afterwards if you want to apply the changes.

Prerequisites: Tentra API auth + a saved architecture id + local filesystem access (not available over SSE — use stdio). Heavy local scan. Read-only with respect to the diagram. Response: markdown report with accuracy score, added/removed/changed services and connections, and a hint to call update_architecture to apply fixes.`,
  {
    architectureId: z.string().describe('Saved architecture ID to compare against, e.g. "cm2abc123".'),
    codebasePath: z.string().describe('Absolute path to the current codebase root to scan, e.g. "/Users/alex/code/my-monorepo". Must contain recognizable project manifests.')
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
  `Render a saved architecture as runnable code scaffolding, Mermaid, docker-compose, or an ADR markdown document and either stream it back as text or write it to disk.

Use when the user asks to "scaffold / generate / export / materialize" a diagram. Text formats (mermaid, markdown-adr, docker-compose) are returned inline. Code formats generate a multi-file zip project scaffold (controllers, services, config, Dockerfile) and require output_dir. If you call a code format without output_dir, the tool returns a usage hint instead of creating anything.

Prerequisites: Tentra API auth + existing architecture id. For code formats, local filesystem write access (not available over SSE — use stdio). Side effects: with output_dir, writes files/zip to disk under that directory. Response: inline text export, or a "Exported to <filePath>" confirmation when saved.`,
  {
    id: z.string().describe('Architecture ID to export, e.g. "cm2abc123".'),
    format: z.enum([
      'mermaid', 'markdown-adr', 'docker-compose',
      'java-spring-boot', 'nodejs-typescript', 'python-fastapi', 'go-chi',
      'dotnet-aspnet', 'rust-axum', 'kotlin-ktor', 'php-laravel',
      'ruby-rails', 'elixir-phoenix'
    ]).describe('Export format. Text formats: "mermaid" (single .mmd), "markdown-adr" (ADR doc), "docker-compose" (single compose.yml). Code formats generate multi-file project scaffolds for the given stack — require output_dir.'),
    output_dir: z.string().optional().describe('Absolute directory path to write the export into, e.g. "/Users/alex/code/exports/payments". Created if missing. REQUIRED for code formats (java-spring-boot, nodejs-typescript, python-fastapi, etc.). Optional for text formats — omit to receive the text inline.')
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
  `Append an ordered step-by-step walkthrough (a "flow") to an existing architecture — e.g. a checkout request path, a data pipeline, or a failure-recovery procedure. The flow is rendered as an animated sequence on the canvas that highlights services and edges as the user steps through it.

Use whenever the user asks to "trace / walk through / describe the steps of" something a system does. Unlike update_architecture, create_flow only appends to the flows array and bumps the version — it never touches services or connections. You can attach many flows to the same architecture (checkout flow, refund flow, signup flow, etc.).

Prerequisites: Tentra API auth + an existing architecture with services already defined (the flow steps reference services by id). Side effects: appends the new flow to the Architecture.flows JSON column and bumps version. Response: confirmation + numbered step summary + view URL.`,
  {
    architectureId: z.string().describe('Architecture ID to attach the flow to, e.g. "cm2abc123". The flow references services by id, so those services must already exist on this architecture.'),
    flow: FlowSchema.describe('The flow definition: unique id (e.g. "checkout_flow"), display name, optional description, and an ordered array of at least one step. Step types: "intro"/"conclusion" bookend, "message" is a service-to-service call (set from, to, connectionType), "process" is work inside one service (set serviceId), "info" is a plain note.')
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
  `Walk a local repo, extract symbols + call/import/reference edges via Tree-sitter (TypeScript, JavaScript, Python, Go, Java, Rust), and upload them to Tentra as a new immutable snapshot. This is what turns a raw checkout into a queryable code graph.

WRITE PATH, LONG-RUNNING (seconds on small repos, a few minutes on 10k+ file monorepos). It iterates: walk files → parse with Tree-sitter locally → POST files → POST symbols → POST edges in batches → create a job row. For tier=tier2/both, also returns a first batch of files for the agent to enrich via record_semantic_node; call index_code_continue in a loop until done. For tier=tier1, returns immediately once static extraction finishes (no semantic enrichment).

Use once per repo, then re-run after large refactors (or pass force_reindex=true). The read-path tools (query_symbols, find_references, get_symbol_neighbors, list_god_nodes, get_quality_hotspots, explain_code_path, get_service_code_graph, diff_snapshots) all require at least one successful index_code first and need the returned snapshot_id. Unlike analyze_codebase (which produces a high-level services diagram from manifests), index_code produces a symbol-level graph — run both for complete coverage.

Prerequisites: Tentra API auth + local filesystem read access to repo_path (not available over SSE — use stdio). Ignores node_modules, .git, dist, build, vendor, coverage, .worktrees, etc. Response: { job_id, snapshot_id, file_count, tier } for tier1, plus { first_batch, remaining } for tier2.`,
  IndexCodeSchema.shape,
  async (args) => { await ensureAuth(); return indexCodeHandler(args) }
)

// ─── Tool: index_code_continue ───────────────────────────────────────────────

server.tool(
  'index_code_continue',
  `Drive the tier-2 indexing loop forward: check a job's progress and either mark it done (when every file has been processed) or return the remaining file count so the agent knows it should send another batch of record_semantic_node calls.

Use ONLY after index_code with tier="tier2" or tier="both" returned a job_id. Typical loop: call index_code → for each file in first_batch, call record_semantic_node with the agent's inferred purpose → call index_code_continue → if done=true, stop; if pending>0, enrich more files and repeat. Unlike get_index_job (pure read), this tool will mark the job "completed" when processedFiles has caught up — it advances state. Unlike index_code (heavy local walk), this is a light status check.

Prerequisites: Tentra API auth + a job_id from index_code. Side effect: may transition the job from in_progress → completed. Response: { done: true, summary: { processed, total } } when finished, or { pending, cursor, instruction } when more work is needed.`,
  IndexCodeContinueSchema.shape,
  async (args) => { await ensureAuth(); return indexCodeContinueHandler(args) }
)

// ─── Tool: record_semantic_node ──────────────────────────────────────────────

server.tool(
  'record_semantic_node',
  `Persist ONE agent-inferred semantic annotation (a one-sentence purpose + domain tags + confidence + optional semantic role) for a single file OR single symbol in an indexing job, and advance that job's progress cursor by 1.

This is the write side of tier-2 indexing: after index_code (tier2/both) returns a batch of files with their symbol skeletons, the agent reads each file's source, decides what it does, and calls record_semantic_node per file — Tentra stores the annotation in CodeSemantic and marks the file as tier2-indexed. The job cursor auto-advances so index_code_continue eventually returns done=true. Unlike record_embedding (which stores vectors for find_similar_code), record_semantic_node stores human-readable purpose text plus domain tags and surfaces in query_symbols, explain_code_path, get_service_code_graph (include_semantics=true), and get_decisions_for.

Prerequisites: Tentra API auth + an active job_id from index_code + a file_id OR symbol_id from that job's snapshot (exactly one of the two is required). Call per file/symbol, not in a single mega-batch. Response: { ok: true, semantic_id }.`,
  RecordSemanticNodeSchema.shape,
  async (args) => { await ensureAuth(); return recordSemanticNodeHandler(args) }
)

// ─── Tool: get_index_job ──────────────────────────────────────────────────────

server.tool(
  'get_index_job',
  `Read-only status lookup for an indexing job: tier, status, snapshotId, totalFiles, processedFiles, lastBatchCursor, createdAt, completedAt.

Use when you need to INSPECT a job without advancing it — e.g. to report progress to the user or to decide whether a previously-started job is still in flight. Unlike index_code_continue, this tool never mutates the job (no auto-completion, no cursor advance) and never returns batches — it just reflects current state. Unlike list_snapshots (which lists every snapshot in a repo), this returns the one job row.

Prerequisites: Tentra API auth + a job_id from a prior index_code call. Read-only. Response: the full Job JSON, including status enum ("pending" | "in_progress" | "completed" | "failed").`,
  GetIndexJobSchema.shape,
  async (args) => { await ensureAuth(); return getIndexJobHandler(args) }
)

// ─── Tool: query_symbols ─────────────────────────────────────────────────────

server.tool(
  'query_symbols',
  `Search the indexed code graph for symbols (functions, classes, methods, interfaces, types, variables) by name or qualified name. Replaces 10+ grep calls per discovery task.

Two match modes: "trigram" (default, pg_trgm similarity — best for fuzzy / typo-tolerant / unique-symbol lookups), "substring" (ILIKE %q% — best for broad listings like every "Handler" or "Controller" in the repo; results ranked by fanIn + fanOut so central ones float to the top).

Use this as the STARTING POINT for any code-graph question, because it returns symbol IDs that every other read-path tool needs. Unlike find_references (which takes a known symbol_id and returns its callers), query_symbols searches by NAME and returns candidates. Unlike get_symbol_neighbors (which takes a symbol_id and walks the call graph), query_symbols does no traversal — it only matches names. Unlike find_similar_code (vector cosine over embeddings), query_symbols is literal/fuzzy text matching.

Prerequisites: Tentra API auth + a snapshot_id from a completed index_code run. Read-only. Response: { symbols: [{ id, kind, name, qualifiedName, startLine, endLine, fanIn, fanOut, isGodNode, semanticRole, filePath }] }.`,
  QuerySymbolsSchema.shape,
  async (args) => { await ensureAuth(); return querySymbolsHandler(args) }
)

// ─── Tool: find_references ───────────────────────────────────────────────────

server.tool(
  'find_references',
  `Return every resolved caller / importer / inheritor of a single symbol from the code graph — the refactor-safety tool. Use before renaming or deleting a symbol to see exactly who depends on it.

Unlike query_symbols (which takes a NAME and returns candidate symbols), find_references takes a KNOWN symbol_id and walks edges backward (toSymbolId = symbol_id) to find inbound references. Unlike get_symbol_neighbors (which does BFS to depth N in both directions), find_references only returns direct callers (depth 1, inbound) and is cheaper. Safer than grep because it uses the resolved call graph, not plain text — it will not confuse "log" the method with "log" the string. Set include_unresolved=true to also get short-name text matches that couldn't be resolved to a specific symbol (noisier; useful for broad audits but not for rename plans).

Prerequisites: Tentra API auth + a symbol_id from query_symbols + the matching snapshot_id. Read-only. Response: { target, resolvedCount, unresolvedCount, fileScopeCount, references: [{ kind: 'resolved'|'unresolved', edgeType, fromQualifiedName, fromKind, filePath, startLine, endLine, callCount }] }.`,
  FindReferencesSchema.shape,
  async (args) => { await ensureAuth(); return findReferencesHandler(args) }
)

// ─── Tool: safe_rename ───────────────────────────────────────────────────────

server.tool(
  'safe_rename',
  `Return a structured PATCH PLAN for renaming a symbol — definition site + every call site with exact file paths and line ranges — so the calling agent can apply the rewrite with its own Edit/MultiEdit tools. The canonical "rename without breaking hidden callers" tool.

Unlike find_references (which only returns callers), safe_rename also returns the symbol's own declaration site (which the agent must also rewrite) and packages everything with a summary + warnings into a plan ready for programmatic application. Unlike a plain grep-and-replace, the call sites come from the resolved code graph — you won't accidentally rename "log" the method and "log" the string in one pass. The agent grep-replaces oldName → newName within each reference's startLine..endLine range (scoped to that caller's body), NOT a whole-file rename, so unrelated symbols sharing the same short name stay untouched.

IMPORTANT — side effects: NONE. Tentra never writes files. This tool returns a plan only; the agent is responsible for applying the edits, which keeps the rewrite safe-by-default (dry-run, diff, rollback all stay in the agent's hands). If target.fanIn is above the god-node threshold, a warning fires so the agent double-checks before blasting out changes. If include_unresolved=true, best-effort short-name matches are included with a warning that they may not all be the target.

Prerequisites: Tentra API auth + a symbol_id from query_symbols + the matching snapshot_id + a valid new identifier (letters / digits / underscores, cannot start with a digit — whitespace and special characters are rejected). Read-only. Response: { target: { id, qualifiedName, oldName, newName, fanIn, fanOut, isGodNode }, definition: { filePath, startLine, endLine } | null, references: [{ kind, edgeType, fromSymbolId, fromQualifiedName, fromKind, filePath, startLine, endLine, callCount, isTest }], summary: { totalReferences, distinctCallers, fileCount, warnings: string[] } }.`,
  SafeRenameSchema.shape,
  async (args) => { await ensureAuth(); return safeRenameHandler(args) }
)

// ─── Tool: explain_codebase ──────────────────────────────────────────────────

server.tool(
  'explain_codebase',
  `Produce an agent-ready narrative walkthrough of a whole repo — "what is this codebase?" answered in a single tool call from the indexed code graph. The onboarding tour: Start here / Structure / Architectural hotspots / Domains / Decisions / Contracts / Snapshot info, all assembled from data we already have so a senior-level summary takes seconds, not minutes of file-reading.

Unlike list_god_nodes (one ranked list of symbols) or sync_architecture (drift check against a saved diagram), explain_codebase is the BIRD'S-EYE narrative: opinionated picks for the most important symbol, the most recent ADR, the primary domain; language + LOC + top-level directory breakdown; ranked hotspots; top domains / ADRs / contracts. Empty sections render hints that point at the enrichment tool you should run next (record_decision, set_domain_membership, record_contract, bind_contract) — so the output doubles as a gap audit. Size-bounded: domain / ADR / contract sections are capped so the markdown stays under ~5KB even on huge repos.

Side effects: NONE — read-only. Prerequisites: Tentra API auth + at least one completed index_code for the repo_id (snapshot_id optional — defaults to the latest). For richer output, seed ADRs via record_decision, domains via set_domain_membership, and contracts via record_contract + bind_contract. Response: format="markdown" (default) returns the full walkthrough as markdown text; format="json" returns the structured aggregation with keys { repoId, repoName, snapshot, startHere, structure, hotspots, domains, domainsTotal, decisions, decisionsTotal, contracts, contractsTotal }.`,
  ExplainCodebaseSchema.shape,
  async (args) => { await ensureAuth(); return explainCodebaseHandler(args) }
)

// ─── Tool: get_symbol_neighbors ──────────────────────────────────────────────

server.tool(
  'get_symbol_neighbors',
  `Breadth-first traverse the code graph starting from one symbol to return its local neighborhood: what it calls, what calls it, what it imports, inheritance / implementation relationships. Eliminates 20+ file-reads per "how does this work?" question.

Unlike find_references (which only returns direct callers = depth-1 inbound), get_symbol_neighbors walks OUTBOUND by default and can go deeper (up to depth=5) and bidirectional (direction="both"). Unlike explain_code_path (which finds the shortest single path between two given symbols), this tool explores the neighborhood around ONE symbol without a target. Filter by edge_types to focus on just imports, just calls, just inheritance, etc.

Prerequisites: Tentra API auth + a symbol_id (from query_symbols) + snapshot_id. Read-only. Response: { symbolId, depth, neighbors: [{ id, kind, name, qualifiedName, filePath, fanIn, fanOut, isGodNode }], edges: [{ from, to, type }] }.`,
  GetSymbolNeighborsSchema.shape,
  async (args) => { await ensureAuth(); return getSymbolNeighborsHandler(args) }
)

// ─── Tool: get_service_code_graph ────────────────────────────────────────────

server.tool(
  'get_service_code_graph',
  `Return the full code subgraph that belongs to ONE Tentra canvas service: every file mapped to that service, all the symbols in those files, and the edges leaving those symbols (including cross-service edges).

Use when the user has an architecture diagram and asks "what code is in the payment_service?", or when you want to reason about one service in isolation. Unlike get_symbol_neighbors (which starts from a single symbol), this starts from a service_id and pulls the whole service at once. Unlike query_symbols (which ignores service boundaries), this is already scoped. Requires a prior set_service_mapping call so files are actually assigned to the service_id — otherwise the result is empty.

Prerequisites: Tentra API auth + a snapshot_id from a completed index_code + at least some files mapped to service_id via set_service_mapping. Read-only. Response: { serviceId, snapshotId, depth, files: [{ id, relativePath, language, loc, symbols: [...] }], edges: [{ fromSymbolId, toSymbolId, toExternal, edgeType }] }. Pass include_semantics=true to also attach record_semantic_node purpose + domainTags per symbol.`,
  GetServiceCodeGraphSchema.shape,
  async (args) => { await ensureAuth(); return getServiceCodeGraphHandler(args) }
)

// ─── Tool: explain_code_path ─────────────────────────────────────────────────

server.tool(
  'explain_code_path',
  `Compute the SHORTEST call/import/reference chain between two given symbols in a snapshot, and annotate each intermediate hop with its record_semantic_node purpose (when available). Answers "how does X reach Y?" / "is A actually connected to B?".

Unlike get_symbol_neighbors (which explores around ONE symbol with no target), this tool needs BOTH endpoints and performs a targeted shortest-path search. Unlike find_references (direct callers only), explain_code_path can cross arbitrarily many hops. If no path exists between the two symbols in the graph, the response is { error: "no_path" }.

Prerequisites: Tentra API auth + two symbol_ids from query_symbols + the snapshot_id they both live in. Read-only. Response when a path exists: { found: true, hopCount, path: [{ id, name, qualifiedName, filePath, purpose }], edges: [{ from, to, type }] }.`,
  ExplainCodePathSchema.shape,
  async (args) => { await ensureAuth(); return explainCodePathHandler(args) }
)

// ─── Tool: find_similar_code ─────────────────────────────────────────────────

server.tool(
  'find_similar_code',
  `Run a pgvector cosine-similarity search over agent-generated embeddings stored via record_embedding. Pass a pre-computed query_vector (you must embed your text first with your own embedding capability — this tool does NOT embed for you) and optionally restrict by entity_type or snapshot_id. Returns the most semantically similar files or symbols.

Unlike query_symbols (exact/fuzzy NAME match on qualifiedName), find_similar_code matches MEANING — "rate limiting logic" will return files implementing throttles even if the word "rate-limit" never appears. Only useful after you've seeded embeddings for the target corpus via record_embedding; if no embeddings exist, results will be empty.

Prerequisites: Tentra API auth + at least one record_embedding call against the snapshot you're querying + a caller-generated query_vector of matching dimension. Read-only. Response: { results: [{ entityType, entityId, snapshotId, model, similarity, sourceText }] } sorted by cosine similarity desc.`,
  FindSimilarCodeSchema.shape,
  async (args) => { await ensureAuth(); return findSimilarCodeHandler(args) }
)

// ─── Tool: record_embedding ──────────────────────────────────────────────────

server.tool(
  'record_embedding',
  `Persist ONE pre-computed embedding vector for a file or symbol so it becomes searchable via find_similar_code. You must produce the vector yourself (the agent embeds the source_text with whatever model it has access to) — Tentra stores vector + source_text + model identifier but does not call any embedding API on your behalf.

Use in a loop after index_code to seed the vector index: for each file or symbol you care about, embed a representative snippet (function signature + doc comment, or file summary) and record it. Unlike record_semantic_node (human-readable purpose stored in CodeSemantic), record_embedding stores a dense vector in pgvector for cosine search. The two are complementary, not alternatives.

Prerequisites: Tentra API auth + a file_id or symbol_id from a completed index_code + a vector you already computed. Write path. Side effect: inserts into the embeddings table. Response: { id, ok: true }.`,
  RecordEmbeddingSchema.shape,
  async (args) => { await ensureAuth(); return recordEmbeddingHandler(args) }
)

// ─── Tool: list_god_nodes ────────────────────────────────────────────────────

server.tool(
  'list_god_nodes',
  `Return the top-N most coupled symbols in a snapshot — those with the highest fanIn + fanOut — as a ranked list. Surfaces architectural smells: utility modules that "know too much", classes every other class depends on, etc.

Unlike get_quality_hotspots (which ranks FILES by churn × complexity × (1 − coverage) — a code-quality lens), list_god_nodes ranks SYMBOLS by raw graph degree — a coupling lens. Use list_god_nodes to find what to DECOMPOSE; use get_quality_hotspots to find what to REFACTOR. Provide either snapshot_id (specific) or repo_id (automatically uses latest snapshot). Test/fixture symbols are excluded by default because helpers like "request", "makeApp" would otherwise dominate the ranking.

Prerequisites: Tentra API auth + at least one completed index_code run. Read-only. Response: { snapshotId, excludeTests, godNodes: [{ id, name, qualifiedName, filePath, isTest, fanIn, fanOut }] }.`,
  ListGodNodesSchema.shape,
  async (args) => { await ensureAuth(); return listGodNodesHandler(args) }
)

// ─── Tool: get_quality_hotspots ──────────────────────────────────────────────

server.tool(
  'get_quality_hotspots',
  `Rank FILES by a composite refactor-priority score: cyclomaticComplexity × (1 + churn30d/100) × (1 − testCoverage/100). High score = complex, frequently changed, poorly tested — the files most likely to break. The canonical "what should I refactor next?" list.

Unlike list_god_nodes (which ranks SYMBOLS by graph-coupling degree), this ranks FILES by change-risk math. They answer different questions: list_god_nodes = "what is too connected?", get_quality_hotspots = "what's likely to break on the next change?". Run both for a complete architectural review. Response includes a dataSource field — "metrics" means real QualityMetric rows were available; "proxy" means Tentra fell back to LOC + symbols + fanIn heuristic because no QualityMetric data was seeded for this snapshot.

Prerequisites: Tentra API auth + at least one completed index_code run. For real churn/coverage scores, QualityMetric rows must have been seeded (via separate ingestion — e.g. CI integration). Read-only. Response: { snapshotId, hotspots: [{ fileId, filePath, language, cyclomaticComplexity, cognitiveComplexity, churn30d, testCoverage, score }] }.`,
  GetQualityHotspotsSchema.shape,
  async (args) => { await ensureAuth(); return getQualityHotspotsHandler(args) }
)

// ─── Tool: list_snapshots ────────────────────────────────────────────────────

server.tool(
  'list_snapshots',
  `List every code-graph snapshot stored for a given repo, newest first — each row has id, commitSha (when index_code ran inside a git working tree), createdAt, parentSnapshotId, and a stats blob.

Use to TIME-TRAVEL through the repo's history: pick a snapshot_id from this list and feed it to any read-path tool (query_symbols, list_god_nodes, get_quality_hotspots, etc.) to inspect the graph as it looked at that point. To compare two points in time, pick two ids and call diff_snapshots. Unlike get_index_job (one job → one snapshot), this lists every snapshot regardless of how it was produced.

Prerequisites: Tentra API auth + at least one completed index_code run for the repo_id. Read-only. Response: { repoId, snapshots: [{ id, commitSha, createdAt, stats, parentSnapshotId }] }.`,
  ListSnapshotsSchema.shape,
  async (args) => { await ensureAuth(); return listSnapshotsHandler(args) }
)

// ─── Tool: diff_snapshots ────────────────────────────────────────────────────

server.tool(
  'diff_snapshots',
  `Compute a structural diff between two snapshots of the same repo: files added / removed / modified (by contentHash), symbols (qualifiedNames) added / removed, and god-node changes (appeared / resolved). Effectively a commit-range architectural diff that answers "what actually changed between these two points?".

Use to review a refactor PR at the graph level, to prove a deletion removed every caller, or to spot architectural regressions. Get the two snapshot ids from list_snapshots. Unlike sync_architecture (which diffs a DIAGRAM against live code), diff_snapshots diffs two code-graph snapshots against each other. Unlike get_quality_hotspots / list_god_nodes (which inspect one snapshot), this is the only tool that spans two.

Prerequisites: Tentra API auth + two snapshot ids from list_snapshots (ideally of the same repo). Read-only. Response: { fromSnapshotId, toSnapshotId, files: { added, removed, modified }, symbols: { added, removed }, godNodes: { appeared, resolved } }.`,
  DiffSnapshotsSchema.shape,
  async (args) => { await ensureAuth(); return diffSnapshotsHandler(args) }
)

// ─── Tool: set_service_mapping ───────────────────────────────────────────────

server.tool(
  'set_service_mapping',
  `Declare which Tentra canvas service owns which files in a specific snapshot — in one batched call. Each mapping is (relative file path → service id); every matching CodeFile row has its serviceId column updated.

This is the bridge between the code graph (files, symbols, edges) and the architecture diagram (services, connections). get_service_code_graph and service-scoped views will return empty arrays until at least one set_service_mapping call has populated the mappings for a snapshot. Unlike set_domain_membership (which tags entities with abstract business domains), set_service_mapping tags files with a CONCRETE service on the canvas.

Prerequisites: Tentra API auth + a snapshot_id from a completed index_code + service_ids that already exist on a Tentra architecture. Write path. Side effect: updates CodeFile.serviceId for each matching path. Paths that do not match any file in the snapshot are silently skipped. Response: { ok: true, updatedFiles: number }.`,
  SetServiceMappingSchema.shape,
  async (args) => { await ensureAuth(); return setServiceMappingHandler(args) }
)

// ─── Tool: set_domain_membership ─────────────────────────────────────────────

server.tool(
  'set_domain_membership',
  `Tag one file, symbol, or service as belonging to a business domain (e.g. "payments", "identity", "fraud"). Supports both AI-inferred (source="ai", lower confidence) and human-confirmed (source="human", confidence 1.0) assignments. Upserts: if the same (domain_id, entity_type, entity_id) tuple already has a membership, it is updated in place rather than duplicated.

Use AI-inferred memberships to bootstrap domain maps after indexing, then let a human confirm and flip source to "human". Unlike set_service_mapping (which ties a FILE to a concrete canvas SERVICE, 1:1), domain memberships are many-to-many and scoped to abstract BUSINESS domains — one file can belong to multiple domains at different confidence levels.

Prerequisites: Tentra API auth + a pre-existing domain_id (Domain rows are created separately via the web app or API) + a valid entity_id of the matching entity_type. Write path. Response: { ok: true, membership_id }.`,
  SetDomainMembershipSchema.shape,
  async (args) => { await ensureAuth(); return setDomainMembershipHandler(args) }
)

// ─── Tool: record_contract ────────────────────────────────────────────────────

server.tool(
  'record_contract',
  `Persist a service contract — an OpenAPI spec, proto file, GraphQL schema, event schema, Kafka/RabbitMQ topic schema, etc. — as a first-class entity in the code graph, so you can then attach code symbols to it via bind_contract and query it via get_contracts.

Use once per contract per version. The contract itself is just metadata + an optional schema JSON payload (record_contract does NOT parse the schema — that's an upstream job). Unlike record_decision (which stores architectural rationale), this stores a TECHNICAL INTERFACE specification. After recording, call bind_contract to link the symbols that provide/consume/document it.

Prerequisites: Tentra API auth + an existing workspace_id. Write path. Side effect: inserts a Contract row scoped to the workspace. Response: { ok: true, contract_id, name, kind }.`,
  RecordContractSchema.shape,
  async (args) => { await ensureAuth(); return recordContractHandler(args) }
)

// ─── Tool: bind_contract ──────────────────────────────────────────────────────

server.tool(
  'bind_contract',
  `Link a code symbol to a contract with a typed relation: "provides" (symbol implements the contract, e.g. a handler that serves the OpenAPI endpoint), "consumes" (symbol calls the contract, e.g. a client that hits the endpoint), or "documents" (symbol describes the contract, e.g. a type definition generated from the schema).

Use after record_contract — the contract_id it returned plus a symbol_id from query_symbols is what you need. Bindings are scoped to a snapshot_id, so the same symbol can be bound in many snapshots as the codebase evolves. Unique per (contract, symbol, snapshot): existing bindings with a new relation are updated in place rather than duplicated. Unlike link_decision (which links an ADR to architectural entities), bind_contract links a CONCRETE code symbol to a TECHNICAL INTERFACE.

Prerequisites: Tentra API auth + existing contract_id (from record_contract) + valid symbol_id + snapshot_id the symbol belongs to. Write path. Response: { ok: true, binding_id, relation }.`,
  BindContractSchema.shape,
  async (args) => { await ensureAuth(); return bindContractHandler(args) }
)

// ─── Tool: get_contracts ──────────────────────────────────────────────────────

server.tool(
  'get_contracts',
  `List every Contract stored in a workspace, newest first, with each row including a count of its bindings. Optionally filter by kind (http / grpc / event / graphql / rabbit / kafka).

Use for BROWSING the workspace's contract inventory — "what API contracts do we have?", "show every Kafka topic schema". Per-contract detail (which symbols are bound to it, the full schema payload) is not returned here; fetch contract + bindings by id via the API if needed. Unlike record_contract (write), this is strictly read-only.

Prerequisites: Tentra API auth + existing workspace_id. Read-only. Response: { contracts: [{ id, name, kind, version, specUrl, createdAt, _count: { bindings } }], total }.`,
  GetContractsSchema.shape,
  async (args) => { await ensureAuth(); return getContractsHandler(args) }
)

// ─── Tool: record_decision ────────────────────────────────────────────────────

server.tool(
  'record_decision',
  `Persist an Architecture Decision Record (ADR) — slug + title + status + context + decision + consequences — as a first-class row in the code graph, with support for supersession (auto-marking an older decision "superseded") and immediate entity links (services, files, symbols, contracts, domains).

Use when the user documents a real architectural call: "we chose Postgres over Mongo", "we split the monolith into N services", "we deprecated the legacy auth flow". Unlike link_decision (which attaches an existing decision to an entity after the fact), record_decision CREATES the decision and optionally attaches the initial set of entities in one call. Decisions surface later via get_decisions_for to explain "why is this like this?" while reviewing code.

Prerequisites: Tentra API auth + existing workspace_id + unique slug within that workspace. Write path. Side effects: creates a Decision row, creates any DecisionLink rows from the links array, and updates the superseded_by_id target's status to "superseded" if provided. Response: { ok: true, decision_id, slug, status, links_created }.`,
  RecordDecisionSchema.shape,
  async (args) => { await ensureAuth(); return recordDecisionHandler(args) }
)

// ─── Tool: link_decision ──────────────────────────────────────────────────────

server.tool(
  'link_decision',
  `Attach an EXISTING decision (from record_decision) to one more entity — a service, file, symbol, contract, or domain — with a typed relationship: "motivates" (decision caused this entity to exist), "constrains" (decision limits how it can evolve), "documents" (decision explains it), "implements" (entity is the concrete realization of the decision).

Use for post-hoc linking: e.g. a month after recording an ADR you realize it also motivates a new service. Unlike record_decision (which can include initial links via the links[] array in one call), link_decision adds ONE link at a time to an already-persisted decision. Unlike get_decisions_for (read), this is a write.

Prerequisites: Tentra API auth + existing decision_id + valid entity_id of the chosen entity_type. Write path. Response: { ok: true, link_id }.`,
  LinkDecisionSchema.shape,
  async (args) => { await ensureAuth(); return linkDecisionHandler(args) }
)

// ─── Tool: get_decisions_for ──────────────────────────────────────────────────

server.tool(
  'get_decisions_for',
  `Look up every ADR that is linked to a specific entity — useful for answering "why is this service / file / symbol the way it is?" while reviewing code. Returns every linked decision with its full context + decision + consequences + link kind.

Use proactively in code review: before changing a service, fetch its decisions to avoid violating constraints ("constrains" links) or re-litigating settled trade-offs. Include superseded decisions by default to preserve history; pass include_superseded=false to see only the currently-authoritative ADRs. Unlike link_decision (write), this is read-only. Unlike get_contracts (workspace-scope), this is entity-scope.

Prerequisites: Tentra API auth + a valid entity_id matching the chosen entity_type. Read-only. Response: { decisions: [{ id, slug, title, status, context, decision, consequences, createdAt, decidedAt, linkKind }], total }.`,
  GetDecisionsForSchema.shape,
  async (args) => { await ensureAuth(); return getDecisionsForHandler(args) }
)

// ─── Tool: get_ownership ──────────────────────────────────────────────────────

server.tool(
  'get_ownership',
  `Resolve the owning team(s) for a given file path according to the workspace's CODEOWNERS-style rules (longest-match-wins with explicit priority). Returns a list of team or user handles.

Use to answer "who owns this file?" / "who should review this change?" / "who should I ping about this bug?". OwnershipRule rows are stored per workspace — seed them by importing a CODEOWNERS file via the web app or API before calling this. Unlike get_decisions_for (which surfaces architectural rationale), this surfaces PEOPLE / TEAMS. If no rule matches, owners is [].

Prerequisites: Tentra API auth + existing workspace_id + seeded OwnershipRule rows for that workspace. Read-only. Response: { path, owners: string[] }.`,
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
