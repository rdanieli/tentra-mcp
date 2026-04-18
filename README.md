# tentra-mcp

[![npm version](https://img.shields.io/npm/v/tentra-mcp.svg)](https://www.npmjs.com/package/tentra-mcp) [![npm downloads](https://img.shields.io/npm/dw/tentra-mcp.svg)](https://www.npmjs.com/package/tentra-mcp) [![CI](https://github.com/rdanieli/tentra-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/rdanieli/tentra-mcp/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Memory for AI coding agents. Persistent code graph + AI-generated architecture diagrams — MCP-native. Works in Cursor, Claude Code, Codex, and Windsurf.

Dogfood benchmark on our own monorepo: **99.4% token reduction** (156.8× ratio) across 8 "where is X implemented?" queries — 114,644 tokens via file re-read vs 731 tokens via `query_symbols`. [Full write-up →](https://trytentra.com/blog/we-measured-99-percent-token-savings-with-a-code-graph)

## Quick Start (60 seconds)

```bash
cd your-repo
npx tentra-mcp init --hook
```

One command:

1. Writes MCP config for **Cursor / Claude Code / Codex / Windsurf** (whichever are installed)
2. Installs a git `post-commit` hook so the code graph auto-refreshes after every commit — no manual re-indexing
3. Auto-derives your `repo_id` from the git remote and saves it to `.tentra/metadata.json`

Then grab your API key at [trytentra.com/settings](https://trytentra.com/settings), replace `YOUR_TENTRA_API_KEY` in the generated config, reload your IDE, and ask your agent:

```
Index this codebase with Tentra and list the god-nodes
```

From here on, every `git commit` fires a background re-index. Your agents stay caught up automatically.

> **Skip the hook:** drop `--hook` — just writes IDE configs.
> **Manual stdio install:** `npx tentra-mcp` (opens browser for GitHub device-flow auth on first tool call).
> **API key instead:** `npx tentra-mcp --key YOUR_API_KEY`.

## What is Tentra?

Tentra is the persistent memory layer for AI coding agents. Describe a system — get a diagram and 14-framework code exports. Index your repo — agents query a structured graph of files, symbols, imports, and call edges instead of re-grepping source every session.

This MCP server gives your AI assistant **32 tools**:

### Architecture (9 tools)
| Tool | Description |
|------|-------------|
| `create_architecture` | Design a new system from a description |
| `update_architecture` | Modify an existing architecture |
| `get_architecture` | Read architecture details |
| `list_architectures` | Browse all saved designs |
| `analyze_codebase` | Scan local code and generate diagram |
| `lint_architecture` | Quality checks (9 rules: orphans, SPOFs, god services) |
| `sync_architecture` | Detect drift between diagram and code |
| `export_architecture` | Export to 14 frameworks (Java, Python, Go, Rust, etc.) |
| `create_flow` | Create step-by-step flow visualization |

### Code Graph — Write (4 tools)
| Tool | Description |
|------|-------------|
| `index_code` | Walk a repo, Tree-sitter locally, start a semantic indexing job |
| `index_code_continue` | Resume an in-progress indexing job |
| `record_semantic_node` | Persist an agent-extracted semantic annotation |
| `get_index_job` | Check status of an indexing job |

### Code Graph — Read (10 tools)
| Tool | Description |
|------|-------------|
| `query_symbols` | Fuzzy trigram search across indexed symbols |
| `get_symbol_neighbors` | BFS traversal in the call/import graph |
| `get_service_code_graph` | Subgraph for a canvas service |
| `explain_code_path` | Shortest path between two symbols with semantic context |
| `find_similar_code` | pgvector cosine ANN over agent-generated embeddings |
| `record_embedding` | Persist an agent-generated embedding vector |
| `list_god_nodes` | Highest fan-in/out symbols (architectural smells) |
| `get_quality_hotspots` | Churn × complexity ranking |
| `list_snapshots` | Time-travel listing of indexed snapshots |
| `diff_snapshots` | Files / symbols / god-nodes added/removed between snapshots |

### Enrichment — Contracts, Decisions, Ownership, Domains (9 tools)
| Tool | Description |
|------|-------------|
| `set_service_mapping` | Link an indexed file or symbol to a canvas service |
| `set_domain_membership` | Assign a service or file to a domain (bounded context) |
| `record_contract` | Store a parsed API contract payload (OpenAPI, GraphQL, Protobuf) |
| `bind_contract` | Link a contract to the symbol that implements it |
| `record_decision` | Create an Architecture Decision Record, optionally linking code |
| `link_decision` | Append a link from an ADR to another symbol, file, or service |
| `get_ownership` | Resolve the owner (team or person) for a file or service |
| `get_decisions_for` | List ADRs linked to a given entity |
| `get_contracts` | List contracts, optionally filtered by kind or service |

## Setup

### Option 1: SSE (zero install)

Add to your IDE's MCP config — no local install needed:

**Cursor** (Settings > Features > MCP > Add Server):
```json
{
  "tentra": {
    "type": "sse",
    "url": "https://trytentra.com/api/mcp?key=YOUR_API_KEY"
  }
}
```

**Claude Code** (`.mcp.json` in project root):
```json
{
  "mcpServers": {
    "tentra": {
      "type": "sse",
      "url": "https://trytentra.com/api/mcp?key=YOUR_API_KEY"
    }
  }
}
```

### Option 2: Local install (needed for codebase scanning)

```bash
npx tentra-mcp
```

Authenticates automatically via GitHub on first use. Credentials are saved to `~/.tentra/credentials`.

**Cursor** config for local server:
```json
{
  "tentra": {
    "command": "npx",
    "args": ["tentra-mcp"]
  }
}
```

**Claude Code** (`.mcp.json`):
```json
{
  "mcpServers": {
    "tentra": {
      "command": "npx",
      "args": ["tentra-mcp"]
    }
  }
}
```

## Usage Examples

Once connected, just talk to your AI:

```
"Design a payment system with Stripe, Kafka, and PostgreSQL"
→ AI calls create_architecture → diagram at trytentra.com/arch/xxx

"Scan this codebase and generate the architecture"
→ AI calls analyze_codebase → detects services, DBs, queues

"Export this architecture to Java Spring Boot"
→ AI calls export_architecture → downloads zip with project scaffold

"What changed since last time? Is my diagram outdated?"
→ AI calls sync_architecture → drift report with accuracy score
```

## Export Formats

Java (Spring Boot), Node.js (Fastify), Python (FastAPI), Go (chi), Rust (Axum), .NET (ASP.NET), Kotlin (Ktor), PHP (Laravel), Ruby (Rails), Elixir (Phoenix), Docker Compose, Mermaid, ADR, Terraform

## Links

- Website: [trytentra.com](https://trytentra.com)
- Documentation: [trytentra.com/docs](https://trytentra.com/docs)
- Setup Guide: [trytentra.com/docs/setup](https://trytentra.com/docs/setup)
- Gallery: [trytentra.com/gallery](https://trytentra.com/gallery)

## Development

This repo contains the open-source MCP server. The Tentra API and web app are a separate hosted service at [trytentra.com](https://trytentra.com).

```bash
npm install --legacy-peer-deps
npm run build      # tsc --noEmit + esbuild bundle → dist/index.js
npm start          # run the bundled server
npm test           # vitest
```

The published npm package (`tentra-mcp`) ships only the bundled `dist/` — source is here for auditability and community contributions.

## License

MIT
