import { z } from 'zod'
import { apiPost, apiPatch, apiGet } from './api-client.js'

export const RecordSemanticNodeSchema = z.object({
  job_id: z.string().min(1).describe('Active indexing job_id from index_code. Required — this is what ties the annotation back to a job and advances its progress cursor.'),
  file_id: z.string().optional().describe('CodeFile ID to annotate. Provide EITHER file_id or symbol_id (exactly one — tool errors if both or neither). Use file_id for file-level purpose descriptions; use symbol_id for a specific function/class.'),
  symbol_id: z.string().optional().describe('CodeSymbol ID to annotate. Provide EITHER file_id or symbol_id (not both). Use for fine-grained annotations on one function/class/method; prefer file_id for coarse per-file summaries.'),
  snapshot_id: z.string().min(1).describe('Snapshot the file or symbol belongs to (from index_code response). Required — semantic nodes are snapshot-scoped so they can evolve over time.'),
  purpose: z.string().min(1).describe('One-sentence human-readable purpose string. Example: "Verifies HMAC signatures on incoming Stripe webhooks". Shown in query_symbols results, get_service_code_graph (include_semantics=true), and explain_code_path hop annotations. Keep under ~200 chars.'),
  domain_tags: z.array(z.string()).default([]).describe('Free-form business-domain labels (e.g. ["payments", "webhooks", "security"]). Used to slice the graph by domain. Defaults to []. Lowercase snake-case recommended.'),
  confidence: z.number().min(0).max(1).default(0.7).describe('How certain the agent is about the purpose/tags, 0–1. Default 0.7 (moderate). Use ~0.9 when the symbol is obvious (big docstring, clear name), ~0.5 when guessing.'),
  extracted_by: z.string().min(1).describe('Identifier of the agent / model that produced this extraction, e.g. "claude-opus-4-7" or "gpt-5-mini". Required for audit trails and for re-running extraction on model upgrades.'),
  semantic_role_slug: z.string().optional().describe('Optional semantic role from the SemanticRole catalog (e.g. "service", "repository", "controller", "handler"). Helps query_symbols filter by architectural role.'),
  is_god_node: z.boolean().optional().describe('Optional override of the auto-computed isGodNode flag on the symbol. Usually omit — Tentra derives it from fanIn/fanOut. Set true only when you have strong evidence of coupling the static analysis missed.'),
  lens_metadata: z.record(z.unknown()).optional().describe('Arbitrary JSON payload scoped to whichever "lens" (security, performance, testing…) the agent is extracting for. Free-form; no schema enforced.')
})

export async function recordSemanticNodeHandler(raw: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const d = RecordSemanticNodeSchema.parse(raw)
  if (!d.file_id && !d.symbol_id) throw new Error('file_id or symbol_id required')

  const created = await apiPost<{ id: string }>('/code-graph/semantics', {
    fileId: d.file_id,
    symbolId: d.symbol_id,
    snapshotId: d.snapshot_id,
    purpose: d.purpose,
    domainTags: d.domain_tags,
    confidence: d.confidence,
    extractedBy: d.extracted_by,
    lensMetadata: d.lens_metadata
  })

  // Advance job processedFiles by 1
  const job = await apiGet<{ processedFiles: number }>(`/code-graph/jobs/${d.job_id}`)
  await apiPatch(`/code-graph/jobs/${d.job_id}`, {
    processedFiles: job.processedFiles + 1,
    lastBatchCursor: job.processedFiles + 1
  })

  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, semantic_id: created.id }) }] }
}
