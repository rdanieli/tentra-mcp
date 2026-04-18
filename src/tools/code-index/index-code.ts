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

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'target', 'vendor'])

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
  const filePayloads: Array<{ relativePath: string; language: string; loc: number; contentHash: string; serviceId?: string; extraction: ExtractionResult }> = []
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
  // Map short-name → candidate symbol IDs, used for cross-file resolution of
  // edges whose callee is only known by its local identifier (e.g. "upsert",
  // "createSnapshot"). Tree-sitter extraction can't resolve these at parse
  // time without import analysis, so we do a post-hoc unique-match pass.
  const shortNameToIds = new Map<string, string[]>()
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
    for (let i = 0; i < deduped.length; i += SYMBOL_CHUNK) {
      const chunk = deduped.slice(i, i + SYMBOL_CHUNK)
      const resp = await apiPost<{ count: number; symbols: Array<{ id: string; qualifiedName: string }> }>(
        `/code-graph/snapshots/${snap.id}/symbols`,
        { symbols: chunk }
      )
      for (const s of resp.symbols) {
        qnToSymbolId.set(s.qualifiedName, s.id)
        // Short name is the last segment after "." (e.g. "Cart.total" -> "total",
        // or bare identifier like "foo" -> "foo"). One short name can resolve
        // to multiple symbols (method conflicts across classes) — collect all.
        const dot = s.qualifiedName.lastIndexOf('.')
        const shortName = dot >= 0 ? s.qualifiedName.slice(dot + 1) : s.qualifiedName
        const bucket = shortNameToIds.get(shortName)
        if (bucket) bucket.push(s.id)
        else shortNameToIds.set(shortName, [s.id])
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
  let fileOwnerReferences = 0
  for (const fp of filePayloads) {
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
      //   2. e.toExternal matches exactly one symbol by short-name — unique cross-file match
      //   3. Else keep as external (toSymbolId=null, toExternal preserved)
      let toId: string | null = null
      let toExternal = e.toExternal
      if (e.toQualifiedName) {
        toId = qnToSymbolId.get(e.toQualifiedName) ?? null
      }
      if (!toId && e.toExternal) {
        const candidates = shortNameToIds.get(e.toExternal)
        if (candidates && candidates.length === 1) {
          toId = candidates[0]
          toExternal = null  // no longer external — we resolved it
          resolvedViaShort += 1
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
  if (resolvedViaShort > 0) {
    console.error(`[index_code] resolved ${resolvedViaShort} edges via short-name unique match`)
  }
  if (fileOwnerReferences > 0) {
    console.error(`[index_code] captured ${fileOwnerReferences} file-scope reference edges (callback patterns → fanIn)`)
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
