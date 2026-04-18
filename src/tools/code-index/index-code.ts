import { z } from 'zod'
import { readdir, readFile } from 'fs/promises'
import { join, relative, resolve } from 'path'
import { createHash } from 'crypto'
import { execSync } from 'child_process'
import {
  detectLanguage,
  TypeScriptExtractor,
  JavaScriptExtractor,
  PythonExtractor,
  GoExtractor,
  JavaExtractor,
  RustExtractor,
  SupportedLanguage,
  ExtractionResult,
  makeBatches
} from '../../indexer/index.js'
import { apiPost } from './api-client.js'

export const IndexCodeSchema = z.object({
  repo_path: z.string().min(1),
  repo_id: z.string().min(1),
  service_id: z.string().optional(),
  force_reindex: z.boolean().optional(),
  tier: z.enum(['tier1', 'tier2', 'both']).optional(),
  batch_size: z.number().int().positive().max(50).optional()
})

const EXTRACTORS = {
  typescript: new TypeScriptExtractor(),
  javascript: new JavaScriptExtractor(),
  python:     new PythonExtractor(),
  go:         new GoExtractor(),
  java:       new JavaExtractor(),
  rust:       new RustExtractor()
} as const

// Common local/parameter identifier names that virtually never correspond to
// real exported symbols. Skip cross-file short-name resolution for `reference`
// edges whose toExternal matches one of these — otherwise `catch (err) { fn(err) }`
// falsely inflates the fanIn of any `err` symbol that happens to exist.
const COMMON_PARAM_NAMES = new Set([
  // Single letters
  'i', 'j', 'k', 'n', 's', 'e', 'v', 'x', 'y', 'z', 'a', 'b', 'c', 'd',
  // Error / exception params
  'err', 'ex', 'exc', 'error',
  // Callback / promise params
  'cb', 'done', 'next', 'resolve', 'reject',
  // Request/response in web handlers
  'req', 'res', 'ctx',
  // Data / value generics
  'data', 'val', 'value', 'key', 'obj', 'arr', 'str', 'num', 'raw',
  // Collection iteration
  'item', 'el', 'elem', 'node', 'child', 'parent', 'row', 'col',
  // Misc
  'args', 'opts', 'arg', 'msg', 'buf', 'tmp', 'idx', 'len', 'out', 'fn'
])

const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'target', 'vendor',
  // Agent-worktree scratch dirs created by tools like Claude Code Superpowers.
  // Not user-authored code; bloats the graph and pollutes diffs.
  '.claude', '.cursor-worktrees', '.worktrees', '.tmp', 'out',
  // Coverage / test artefacts
  'coverage', '.nyc_output', '.pytest_cache'
])

// Tag symbols defined in test / fixture / e2e files so queries can filter
// them out by default. Heuristic matches both directory-based and filename-
// based conventions (*.test.ts, *.spec.ts, tests/, __tests__/, fixtures/).
function isTestPath(relativePath: string): boolean {
  return /(^|\/)(tests?|__tests__|fixtures|e2e)\//i.test(relativePath)
      || /\.(test|spec)\.[a-z]+$/i.test(relativePath)
      || /(^|\/)test-[^/]+$/i.test(relativePath)
}

async function walkRepo(root: string): Promise<string[]> {
  const found: string[] = []
  async function visit(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (IGNORED.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) await visit(p)
      else if (e.isFile() && detectLanguage(p) !== 'unknown') found.push(p)
    }
  }
  await visit(root)
  return found
}

