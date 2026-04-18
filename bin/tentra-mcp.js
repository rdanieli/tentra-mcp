#!/usr/bin/env node

const args = process.argv.slice(2)

// Parse --key and --url flags
function getFlag(name) {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null
}

const key = getFlag('key') || process.env.TENTRA_API_KEY
const url = getFlag('url') || process.env.API_URL || 'https://trytentra.com/api'

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  tentra-mcp — AI Architecture Tools for your IDE

  USAGE:
    npx tentra-mcp                          # auto-authenticates via GitHub
    npx tentra-mcp --key YOUR_API_KEY       # use an existing API key

  OPTIONS:
    --key <key>    Tentra API key (optional — device flow auth is used by default)
    --url <url>    API URL (default: https://trytentra.com/api)
    --help         Show this help

  AUTHENTICATION:
    On first use, your browser will open for one-click GitHub sign-in.
    Credentials are saved to ~/.tentra/credentials for future sessions.
    Use --key to skip device flow and use an API key directly.

  10 MCP TOOLS:
    create_architecture    Design a new system
    update_architecture    Modify existing design
    get_architecture       Read architecture details
    list_architectures     Browse saved designs
    analyze_codebase       Scan code → diagram
    lint_architecture      Quality checks (9 rules)
    sync_architecture      Detect drift vs code
    export_architecture    Export to 14 frameworks
    create_flow            Step-by-step flow viz
    explain_architecture   Guided walkthrough

  DOCS: https://trytentra.com/docs/setup
`)
  process.exit(0)
}

// Set environment variables for the MCP server
if (key) process.env.TENTRA_API_KEY = key
process.env.API_URL = url
process.env.WEB_URL = url.replace('/api', '')

// Start the MCP server
import('../dist/index.js')
