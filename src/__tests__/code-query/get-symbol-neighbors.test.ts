import { describe, it, expect, vi } from 'vitest'

vi.mock('../../tools/code-index/api-client.js', () => ({
  apiGet: vi.fn().mockResolvedValue({
    symbolId: 's1', depth: 2,
    neighbors: [{ id: 's2', name: 'process', qualifiedName: 'X.process', filePath: 'src/x.ts', fanIn: 1, fanOut: 0, isGodNode: false }],
    edges: [{ from: 's1', to: 's2', type: 'call' }]
  })
}))

const { GetSymbolNeighborsSchema, getSymbolNeighborsHandler } = await import('../../tools/code-query/get-symbol-neighbors.js')

describe('GetSymbolNeighborsSchema', () => {
  it('rejects missing symbol_id', () => {
    expect(() => GetSymbolNeighborsSchema.parse({ snapshot_id: 's' })).toThrow()
  })
  it('defaults depth to 2', () => {
    const r = GetSymbolNeighborsSchema.parse({ symbol_id: 's1', snapshot_id: 'sn1' })
    expect(r.depth).toBe(2)
  })
  it('rejects depth > 5', () => {
    expect(() => GetSymbolNeighborsSchema.parse({ symbol_id: 's1', snapshot_id: 'sn1', depth: 10 })).toThrow()
  })
})

describe('getSymbolNeighborsHandler', () => {
  it('returns structured neighbors', async () => {
    const result = await getSymbolNeighborsHandler({ symbol_id: 's1', snapshot_id: 'sn1' })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.neighbors).toHaveLength(1)
    expect(parsed.edges[0].type).toBe('call')
  })
})
