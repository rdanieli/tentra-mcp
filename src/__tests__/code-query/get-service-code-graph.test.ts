import { describe, it, expect, vi } from 'vitest'

vi.mock('../../tools/code-index/api-client.js', () => ({
  apiGet: vi.fn().mockResolvedValue({
    serviceId: 'payment_service', snapshotId: 'snap-1',
    files: [{ id: 'f1', relativePath: 'src/payment.ts', language: 'typescript', loc: 200, symbols: [] }],
    edges: []
  })
}))

const { GetServiceCodeGraphSchema, getServiceCodeGraphHandler } = await import('../../tools/code-query/get-service-code-graph.js')

describe('GetServiceCodeGraphSchema', () => {
  it('requires service_id', () => {
    expect(() => GetServiceCodeGraphSchema.parse({ snapshot_id: 's' })).toThrow()
  })
  it('defaults include_semantics to false', () => {
    const r = GetServiceCodeGraphSchema.parse({ service_id: 'svc', snapshot_id: 's' })
    expect(r.include_semantics).toBe(false)
  })
})

describe('getServiceCodeGraphHandler', () => {
  it('returns file + edge graph', async () => {
    const result = await getServiceCodeGraphHandler({ service_id: 'payment_service', snapshot_id: 'snap-1' })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.files).toHaveLength(1)
    expect(parsed.serviceId).toBe('payment_service')
  })
})
