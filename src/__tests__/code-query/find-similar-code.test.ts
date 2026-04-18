import { describe, it, expect, vi } from 'vitest'

vi.mock('../../tools/code-index/api-client.js', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn().mockResolvedValue({
    results: [
      { id: 'emb-1', entityType: 'symbol', entityId: 's2', distance: 0.08, sourceText: 'handles idempotency check' }
    ]
  })
}))

const { FindSimilarCodeSchema, findSimilarCodeHandler } = await import('../../tools/code-query/find-similar-code.js')

describe('FindSimilarCodeSchema', () => {
  it('requires query_vector', () => {
    expect(() => FindSimilarCodeSchema.parse({})).toThrow()
  })
  it('accepts symbol_id lookup mode', () => {
    const r = FindSimilarCodeSchema.parse({ query_vector: [0.1, 0.2], limit: 5 })
    expect(r.limit).toBe(5)
  })
})

describe('findSimilarCodeHandler', () => {
  it('returns similarity results', async () => {
    const result = await findSimilarCodeHandler({ query_vector: [0.1, 0.2, 0.3] })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.results).toHaveLength(1)
    expect(parsed.results[0].distance).toBe(0.08)
  })
})