export async function indexCodeHandler(raw: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const args = IndexCodeSchema.parse(raw)
  const tier = args.tier ?? 'both'
  const batchSize = args.batch_size ?? 20
  const root = resolve(args.repo_path)

  // 1. Walk repo & build tier-1 payloads
  const absPaths = await walkRepo(root)
  const filePayloads: Array<{ relativePath: string; language: string; loc: number; contentHash: string; serviceId?: string; isTest: boolean; extraction: ExtractionResult }> = []
  for (const abs of absPaths) {
    const rel = relative(root, abs)
    const lang = detectLanguage(abs) as SupportedLanguage | 'unknown'
    if (lang === 'unknown') continue
    const src = await readFile(abs, 'utf8')
    const extractor = EXTRACTORS[lang]
    const extraction = extractor.extract(src)
    filePayloads.push({
      relativePath: rel,
      language: lang,
      loc: extraction.loc,
      contentHash: createHash('sha1').update(src).digest('hex'),
      serviceId: args.service_id,
      isTest: isTestPath(rel),
      extraction
    })
  }

  // 2. Create snapshot — capture the current git HEAD SHA so list_snapshots
  // can show "freshness" relative to the caller's working tree. Best-effort:
  // fall back to undefined if the path isn't a git repo.
  let commitSha: string | undefined
  try {
    commitSha = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    commitSha = undefined
  }
  const snap = await apiPost<{ id: string }>('/code-graph/snapshots', { repoId: args.repo_id, commitSha })

  // 2a. Upload files in chunks of 100 to avoid body-size limits; capture id mapping
  const FILE_CHUNK = 100
  const pathToFileId = new Map<string, string>()
  for (let i = 0; i < filePayloads.length; i += FILE_CHUNK) {
    const chunk = filePayloads.slice(i, i + FILE_CHUNK).map(({ extraction, ...f }) => f)
    const resp = await apiPost<{ count: number; files: Array<{ id: string; relativePath: string }> }>(
      `/code-graph/snapshots/${snap.id}/files`,
      { files: chunk }
    )
    for (const f of resp.files) pathToFileId.set(f.relativePath, f.id)
  }

  // 2b. Upload symbols for every file (tier-1 static analysis output)
  const SYMBOL_CHUNK = 200
  const symbolsToUpload = [] as Array<{
    fileId: string
    kind: string
    name: string
    qualifiedName: string
    startLine: number
    endLine: number
  }>
  for (const fp of filePayloads) {
    const fileId = pathToFileId.get(fp.relativePath)
    if (!fileId) continue
    for (const s of fp.extraction.symbols) {
      symbolsToUpload.push({
        fileId,
        kind: s.kind,
        name: s.name,
        qualifiedName: s.qualifiedName,
        startLine: s.startLine,
        endLine: s.endLine
      })
    }
  }
  const qnToSymbolId = new Map<string, string>()
  // Map qualifiedName → fileId so we can prefer same-file resolution when
  // cross-file short-name matches are ambiguous. Prevents bin-local helpers
  // like `log` (defined and called within bin/tentra-mcp.js) from inflating
  // the fanIn of an unrelated production `log` symbol elsewhere.
  const qnToFileId = new Map<string, string>()
  // Map short-name → candidate (symbolId, fileId) tuples. One short name can
  // resolve to multiple symbols (method conflicts across classes / same name
  // used locally in two files) — we keep all candidates and pick the best at
  // edge-resolution time.
  const shortNameToCandidates = new Map<string, Array<{ id: string; fileId: string }>>()
  if (symbolsToUpload.length > 0) {
    // De-duplicate by qualifiedName within snapshot — upsert key in the DB.
    const seen = new Set<string>()
    const deduped = [] as typeof symbolsToUpload
    for (let i = symbolsToUpload.length - 1; i >= 0; i--) {
      const s = symbolsToUpload[i]
      if (seen.has(s.qualifiedName)) continue
      seen.add(s.qualifiedName)
      deduped.unshift(s)
    }
    // Build qualifiedName → fileId map from the deduped payload so we can
    // correlate server-returned IDs back to their source file.
    const qnToFileIdPayload = new Map<string, string>()
    for (const d of deduped) qnToFileIdPayload.set(d.qualifiedName, d.fileId)

    for (let i = 0; i < deduped.length; i += SYMBOL_CHUNK) {
      const chunk = deduped.slice(i, i + SYMBOL_CHUNK)
      const resp = await apiPost<{ count: number; symbols: Array<{ id: string; qualifiedName: string }> }>(
        `/code-graph/snapshots/${snap.id}/symbols`,
        { symbols: chunk }
      )
      for (const s of resp.symbols) {
        const fileId = qnToFileIdPayload.get(s.qualifiedName) ?? ''
        qnToSymbolId.set(s.qualifiedName, s.id)
        qnToFileId.set(s.qualifiedName, fileId)
        const dot = s.qualifiedName.lastIndexOf('.')
        const shortName = dot >= 0 ? s.qualifiedName.slice(dot + 1) : s.qualifiedName
        const bucket = shortNameToCandidates.get(shortName)
        const entry = { id: s.id, fileId }
        if (bucket) bucket.push(entry)
        else shortNameToCandidates.set(shortName, [entry])
      }
    }
  }

  // 2c. Upload edges — resolve qualifiedName → symbolId, with short-name fallback
  const EDGE_CHUNK = 500
  const edgesToUpload = [] as Array<{
    fromSymbolId: string | null
    toSymbolId: string | null
    toExternal: string | null
    edgeType: string
  }>
  let resolvedViaShort = 0
  let resolvedSameFile = 0
  let methodCallsSkipped = 0
  let fileOwnerReferences = 0
  let paramRefsSkipped = 0
  for (const fp of filePayloads) {
    const fileId = pathToFileId.get(fp.relativePath) ?? ''
    for (const e of fp.extraction.edges) {
      // Resolve `from`: either a real symbol or the FILE_OWNER sentinel.
      // FILE_OWNER edges come from file-scope code (top-level `server.tool(...)`,
      // module-level imports/calls). They contribute to the target's fanIn but
      // no specific symbol gets fanOut credit.
      const isFileOwnerFrom = e.fromQualifiedName === '<file>'
      const fromId = isFileOwnerFrom ? null : (qnToSymbolId.get(e.fromQualifiedName) ?? null)
      if (!isFileOwnerFrom && !fromId) continue // orphan — skip

      // Resolution strategy for `to` (in order):
      //   1. e.toQualifiedName directly in qnToSymbolId — fully qualified match
      //   2. For bare `call` edges only: same-file short-name match, then
      //      unique cross-file short-name match.
      //   3. For `method_call` edges: ONLY the fully-qualified match above.
      //      Method calls (`foo.bar()`) target a member of whatever `foo`
      //      is at runtime — we cannot resolve that statically without type
      //      inference, and short-name fallback would incorrectly glue every
      //      `console.log` onto a random `log` symbol in the codebase.
      //   4. Else keep as external (toSymbolId=null, toExternal preserved).
      let toId: string | null = null
      let toExternal = e.toExternal
      if (e.toQualifiedName) {
        toId = qnToSymbolId.get(e.toQualifiedName) ?? null
      }
      if (!toId && e.toExternal && e.edgeType === 'method_call') {
        // Method call with no qualified-name hit — don't guess. Count and skip.
        methodCallsSkipped += 1
      } else if (!toId && e.toExternal && e.edgeType === 'reference' && COMMON_PARAM_NAMES.has(e.toExternal)) {
        // Common parameter/local names (`err`, `e`, `data`, `req`, …) are almost
        // never real exported symbols. `catch (err) { fn(err) }` emits a reference
        // edge to `err`; without this guard, a lone `err` helper somewhere in the
        // repo would absorb every caller's fanIn via the unique cross-file fallback.
        // Same-file resolution stays enabled (a legit local `err` helper in the
        // same file still resolves — that's the correct local binding).
        const sameFile = (shortNameToCandidates.get(e.toExternal) ?? []).filter(c => c.fileId === fileId)
        if (sameFile.length === 1) {
          toId = sameFile[0].id
          toExternal = null
          resolvedSameFile += 1
        } else {
          paramRefsSkipped += 1
        }
        // No cross-file fallback for blocklisted names — leaves edge external.
      } else if (!toId && e.toExternal) {
        const candidates = shortNameToCandidates.get(e.toExternal)
        if (candidates && candidates.length > 0) {
          // Prefer same-file match when the caller's file contains a candidate.
          const sameFile = candidates.filter(c => c.fileId === fileId)
          if (sameFile.length === 1) {
            toId = sameFile[0].id
            toExternal = null
            resolvedSameFile += 1
          } else if (candidates.length === 1) {
            // Unique cross-file match (no same-file candidate at all).
            toId = candidates[0].id
            toExternal = null
            resolvedViaShort += 1
          }
          // Otherwise: ambiguous (multiple candidates across files, no
          // same-file tiebreak). Leave external.
        }
      }
      // Skip FILE_OWNER edges that resolved to nothing useful (no target).
      // Those would just be noise on the edges table.
      if (isFileOwnerFrom && !toId) continue
      if (isFileOwnerFrom) fileOwnerReferences += 1

      edgesToUpload.push({
        fromSymbolId: fromId,
        toSymbolId: toId,
        toExternal,
        edgeType: e.edgeType
      })
    }
  }
  for (let i = 0; i < edgesToUpload.length; i += EDGE_CHUNK) {
    const chunk = edgesToUpload.slice(i, i + EDGE_CHUNK)
    await apiPost(`/code-graph/snapshots/${snap.id}/edges`, { edges: chunk })
  }
  // Emit resolution stats to stderr so the operator can see how effective
  // the unique-short-name heuristic was for this repo.
  if (resolvedSameFile > 0) {
    console.error(`[index_code] resolved ${resolvedSameFile} edges via same-file short-name match`)
  }
  if (resolvedViaShort > 0) {
    console.error(`[index_code] resolved ${resolvedViaShort} edges via cross-file short-name unique match`)
  }
  if (methodCallsSkipped > 0) {
    console.error(`[index_code] skipped ${methodCallsSkipped} method_call edges (receiver type unknown — left external)`)
  }
  if (fileOwnerReferences > 0) {
    console.error(`[index_code] captured ${fileOwnerReferences} file-scope reference edges (callback patterns → fanIn)`)
  }
  if (paramRefsSkipped > 0) {
    console.error(`[index_code] skipped ${paramRefsSkipped} reference edges to common param names (err/e/data/req/... — blocklist)`)
  }

  // 3. Create job
  const job = await apiPost<{ id: string }>('/code-graph/jobs', {
    repoId: args.repo_id,
    snapshotId: snap.id,
    tier,
    totalFiles: filePayloads.length
  })

  // 4. Tier-1 only: mark job complete and return
  if (tier === 'tier1') {
    await apiPost(`/code-graph/jobs/${job.id}/complete`, {})
    return { content: [{ type: 'text', text: JSON.stringify({ job_id: job.id, snapshot_id: snap.id, file_count: filePayloads.length, tier: 'tier1', done: true }) }] }
  }

  // 5. Tier-2 mode: return first batch for the agent to process
  const batches = makeBatches(filePayloads.map((f) => ({
    relativePath: f.relativePath,
    language: f.language,
    loc: f.loc,
    symbols_skeleton: f.extraction.symbols.map((s) => ({ name: s.name, qualifiedName: s.qualifiedName, kind: s.kind }))
  })), batchSize)

  return {
    content: [{ type: 'text', text: JSON.stringify({
      job_id: job.id,
      snapshot_id: snap.id,
      file_count: filePayloads.length,
      first_batch: batches[0] ?? [],
      remaining: Math.max(0, filePayloads.length - (batches[0]?.length ?? 0))
    }) }]
  }
}
