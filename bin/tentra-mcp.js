#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { join, dirname } from 'path'
import { execSync, spawn } from 'child_process'
import { homedir } from 'os'
import { fileURLToPath } from 'url'

const args = process.argv.slice(2)
// First non-flag token is the subcommand (init / reindex / review). Flags like
// --local / --hosted may precede or follow the subcommand — tolerate both so
// `npx tentra-mcp --local init` and `npx tentra-mcp init --local` both work.
const subcommand = args.find(a => !a.startsWith('--') && a !== '-h')

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getFlag(name) {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null
}

function hasFlag(name) {
  return args.includes(`--${name}`)
}

// ─── Backend mode resolution ─────────────────────────────────────────────────
//
// --local  → force TENTRA_BACKEND=local. No network, no auth, tier-1 only.
// --hosted → force TENTRA_BACKEND=hosted. Overrides any local-mode hints in
//            .tentra/metadata.json (Phase 3 feature).
// neither  → leave env untouched (current default is hosted if unset).
//
// IMPORTANT: this must run BEFORE any `import('../dist/index.js')` or any child
// spawn, so the bundled server + any subprocesses pick up the right backend.
const LOCAL_MODE = hasFlag('local')
const HOSTED_MODE = hasFlag('hosted')
if (LOCAL_MODE && HOSTED_MODE) {
  console.error('\x1b[31m✗\x1b[0m --local and --hosted are mutually exclusive.')
  process.exit(2)
}
if (LOCAL_MODE) process.env.TENTRA_BACKEND = 'local'
if (HOSTED_MODE) process.env.TENTRA_BACKEND = 'hosted'

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

  // Local-mode banner — swap the "get an API key" story for a "here's your
  // SQLite file" story. Tier-2 tools (architecture + embeddings) are cut; the
  // help text points the user at the docs for the full matrix.
  if (LOCAL_MODE) {
    log('')
    log('\x1b[1mRunning in local mode — no network.\x1b[0m')
    log(`  \x1b[2m~/.tentra/graphs/{repoId}/db.sqlite is your only data.\x1b[0m`)
    log('')
    log('\x1b[1mNext steps:\x1b[0m')
    log('  1. Reload your IDE and ask your agent:')
    log('     "Index this codebase with Tentra and list the god-nodes"')
    log('  2. Everything stays on this machine. No API key needed.')
    log(`  3. Architecture diagrams + tier-2 enrichment (contracts, decisions, domains) require hosted mode.`)
    log('')
    log(`  Local-mode docs: ${webUrl}/docs/local`)
    log('')
    process.exit(0)
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
  // Local mode skips the API key check — all review data is served from the
  // in-process SQLite file via the MCP server spawned below. Hosted mode still
  // requires a key to hit /code-graph/query endpoints directly.
  if (!LOCAL_MODE && !apiKey) {
    err('No API key. Pass --key or set TENTRA_API_KEY.')
    process.exit(1)
  }

  const fetchJson = async (path) => {
    const res = await fetch(`${url}${path}`, { headers: { 'X-API-Key': apiKey } })
    if (!res.ok) throw new Error(`${path} → ${res.status} ${res.statusText}`)
    return res.json()
  }

  // Reindex current HEAD to get a fresh snapshot.
  //
  // Hosted mode: spawn the server, index, kill it, then read review data
  // directly from /code-graph/query/* HTTP endpoints (fast path).
  //
  // Local mode: keep the server alive and send additional tools/call JSON-RPCs
  // over the same stdio pipe for list_snapshots / list_god_nodes / diff_snapshots.
  // That avoids duplicating the SQLite-backed query logic in the CLI and reuses
  // the exact same localDispatch() code paths the MCP tools use.
  const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')
  const child = spawn('node', [serverPath], {
    cwd: root, env: { ...process.env, TENTRA_API_KEY: apiKey, API_URL: url, WEB_URL: url.replace('/api', '') },
    stdio: ['pipe', 'pipe', 'ignore']
  })

  // Dispatch pending JSON-RPC calls by id. Each call gets a fresh id and
  // resolves when its matching response arrives. Keeps the review pipeline
  // readable as a series of awaited tool calls rather than nested callbacks.
  const pending = new Map()
  let nextId = 1
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1)
      if (!line.trim().startsWith('{')) continue
      try {
        const msg = JSON.parse(line)
        const resolver = pending.get(msg.id)
        if (!resolver) continue
        pending.delete(msg.id)
        if (msg.result) resolver.resolve(msg.result)
        else resolver.reject(new Error(msg.error?.message || JSON.stringify(msg.error)))
      } catch { /* not JSON / not ours */ }
    }
  })
  const callTool = (name, argumentsObj, timeoutMs = 5 * 60 * 1000) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      const t = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${name} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const origResolve = resolve, origReject = reject
      pending.set(id, {
        resolve: (r) => { clearTimeout(t); origResolve(r) },
        reject: (e) => { clearTimeout(t); origReject(e) }
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: argumentsObj } }) + '\n')
    })
  const parseToolResult = (result) => JSON.parse(result?.content?.[0]?.text ?? '{}')

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tentra-review', version: '1' } } }) + '\n')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  try {
    const indexResult = await callTool('index_code', { repo_path: root, repo_id: repoId, tier: 'tier1', force_reindex: true })
    const indexBody = parseToolResult(indexResult)
    const newSnapId = indexBody.snapshot_id
    if (!newSnapId) throw new Error('index_code returned no snapshot_id')

    const webUrl = url.replace('/api', '')

    // ── Fetch review data. Prefer the in-process MCP tools in LOCAL mode (no
    //    API key, no network); keep the HTTP fast-path for hosted where it's
    //    meaningfully cheaper than round-tripping JSON-RPC.
    const fetchSnapshots = async () => LOCAL_MODE
      ? parseToolResult(await callTool('list_snapshots', { repo_id: repoId }))
      : await fetchJson(`/code-graph/query/snapshots/${encodeURIComponent(repoId)}`)

    const fetchGodNodes = async (snapId) => LOCAL_MODE
      ? parseToolResult(await callTool('list_god_nodes', { snapshot_id: snapId, top_n: 5 }))
      : await fetchJson(`/code-graph/query/god-nodes?snapshot_id=${snapId}&top_n=5`)

    const fetchDiff = async (fromId, toId) => LOCAL_MODE
      ? parseToolResult(await callTool('diff_snapshots', { from_snapshot_id: fromId, to_snapshot_id: toId }))
      : await fetchJson(`/code-graph/query/diff?from_id=${fromId}&to_id=${toId}`)

    const snapList = await fetchSnapshots()
    const snaps = snapList.snapshots || []
    const baseSnap = baseSnapshotArg || snaps.find(s => s.id !== newSnapId)?.id
    if (!baseSnap) {
      const godNodes = await fetchGodNodes(newSnapId)
      console.log(renderWelcomeReview(newSnapId, godNodes))
      child.kill()
      process.exit(0)
    }

    const [diff, godNodes] = await Promise.all([
      fetchDiff(baseSnap, newSnapId),
      fetchGodNodes(newSnapId)
    ])
    console.log(renderDiffReview({ baseSnap, newSnapId, diff, godNodes, webUrl }))
    child.kill()
    process.exit(0)
  } catch (e) {
    try { child.kill() } catch {}
    throw e
  }
}

