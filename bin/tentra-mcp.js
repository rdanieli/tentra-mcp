#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { join, dirname } from 'path'
import { execSync, spawn } from 'child_process'
import { homedir } from 'os'
import { fileURLToPath } from 'url'

const args = process.argv.slice(2)
const subcommand = args[0]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getFlag(name) {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null
}

function hasFlag(name) {
  return args.includes(`--${name}`)
}

function findRepoRoot(start) {
  let dir = start
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return start
}

function readJsonIfExists(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function writeJsonSafe(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

function log(msg) { console.log(msg) }
function ok(msg) { console.log(`\x1b[32m✓\x1b[0m ${msg}`) }
function info(msg) { console.log(`\x1b[36mℹ\x1b[0m ${msg}`) }
function warn(msg) { console.log(`\x1b[33m⚠\x1b[0m ${msg}`) }
function err(msg) { console.error(`\x1b[31m✗\x1b[0m ${msg}`) }

// Derive a stable, URL-safe repo_id from the git remote URL. Falls back to
// the repo's directory name when no remote is configured. Examples:
//   git@github.com:rdanieli/archbuilder.git → repo_github_rdanieli_archbuilder
//   https://gitlab.com/acme/payments → repo_gitlab_acme_payments
function deriveRepoId(root) {
  try {
    const remote = execSync('git config --get remote.origin.url', {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    // Strip protocol + user, normalize separators to /, drop .git suffix
    const cleaned = remote
      .replace(/^(https?:\/\/|git@|ssh:\/\/git@)/, '')
      .replace(/^[^/:]*[:/]/, (m) => m.split(/[:/]/)[0].replace(/\./g, '_') + '_')
      .replace(/\.git$/, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase()
    if (cleaned) return `repo_${cleaned}`
  } catch { /* fall through */ }
  return `repo_${(root.split('/').pop() || 'unknown').replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`
}

// ─── Subcommand: init — zero-config install into this repo's IDEs ────────────

if (subcommand === 'init') {
  const root = findRepoRoot(process.cwd())
  const url = getFlag('url') || process.env.API_URL || 'https://trytentra.com/api'
  const webUrl = url.replace(/\/api\/?$/, '')
  const installHook = hasFlag('hook')

  log('')
  log('\x1b[1mTentra MCP — zero-config install\x1b[0m')
  log(`  repo: ${root}`)
  log('')

  // Config for the SSE hosted MCP server (zero install, works everywhere).
  const sseConfig = {
    type: 'sse',
    url: `${url}/mcp?key=YOUR_TENTRA_API_KEY`
  }

  const targets = [
    { name: 'Cursor (repo)', path: join(root, '.cursor', 'mcp.json') },
    { name: 'Claude Code (repo)', path: join(root, '.mcp.json') },
    { name: 'Codex CLI (repo)', path: join(root, '.codex', 'mcp.json') },
    { name: 'Windsurf (user)', path: join(homedir(), '.codeium', 'windsurf', 'mcp_config.json') }
  ]

  let written = 0
  let skipped = 0
  for (const t of targets) {
    const existing = readJsonIfExists(t.path)
    if (existing?.mcpServers?.tentra) {
      info(`${t.name}: already configured → ${t.path}`)
      skipped += 1
      continue
    }
    try {
      writeJsonSafe(t.path, { ...existing, mcpServers: { ...(existing?.mcpServers ?? {}), tentra: sseConfig } })
      ok(`${t.name}: ${t.path}`)
      written += 1
    } catch (e) {
      warn(`${t.name}: skipped (${e.message})`)
    }
  }

  // ── GitHub Actions PR review workflow (opt-in via --ci) ────────────────────
  const installCi = hasFlag('ci')
  if (installCi) {
    log('')
    log('\x1b[1mInstalling GitHub Actions PR review workflow\x1b[0m')
    const workflowPath = join(root, '.github', 'workflows', 'tentra-review.yml')
    if (existsSync(workflowPath)) {
      info(`workflow already exists: ${workflowPath}`)
    } else {
      const workflow = `name: Tentra PR Review

# Automated architectural review on every PR. Posts a markdown comment
# summarizing what changed, new god-nodes, hotspots, and architectural drift.
# Requires: TENTRA_API_KEY secret (get yours at ${webUrl}/settings).

on:
  pull_request:
    branches: [main, master]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # need history for base/HEAD diffs

      - uses: actions/setup-node@v4
        with: { node-version: 20 }

      # Index the PR base first so there's a snapshot to diff against.
      - name: Index base (\${{ github.base_ref }})
        run: git checkout \${{ github.base_ref }} && npx tentra-mcp@latest reindex --quiet
        env:
          TENTRA_API_KEY: \${{ secrets.TENTRA_API_KEY }}

      # Back to PR HEAD and generate the review markdown.
      - name: Review PR HEAD (\${{ github.head_ref }})
        id: review
        run: |
          git checkout \${{ github.head_ref }}
          npx tentra-mcp@latest review > /tmp/review.md
        env:
          TENTRA_API_KEY: \${{ secrets.TENTRA_API_KEY }}

      - name: Post review as PR comment
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: gh pr comment \${{ github.event.pull_request.number }} --body-file /tmp/review.md
`
      mkdirSync(dirname(workflowPath), { recursive: true })
      writeFileSync(workflowPath, workflow)
      ok(`workflow: ${workflowPath}`)
      info(`Set TENTRA_API_KEY as a repo secret: ${webUrl}/settings`)
    }
  }

  // ── Post-commit hook (opt-in via --hook) ────────────────────────────────────
  if (installHook) {
    log('')
    log('\x1b[1mInstalling git post-commit hook\x1b[0m')
    const gitDir = join(root, '.git')
    if (!existsSync(gitDir)) {
      warn('Not a git repo — skipping hook install.')
    } else {
      const repoId = getFlag('repo-id') || deriveRepoId(root)
      const metadataPath = join(root, '.tentra', 'metadata.json')
      writeJsonSafe(metadataPath, { repoId, apiUrl: url })
      ok(`Repo ID: ${repoId} → ${metadataPath}`)

      const hookPath = join(gitDir, 'hooks', 'post-commit')
      const hookBody = `#!/bin/sh
# Tentra auto re-index on commit. Runs in background so the commit returns instantly.
# Silences output; logs to .tentra/last-reindex.log for debugging.
(npx tentra-mcp reindex --quiet > .tentra/last-reindex.log 2>&1 &) 2>/dev/null
`
      if (existsSync(hookPath)) {
        const existingHook = readFileSync(hookPath, 'utf8')
        if (existingHook.includes('tentra-mcp reindex')) {
          info(`post-commit hook: already wired to Tentra`)
        } else {
          warn(`post-commit hook already exists — leaving alone. Add this line yourself:\n    npx tentra-mcp reindex --quiet > .tentra/last-reindex.log 2>&1 &`)
        }
      } else {
        writeFileSync(hookPath, hookBody)
        chmodSync(hookPath, 0o755)
        ok(`post-commit hook: ${hookPath}`)
      }
    }
  }

  log('')
  if (written === 0 && skipped === 0) {
    warn('No IDE configs written. Are you in the right directory?')
  } else {
    ok(`Wrote ${written} new config(s), ${skipped} already had Tentra.`)
  }

  log('')
  log('\x1b[1mNext steps:\x1b[0m')
  log(`  1. Get your API key at ${webUrl}/settings`)
  log('  2. Replace YOUR_TENTRA_API_KEY in the config file(s) above')
  log(`  3. Reload your IDE, then ask your agent:`)
  log(`     "Index this codebase with Tentra and list the god-nodes"`)
  if (!installHook) {
    log('')
    log('\x1b[2m  Tip: add --hook to install a git post-commit hook that keeps the graph fresh automatically.\x1b[0m')
  }
  log('')
  log(`  Docs: ${webUrl}/docs/setup`)
  log('')
  process.exit(0)
}

// ─── Subcommand: reindex — runs index_code against the stored repo_id ────────

function runReindex() {
  const root = findRepoRoot(process.cwd())
  const metadataPath = join(root, '.tentra', 'metadata.json')
  const metadata = readJsonIfExists(metadataPath)
  const quiet = hasFlag('quiet')
  const output = quiet ? () => {} : log

  const url = getFlag('url') || metadata?.apiUrl || process.env.API_URL || 'https://trytentra.com/api'
  const repoId = getFlag('repo-id') || metadata?.repoId

  if (!repoId) {
    err('No repo_id. Run `npx tentra-mcp init --hook` first to configure, or pass --repo-id.')
    process.exit(1)
  }

  const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')
  if (!existsSync(serverPath)) {
    err(`MCP server bundle not found at ${serverPath}. Did the npm install complete?`)
    process.exit(1)
  }

  output(`[tentra reindex] ${repoId} (${url})`)
  const child = spawn('node', [serverPath], {
    cwd: root,
    env: { ...process.env, API_URL: url, WEB_URL: url.replace('/api', '') },
    // In quiet mode swallow stderr too — "🧩 Tentra MCP server running" etc.
    // shouldn't show up in git commit output.
    stdio: ['pipe', 'pipe', quiet ? 'ignore' : 'inherit']
  })

  let buffer = ''
  let jobDone = false
  const timeout = setTimeout(() => {
    if (!jobDone) {
      err('reindex timed out after 5 minutes')
      child.kill()
      process.exit(1)
    }
  }, 5 * 60 * 1000)

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (!line.trim().startsWith('{')) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id === 2 && msg.result?.content?.[0]?.text) {
          const body = JSON.parse(msg.result.content[0].text)
          output(`[tentra reindex] done: snapshot ${body.snapshot_id}, ${body.file_count} files`)
          jobDone = true
          clearTimeout(timeout)
          child.kill()
          process.exit(0)
        }
        if (msg.id === 2 && msg.error) {
          err(`reindex failed: ${msg.error.message || JSON.stringify(msg.error)}`)
          jobDone = true
          clearTimeout(timeout)
          child.kill()
          process.exit(1)
        }
      } catch { /* not JSON or not ours */ }
    }
  })

  child.on('exit', (code) => {
    if (!jobDone) {
      err(`MCP server exited (code ${code}) before reindex completed`)
      process.exit(1)
    }
  })

  const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n')
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tentra-reindex', version: '1' } } })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'index_code', arguments: { repo_path: root, repo_id: repoId, tier: 'tier1', force_reindex: true } } })
}

