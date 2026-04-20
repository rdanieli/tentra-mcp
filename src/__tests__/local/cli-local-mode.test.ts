/**
 * Phase 1 / Step 4 — tier-2 cloud-required audit.
 *
 * Spawns the bundled MCP server with TENTRA_BACKEND=local and sends tools/call
 * JSON-RPCs for every cloud-only tool. For each, the response MUST be a
 * content[0].text that parses as JSON with an `error` field containing
 * "hosted" or "local". That shape is the one guarantee PR #57 made to agents,
 * and tier-2 tools must honor it — if one leaks a 500 / network error / raw
 * throw, the agent can't tell the user "this needs hosted mode".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = join(__dirname, '..', '..', '..', 'dist', 'index.js')

// Minimal JSON-RPC client over stdio. Keeps one process alive for the full
// suite; each call gets a unique id and awaits its matching response.
class McpStdioClient {
  private child: ChildProcessWithoutNullStreams
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>()
  private buffer = ''
  private nextId = 1

  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn('node', [SERVER_PATH], {
      env, stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams
    this.child.stdout.on('data', (chunk) => this.onData(chunk.toString()))
    this.child.stderr.on('data', () => { /* swallow startup banner */ })
  }

  private onData(chunk: string) {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl); this.buffer = this.buffer.slice(nl + 1)
      if (!line.trim().startsWith('{')) continue
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } }
        if (msg.id === undefined) continue
        const p = this.pending.get(msg.id)
        if (!p) continue
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message ?? 'rpc error'))
        else p.resolve(msg.result)
      } catch { /* not JSON / not ours */ }
    }
  }

  send(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      // Per-call timeout so a hung request doesn't stall the whole suite.
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`${method} timed out`))
        }
      }, 10_000)
    })
  }

  async initialize() {
    this.child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'local-smoke', version: '1' } }
    }) + '\n')
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    // Give the server a tick to mark itself initialized.
    await new Promise(r => setTimeout(r, 50))
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const result = await this.send('tools/call', { name, arguments: args }) as {
      content?: Array<{ type: string; text: string }>
      isError?: boolean
    }
    return result
  }

  close() {
    try { this.child.kill() } catch { /* already dead */ }
  }
}

// Parse the `content[0].text` out of an MCP tool result, then JSON-parse it.
// Every cloud-only tool must emit JSON in local mode — plain-text responses
// signal a leak (raw throw, undefined message, etc.) and this helper surfaces
// that as a useful test failure rather than a generic "expected".
function extractErrorJson(result: { content?: Array<{ type: string; text: string }> }) {
  const text = result?.content?.[0]?.text
  if (typeof text !== 'string') throw new Error('tool returned no text content')
  try {
    return JSON.parse(text) as { error?: string; scope?: string }
  } catch {
    throw new Error(`tool returned non-JSON text in local mode: ${text.slice(0, 200)}`)
  }
}

describe('CLI local-mode — cloud-required audit (architecture + enrichment)', () => {
  let client: McpStdioClient
  let tentraHome: string

  beforeAll(async () => {
    if (!existsSync(SERVER_PATH)) {
      throw new Error(`dist/index.js missing — run \`pnpm --filter tentra-mcp build\` first (${SERVER_PATH})`)
    }
    tentraHome = mkdtempSync(join(tmpdir(), 'tentra-cli-local-'))
    client = new McpStdioClient({
      ...process.env,
      TENTRA_BACKEND: 'local',
      TENTRA_HOME: tentraHome,
      // Unset any hosted creds so a bug in the local short-circuit can't
      // accidentally silently succeed against the real API.
      TENTRA_API_KEY: '',
      API_URL: 'http://127.0.0.1:1'
    })
    await client.initialize()
  }, 30_000)

  afterAll(() => {
    client?.close()
    if (tentraHome) rmSync(tentraHome, { recursive: true, force: true })
  })

  // 12 cloud-required tools: 9 architecture + 3 enrichment-write (contracts +
  // decisions + mappings — one per namespace). Enrichment-read
  // (get_contracts / get_decisions_for / get_ownership) is exercised below to
  // confirm GET paths also short-circuit.
  //
  // Phase 2 note: find_similar_code + record_embedding USED to live here and
  // no longer do — they run against local SQLite now (see embeddings.test.ts).
  const cloudRequiredCases: Array<{ name: string; args: Record<string, unknown> }> = [
    // Architecture (9)
    { name: 'create_architecture', args: { name: 'X', services: [{ id: 's', type: 'service', responsibility: 'r' }], connections: [] } },
    { name: 'update_architecture', args: { id: 'arch_x' } },
    { name: 'get_architecture', args: { id: 'arch_x' } },
    { name: 'list_architectures', args: {} },
    { name: 'analyze_codebase', args: { path: '/tmp/nonexistent-for-test' } },
    { name: 'lint_architecture', args: { id: 'arch_x' } },
    { name: 'sync_architecture', args: { architectureId: 'arch_x', codebasePath: '/tmp/nonexistent' } },
    { name: 'export_architecture', args: { id: 'arch_x', format: 'mermaid' } },
    { name: 'create_flow', args: { architectureId: 'arch_x', flow: { id: 'f', name: 'F', steps: [{ id: 's1', type: 'intro', title: 'start' }] } } },
    // Enrichment write (3)
    { name: 'record_contract', args: { workspace_id: 'ws', kind: 'http', name: 'n', version: '1' } },
    { name: 'record_decision', args: { workspace_id: 'ws', slug: 'adr', title: 't', context: 'c', decision: 'd', consequences: 'x' } },
    { name: 'set_domain_membership', args: { domain_id: 'dom', entity_type: 'file', entity_id: 'f' } }
  ]

  for (const tc of cloudRequiredCases) {
    it(`${tc.name} returns structured { error, scope } in local mode`, async () => {
      const result = await client.callTool(tc.name, tc.args)
      const parsed = extractErrorJson(result)
      expect(typeof parsed.error).toBe('string')
      expect(parsed.error!.toLowerCase()).toMatch(/hosted|local/)
    })
  }

  // Bonus: enrichment GET paths. These aren't in the "14" but belong to the
  // same class and must also short-circuit cleanly rather than 500.
  const cloudRequiredReads: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: 'get_contracts', args: { workspace_id: 'ws' } },
    { name: 'get_decisions_for', args: { entity_type: 'file', entity_id: 'f' } },
    { name: 'get_ownership', args: { workspace_id: 'ws', path: 'src/x.ts' } }
  ]

  for (const tc of cloudRequiredReads) {
    it(`${tc.name} (read) returns structured { error, scope } in local mode`, async () => {
      const result = await client.callTool(tc.name, tc.args)
      const parsed = extractErrorJson(result)
      expect(typeof parsed.error).toBe('string')
      expect(parsed.error!.toLowerCase()).toMatch(/hosted|local/)
    })
  }
})