// ─── Render helpers ──────────────────────────────────────────────────────────
//
// Both renderers produce a single markdown string that's safe to pipe to
// `gh pr comment --body-file`. They must also stay legible when the markdown
// is read raw (logs, terminals), so:
//   - `<details>` is only used for sections that would be noisy otherwise —
//     the <summary> always carries the count, so the collapsed form is
//     still informative in plain-text readers (which just render all blocks).
//   - Emojis map 1:1 to severity tiers (🚨 new god-node, ⚠️ high-fan-in
//     touch, ✅ resolved hotspot, 📦 neutral add/remove, 📊 summary header).
//     Decoration-only emojis were dropped so the ones that remain carry
//     signal.
//   - Empty sections still emit "None." rather than being elided — the
//     output shape is predictable, which makes downstream scripts that
//     grep for "New god-nodes" work reliably.

const REVIEW_URL = 'https://trytentra.com'
const MAX_ROWS = 10

function codeList(items, max = MAX_ROWS) {
  const shown = items.slice(0, max).map(p => `- \`${p}\``).join('\n')
  const extra = items.length > max ? `\n- _…and ${items.length - max} more_` : ''
  return shown + extra
}

// Wraps a block in <details> when it exceeds 5 rows. Summary always carries
// the count so collapsed state remains informative.
function collapsible(summary, bodyItems, max = MAX_ROWS) {
  if (!bodyItems.length) return null
  if (bodyItems.length <= 5) {
    return `**${summary}**\n${codeList(bodyItems, max)}`
  }
  return `<details>\n<summary><b>${summary}</b></summary>\n\n${codeList(bodyItems, max)}\n\n</details>`
}