// ─── Subcommand: review — markdown summary of what changed since last snapshot ──

async function runReview() {
  const root = findRepoRoot(process.cwd())
  const metadataPath = join(root, '.tentra', 'metadata.json')
  const metadata = readJsonIfExists(metadataPath)

  const url = getFlag('url') || metadata?.apiUrl || process.env.API_URL || 'https://trytentra.com/api'
  const repoId = getFlag('repo-id') || metadata?.repoId
  const apiKey = getFlag('key') || process.env.TENTRA_API_KEY
  const baseSnapshotArg = getFlag('base-snapshot')

  if (!repoId) {
    err('No repo_id. Run `npx tentra-mcp init --hook` first, or pass --repo-id.')
    process.exit(1)
  }
  if (!apiKey) {
    err('No API key. Pass --key or set TENTRA_API_KEY.')
    process.exit(1)
  }

  const fetchJson = async (path) => {
    const res = await fetch(`${url}${path}`, { headers: { 'X-API-Key': apiKey } })
    if (!res.ok) throw new Error(`${path} → ${res.status} ${res.statusText}`)
    return res.json()
  }

  // Reindex current HEAD to get a fresh snapshot.
  const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')
  const child = spawn('node', [serverPath], {
    cwd: root, env: { ...process.env, TENTRA_API_KEY: apiKey, API_URL: url, WEB_URL: url.replace('/api', '') },
    stdio: ['pipe', 'pipe', 'ignore']
  })
  const newSnapId = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('index timed out')) }, 5 * 60 * 1000)
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1)
        if (!line.trim().startsWith('{')) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id === 2 && msg.result?.content?.[0]?.text) {
            clearTimeout(timer); child.kill()
            const body = JSON.parse(msg.result.content[0].text)
            resolve(body.snapshot_id)
          } else if (msg.id === 2 && msg.error) {
            clearTimeout(timer); child.kill()
            reject(new Error(msg.error.message || JSON.stringify(msg.error)))
          }
        } catch {}
      }
    })
    const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tentra-review', version: '1' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'index_code', arguments: { repo_path: root, repo_id: repoId, tier: 'tier1', force_reindex: true } } })
  })

  // Pick base snapshot: explicit arg wins; else second-most-recent for this repo.
  const snapList = await fetchJson(`/code-graph/query/snapshots/${encodeURIComponent(repoId)}`)
  const snaps = snapList.snapshots || []
  const baseSnap = baseSnapshotArg || snaps.find(s => s.id !== newSnapId)?.id
  if (!baseSnap) {
    // First-ever index — emit a "welcome" review instead of a diff.
    const godNodes = await fetchJson(`/code-graph/query/god-nodes?snapshot_id=${newSnapId}&top_n=5`)
    console.log(renderWelcomeReview(newSnapId, godNodes))
    process.exit(0)
  }

  const [diff, godNodes] = await Promise.all([
    fetchJson(`/code-graph/query/diff?from_id=${baseSnap}&to_id=${newSnapId}`),
    fetchJson(`/code-graph/query/god-nodes?snapshot_id=${newSnapId}&top_n=5`)
  ])
  console.log(renderDiffReview({ baseSnap, newSnapId, diff, godNodes, webUrl: url.replace('/api', '') }))
  process.exit(0)
}

