#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { execSync } from 'child_process'
import { homedir } from 'os'

const args = process.argv.slice(2)
const subcommand = args[0]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getFlag(name) {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null
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

// ─── Subcommand: init — zero-config install into this repo's IDEs ────────────

if (subcommand === 'init') {
  const root = findRepoRoot(process.cwd())
  const url = getFlag('url') || process.env.API_URL || 'https://trytentra.com/api'
  const webUrl = url.replace(/\/api\/?$/, '')
  const repoName = root.split('/').pop() || 'repo'

  log('')
  log('\x1b[1mTentra MCP — zero-config install\x1b[0m')
  log(`  repo: ${root}`)
  log('')

  // Config for the SSE hosted MCP server (zero install, works everywhere).
  const sseConfig = {
    type: 'sse',
    url: `${url}/mcp?key=YOUR_TENTRA_API_KEY`
  }

  // Targets by IDE. Each entry describes:
  //   path: where the config lives for that IDE
  //   shape: how to merge the tentra entry into the existing file
  const targets = [
    {
      name: 'Cursor (repo)',
      path: join(root, '.cursor', 'mcp.json'),
      shape: (existing) => ({ ...existing, mcpServers: { ...(existing?.mcpServers ?? {}), tentra: sseConfig } })
    },
    {
      name: 'Claude Code (repo)',
      path: join(root, '.mcp.json'),
      shape: (existing) => ({ ...existing, mcpServers: { ...(existing?.mcpServers ?? {}), tentra: sseConfig } })
    },
    {
      name: 'Codex CLI (repo)',
      path: join(root, '.codex', 'mcp.json'),
      shape: (existing) => ({ ...existing, mcpServers: { ...(existing?.mcpServers ?? {}), tentra: sseConfig } })
    },
    {
      name: 'Windsurf (user)',
      path: join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
      shape: (existing) => ({ ...existing, mcpServers: { ...(existing?.mcpServers ?? {}), tentra: sseConfig } })
    }
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
      writeJsonSafe(t.path, t.shape(existing ?? {}))
      ok(`${t.name}: ${t.path}`)
      written += 1
    } catch (err) {
      warn(`${t.name}: skipped (${err.message})`)
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
  log('')
  log(`  Docs: ${webUrl}/docs/setup`)
  log('')
  process.exit(0)
}

// ─── Subcommand: help / -h / --help ───────────────────────────────────────────

if (subcommand === 'help' || args.includes('--help') || args.includes('-h')) {
  console.log(`
  tentra-mcp — Memory for AI coding agents. Persistent code graph + AI architecture diagrams.

  USAGE:
    npx tentra-mcp init                     # zero-config install for this repo's IDE(s)
    npx tentra-mcp                          # start the MCP stdio server
    npx tentra-mcp --key YOUR_API_KEY       # start with an existing API key

  SUBCOMMANDS:
    init           Detect installed IDEs (Cursor, Claude Code, Codex, Windsurf)
                   and write MCP configs. Zero config flags, no prompts.
    (default)      Start the MCP stdio server — connects to https://trytentra.com
                   and exposes 32 tools to your IDE over stdio.

  OPTIONS:
    --key <key>    Tentra API key. Without it, device-flow auth runs on first
                   tool call (browser opens for GitHub sign-in).
    --url <url>    API URL (default: https://trytentra.com/api)
    --help, -h     Show this help

  32 MCP TOOLS:
    Architecture (9):   create / update / get / list / analyze / lint / sync / export / flow
    Code graph write (4):  index_code, index_code_continue, record_semantic_node, get_index_job
    Code graph read (10):  query_symbols, get_symbol_neighbors, get_service_code_graph,
                           explain_code_path, find_similar_code, record_embedding,
                           list_god_nodes, get_quality_hotspots, list_snapshots, diff_snapshots
    Enrichment (9):     contracts, decisions, ownership, domains

  GETTING STARTED:
    1. cd into your repo
    2. npx tentra-mcp init           (writes MCP config for your IDE)
    3. Get your API key at https://trytentra.com/settings
    4. Reload your IDE, ask your agent to "index this codebase with Tentra"

  DOCS: https://trytentra.com/docs/setup
`)
  process.exit(0)
}

// ─── Default: start the stdio server ─────────────────────────────────────────

const key = getFlag('key') || process.env.TENTRA_API_KEY
const url = getFlag('url') || process.env.API_URL || 'https://trytentra.com/api'

if (key) process.env.TENTRA_API_KEY = key
process.env.API_URL = url
process.env.WEB_URL = url.replace('/api', '')

import('../dist/index.js')