// "Ask your agent" blockquote. Takes pre-picked prompts so the caller decides
// which real symbol names to reference. Blockquote keeps the prompts visually
// separated from the analytical body above.
function askYourAgentBlock(prompts) {
  const lines = prompts.map(p => `> - \`${p}\``).join('\n')
  return `> **Ask your agent** (copy-paste into Cursor / Claude Code / Codex):\n>\n${lines}`
}

function renderWelcomeReview(snapId, godNodes) {
  const gods = (godNodes.godNodes || []).slice(0, 5)
  const topGod = gods[0]
  const godsBody = gods.length
    ? gods.map(g =>
        `- **\`${g.qualifiedName}\`** — fanIn ${g.fanIn}, fanOut ${g.fanOut} · \`${g.filePath}\``
      ).join('\n')
    : 'None.'

  const summarySentence = topGod
    ? `📊 First snapshot indexed — ${gods.length} hotspot${gods.length === 1 ? '' : 's'} surfaced (top: \`${topGod.qualifiedName}\`).`
    : '📊 First snapshot indexed — repo is clean, no hotspots yet.'

  const prompts = [
    'Using Tentra, list the god-nodes in this repo and explain why each one is central',
    topGod
      ? `Using Tentra, find all references to ${topGod.qualifiedName} and propose a refactor`
      : 'Using Tentra, find the most-called symbols and propose refactors',
    'Using Tentra, after my next commit diff this snapshot against the new one'
  ]

  return `${summarySentence}

## Tentra Review

First indexed snapshot for this repo — no prior state to diff against.
Snapshot: \`${snapId}\`.

### Top architectural hotspots

_Ranked by fanIn + fanOut. High values usually mean "central utility" or "god-node" — worth keeping an eye on._

${godsBody}

${askYourAgentBlock(prompts)}

---
_Generated by [Tentra](${REVIEW_URL}) — [open snapshot](${REVIEW_URL}/snapshots/${snapId}) — [regenerate](${REVIEW_URL}/docs/cli#review)_`
}