function renderWelcomeReview(snapId, godNodes) {
  const gods = (godNodes.godNodes || []).map(g =>
    `- **${g.qualifiedName}** (fanIn ${g.fanIn}, fanOut ${g.fanOut}) · \`${g.filePath}\``
  ).join('\n')
  return `## 🧩 Tentra Review

First indexed snapshot for this repo — no prior state to diff against. Snapshot: \`${snapId}\`.

**Top 5 architectural hotspots (by fanIn + fanOut):**

${gods || '_No symbols indexed yet._'}

_Commit to create more snapshots. Future reviews will diff against the previous snapshot._`
}

function renderDiffReview({ baseSnap, newSnapId, diff, godNodes, webUrl }) {
  const files = diff.files || {}
  const symbols = diff.symbols || {}
  const godDiff = diff.godNodes || {}

  const filesSection = [
    files.added?.length ? `**Added files (${files.added.length}):**\n${files.added.slice(0, 10).map(p => `- \`${p}\``).join('\n')}${files.added.length > 10 ? `\n- _…and ${files.added.length - 10} more_` : ''}` : null,
    files.removed?.length ? `**Removed files (${files.removed.length}):**\n${files.removed.slice(0, 10).map(p => `- \`${p}\``).join('\n')}${files.removed.length > 10 ? `\n- _…and ${files.removed.length - 10} more_` : ''}` : null,
    files.modified?.length ? `**Modified files (${files.modified.length}):**\n${files.modified.slice(0, 10).map(p => `- \`${p}\``).join('\n')}${files.modified.length > 10 ? `\n- _…and ${files.modified.length - 10} more_` : ''}` : null
  ].filter(Boolean).join('\n\n') || '_No file changes._'

  const symbolsSection = [
    symbols.added?.length ? `**Symbols added (${symbols.added.length}):** ${symbols.added.slice(0, 15).map(s => `\`${s}\``).join(', ')}${symbols.added.length > 15 ? ` _+${symbols.added.length - 15} more_` : ''}` : null,
    symbols.removed?.length ? `**Symbols removed (${symbols.removed.length}):** ${symbols.removed.slice(0, 15).map(s => `\`${s}\``).join(', ')}${symbols.removed.length > 15 ? ` _+${symbols.removed.length - 15} more_` : ''}` : null
  ].filter(Boolean).join('\n') || null

  const godsSection = [
    godDiff.appeared?.length ? `⚠️ **New god-nodes (${godDiff.appeared.length})** — newly-high fan-in/out symbols. Review for architectural concerns:\n${godDiff.appeared.slice(0, 5).map(s => `- \`${s}\``).join('\n')}` : null,
    godDiff.resolved?.length ? `✅ **Resolved god-nodes (${godDiff.resolved.length})** — no longer hotspots: ${godDiff.resolved.slice(0, 5).map(s => `\`${s}\``).join(', ')}` : null
  ].filter(Boolean).join('\n\n') || null

  const hotspots = (godNodes.godNodes || []).slice(0, 5).map(g =>
    `- **${g.qualifiedName}** (fanIn ${g.fanIn}, fanOut ${g.fanOut}) · \`${g.filePath}\``
  ).join('\n')

  return `## 🧩 Tentra Review

Diff: \`${baseSnap}\` → \`${newSnapId}\`

### Files changed

${filesSection}

${symbolsSection ? `### Symbols\n\n${symbolsSection}\n` : ''}${godsSection ? `\n### Architectural signals\n\n${godsSection}\n` : ''}
### Current top hotspots

