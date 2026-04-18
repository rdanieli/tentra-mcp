import { describe, it, expect, vi } from 'vitest'

vi.mock('../../tools/code-index/api-client.js', () => ({
  apiPost: vi.fn().mockResolvedValue({ id: 'emb-new', ok: true })
}))

const { RecordEmbeddingSchema, recordEmbeddingHandler } = await import('../../tools/code-query/record-embedding.js')

describe('RecordEmbeddingSchema', () => {
  it('rejects invalid entity_type', () => {
    expect(() => RecordEmbeddingSchema.parse({
      entity_type: 'contract', entity_id: 'x', model: 'm', vector: [0.1], source_text: 's'
    })).toThrow()
  })
  it('accepts valid symbol embedding', () => {
    const r = RecordEmbeddingSchema.parse({
      entity_type: 'symbol', entity_id: 's1', model: 'text-embedding-3-small',
      vector: [0.1, 0.2], source_text: 'processes payment'
    })
    expect(r.entity_type).toBe('symbol')
  })
})

describe('recordEmbeddingHandler', () => {
  it('returns embedding id', async () => {
    const result = await recordEmbeddingHandler({
      entity_type: 'symbol', entity_id: 's1', model: 'text-embedding-3-small',
      vector: [0.1, 0.2], source_text: 'processes payment'
    })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.ok).toBe(true)
    expect(parsed.id).toBe('emb-new')
  })
})