function renderDiffReview({ baseSnap, newSnapId, diff, godNodes, webUrl }) {
  const files = diff.files || {}
  const symbols = diff.symbols || {}
  const godDiff = diff.godNodes || {}

  const added = files.added || []
  const removed = files.removed || []
  const modified = files.modified || []
  const symsAdded = symbols.added || []
  const symsRemoved = symbols.removed || []
  const appeared = godDiff.appeared || []
  const resolved = godDiff.resolved || []

  const hotspots = (godNodes.godNodes || []).slice(0, 5)
  const hotspotIndex = new Map(hotspots.map(g => [g.qualifiedName, g]))

  // Enrich newly-appeared god-nodes with fanIn/filePath when they're also in
  // the current top-5 hotspots (not guaranteed — the appeared set can be
  // larger than the top-5 view).
  const appearedEnriched = appeared.map(qn => ({ qn, meta: hotspotIndex.get(qn) }))

  // "Biggest architectural signal" heuristic: a god-node that newly appeared
  // AND is in the current top-5 hotspots is almost certainly the symbol this
  // PR pushed over the threshold. Surface it as a one-line call-out — the
  // most actionable thing in a typical review.
  const topNewGod = appearedEnriched.find(x => x.meta) || (appeared[0] ? { qn: appeared[0], meta: null } : null)

  // High-fan-in change detector: top hotspots with fanIn > 50 whose file is
  // in the modified-files list. The diff endpoint doesn't expose
  // file→symbol, so this is an approximation.
  const modifiedSet = new Set(modified)
  const highFanInTouched = hotspots.filter(h => h.fanIn > 50 && h.filePath && modifiedSet.has(h.filePath))

  // ── Summary sentence (header) ──────────────────────────────────────────────
  // Crude "services touched" count: top-2 path segments, restricted to
  // common monorepo layouts. Good enough for a one-line pre-click signal.
  const serviceGuess = new Set(
    [...added, ...modified, ...removed]
      .map(p => p.split('/').slice(0, 2).join('/'))
      .filter(p => p.startsWith('packages/') || p.startsWith('apps/') || p.startsWith('services/'))
  )
  const fileCount = added.length + removed.length + modified.length
  const summaryBits = [
    `${fileCount} file${fileCount === 1 ? '' : 's'} changed`,
    serviceGuess.size ? `${serviceGuess.size} service${serviceGuess.size === 1 ? '' : 's'} touched` : null,
    appeared.length ? `🚨 ${appeared.length} new god-node${appeared.length === 1 ? '' : 's'}` : null,
    resolved.length ? `✅ ${resolved.length} resolved` : null,
    highFanInTouched.length ? `⚠️ ${highFanInTouched.length} high-fan-in symbol${highFanInTouched.length === 1 ? '' : 's'} touched` : null
  ].filter(Boolean)
  const summarySentence = `📊 ${summaryBits.join(' · ')}.`

  // ── Files section ─────────────────────────────────────────────────────────
  const filesBlocks = [
    added.length ? collapsible(`📦 Added files (${added.length})`, added) : null,
    removed.length ? collapsible(`📦 Removed files (${removed.length})`, removed) : null,
    modified.length ? collapsible(`📦 Modified files (${modified.length})`, modified) : null
  ].filter(Boolean)
  const filesSection = filesBlocks.length ? filesBlocks.join('\n\n') : 'None.'

  // ── Symbols section ───────────────────────────────────────────────────────
  const symbolsBlocks = [
    symsAdded.length ? collapsible(`📦 Symbols added (${symsAdded.length})`, symsAdded) : null,
    symsRemoved.length ? collapsible(`📦 Symbols removed (${symsRemoved.length})`, symsRemoved) : null
  ].filter(Boolean)
  const symbolsSection = symbolsBlocks.length ? symbolsBlocks.join('\n\n') : 'None.'

  // ── Architectural signals ─────────────────────────────────────────────────
  const signalBlocks = []

  if (appeared.length) {
    const rows = appeared.slice(0, MAX_ROWS).map(qn => {
      const meta = hotspotIndex.get(qn)
      return meta
        ? `- 🚨 **\`${qn}\`** — fanIn ${meta.fanIn}, fanOut ${meta.fanOut} · \`${meta.filePath}\``
        : `- 🚨 **\`${qn}\`**`
    }).join('\n')
    const extra = appeared.length > MAX_ROWS ? `\n- _…and ${appeared.length - MAX_ROWS} more_` : ''
    const header = `🚨 **New god-nodes (${appeared.length})** — symbols that just crossed the hotspot threshold. Biggest signal in this PR.`
    // Keep this one open-by-default — it's the most important block.
    if (appeared.length <= 5) {
      signalBlocks.push(`${header}\n\n${rows}${extra}`)
    } else {
      signalBlocks.push(`<details open>\n<summary>${header}</summary>\n\n${rows}${extra}\n\n</details>`)
    }
  } else {
    signalBlocks.push(`🚨 **New god-nodes (0)** — None.`)
  }

  if (highFanInTouched.length) {
    const rows = highFanInTouched.slice(0, MAX_ROWS).map(h =>
      `- ⚠️ **\`${h.qualifiedName}\`** — fanIn ${h.fanIn}, changes ripple widely · \`${h.filePath}\``
    ).join('\n')
    signalBlocks.push(`⚠️ **High-fan-in changes (${highFanInTouched.length})** — modifying these touches many callers.\n\n${rows}`)
  }

  if (resolved.length) {
    signalBlocks.push(
      `✅ **Resolved god-nodes (${resolved.length})** — no longer hotspots (usually a refactor landing): ${resolved.slice(0, MAX_ROWS).map(s => `\`${s}\``).join(', ')}${resolved.length > MAX_ROWS ? ` _+${resolved.length - MAX_ROWS} more_` : ''}`
    )
  } else {
    signalBlocks.push(`✅ **Resolved god-nodes (0)** — None.`)
  }

  const signalsSection = signalBlocks.join('\n\n')

  // ── Top symbol call-out (find_references example) ────────────────────────
  const calloutTarget = topNewGod?.meta || hotspots[0]
  const callout = calloutTarget
    ? `> **Biggest architectural signal:** \`${calloutTarget.qualifiedName}\` — fanIn ${calloutTarget.fanIn}, fanOut ${calloutTarget.fanOut}.
> Run \`find_references(symbol_id="${calloutTarget.id}")\` to see every caller, or open it in the [Tentra graph UI](${webUrl}/snapshots/${newSnapId}).`
    : null

  // ── Current hotspots ──────────────────────────────────────────────────────
  const hotspotsBody = hotspots.length
    ? hotspots.map(g =>
        `- **\`${g.qualifiedName}\`** — fanIn ${g.fanIn}, fanOut ${g.fanOut} · \`${g.filePath}\``
      ).join('\n')
    : 'None.'

  // ── Ask-your-agent prompts ────────────────────────────────────────────────
  // Pick real symbol names so the prompts are copy-paste ready. Priority:
  // new god-node → added symbol → existing hotspot → fallback to snapshot IDs.
  const topChangedSymbol = calloutTarget?.qualifiedName
    || symsAdded[0]
    || appeared[0]
    || hotspots[0]?.qualifiedName
  const topNewGodQn = topNewGod?.qn || appeared[0] || topChangedSymbol
  const prompts = [
    topChangedSymbol
      ? `Using Tentra, explain why ${topChangedSymbol}'s fan-in shifted in this PR`
      : `Using Tentra, summarise what changed between snapshot ${baseSnap.slice(0, 8)} and ${newSnapId.slice(0, 8)}`,
    topNewGodQn
      ? `Using Tentra, find all references to ${topNewGodQn} and propose a refactor`
      : `Using Tentra, list the current god-nodes and rank them by blast radius`,
    `Using Tentra, diff snapshot ${baseSnap.slice(0, 8)} against ${newSnapId.slice(0, 8)} and highlight risky churn`
  ]

  return `${summarySentence}

## Tentra Review

Diff: \`${baseSnap}\` → \`${newSnapId}\`.

${callout ? callout + '\n\n' : ''}### Architectural signals

${signalsSection}

### Files changed

${filesSection}

### Symbols

${symbolsSection}

### Current top hotspots

${hotspotsBody}

${askYourAgentBlock(prompts)}

---
_Generated by [Tentra](${webUrl}) — [open snapshot](${webUrl}/snapshots/${newSnapId}) — [regenerate](${webUrl}/docs/cli#review)_`
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
    npx tentra-mcp --local init             # offline install — no account, no API key
    npx tentra-mcp --local reindex          # refresh the local SQLite graph
    npx tentra-mcp --local                  # start the MCP server against local SQLite

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

  BACKEND MODES:
    --local        Use a local SQLite graph in ~/.tentra/graphs/{repoId}/db.sqlite.
                   No network, no account, no API key. Tier-1 tools + embeddings
                   (pure-JS cosine). Architecture + enrichment require hosted mode.
    --hosted       Force hosted mode (default). Overrides any local-mode hints in
                   .tentra/metadata.json.

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