${hotspots || '_No symbols._'}

---
_Generated by [Tentra](${webUrl}) — persistent code graph for AI coding agents._`
}

if (subcommand === 'reindex') {
  runReindex()
} else if (subcommand === 'review') {
  runReview().catch((e) => { err(e.message || String(e)); process.exit(1) })
} else if (subcommand === 'help' || args.includes('--help') || args.includes('-h')) {
  console.log(`
  tentra-mcp — Memory for AI coding agents. Persistent code graph + AI architecture diagrams.

  USAGE:
    npx tentra-mcp init                     # zero-config install for this repo's IDE(s)
    npx tentra-mcp init --hook              # also install git post-commit auto-reindex
    npx tentra-mcp reindex                  # manual re-index (reads .tentra/metadata.json)
    npx tentra-mcp review                   # markdown diff review — pipe to gh pr comment
    npx tentra-mcp                          # start the MCP stdio server
    npx tentra-mcp --key YOUR_API_KEY       # start with an existing API key

  SUBCOMMANDS:
    init           Detect installed IDEs (Cursor, Claude Code, Codex, Windsurf) and
                   write MCP configs. With --hook, also installs a git post-commit
                   hook that keeps the code graph fresh automatically.
    reindex        Re-index this repo using the stored repo_id. Designed to run
                   non-interactively from a git hook or CI.
    review         Re-index HEAD, diff against the previous snapshot, print a
                   Markdown review to stdout. Pipe to \`gh pr comment -F -\` in
                   your CI to get auto-review on every PR.
    (default)      Start the MCP stdio server — connects to https://trytentra.com
                   and exposes 33 tools to your IDE over stdio.

  OPTIONS:
    --key <key>      Tentra API key. Without it, device-flow auth runs on first
                     tool call (browser opens for GitHub sign-in).
    --url <url>      API URL (default: https://trytentra.com/api)
    --hook           (init only) Install git post-commit hook
    --repo-id <id>   (init/reindex) Override auto-derived repo id
    --quiet          (reindex only) Suppress informational output
    --help, -h       Show this help

  33 MCP TOOLS:
    Architecture (9):      create / update / get / list / analyze / lint / sync / export / flow
    Code graph write (4):  index_code, index_code_continue, record_semantic_node, get_index_job
    Code graph read (11):  query_symbols, find_references, get_symbol_neighbors,
                           get_service_code_graph, explain_code_path, find_similar_code,
                           record_embedding, list_god_nodes, get_quality_hotspots,
                           list_snapshots, diff_snapshots
    Enrichment (9):        contracts, decisions, ownership, domains

  GETTING STARTED (60-second version):
    1. cd into your repo
    2. npx tentra-mcp init --hook    (writes IDE configs + git hook)
    3. Get your API key at https://trytentra.com/settings
    4. Replace YOUR_TENTRA_API_KEY in the generated configs, reload your IDE
    5. Ask your agent "index this codebase with Tentra"

  After step 5, every git commit auto-refreshes the graph — no manual re-indexing.

  DOCS: https://trytentra.com/docs/setup
`)
  process.exit(0)
} else {
  // ─── Default: start the stdio server ───────────────────────────────────────
  const key = getFlag('key') || process.env.TENTRA_API_KEY
  const url = getFlag('url') || process.env.API_URL || 'https://trytentra.com/api'

  if (key) process.env.TENTRA_API_KEY = key
  process.env.API_URL = url
  process.env.WEB_URL = url.replace('/api', '')

  import('../dist/index.js')
}
