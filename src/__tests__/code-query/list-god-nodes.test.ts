import { describe, it, expect, vi } from 'vitest'

vi.mock('../../tools/code-index/api-client.js', () => ({
  apiGet: vi.fn().mockResolvedValue({
    snapshotId: 'snap-1',
    godNodes: [
      { id: 's1', name: 'Router', qualifiedName: 'AppRouter', filePath: 'src/router.ts', fanIn: 42, fanOut: 38 }
    ]
  })
}))

const { ListGodNodesSchema, listGodNodesHandler } = await import('../../tools/code-query/list-god-nodes.js')

describe('ListGodNodesSchema', () => {
  it('accepts empty input (uses defaults)', () => {
    const r = ListGodNodesSchema.parse({})
    expect(r.top_n).toBe(20)
  })
  it('rejects if neither repo_id nor snapshot_id given — handled at runtime, schema accepts either', () => {
    expect(() => ListGodNodesSchema.parse({ top_n: 5 })).not.toThrow()
  })
})

describe('listGodNodesHandler', () => {
  it('returns god node list', async () => {
    const result = await listGodNodesHandler({ snapshot_id: 'snap-1' })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.godNodes).toHaveLength(1)
    expect(parsed.godNodes[0].fanIn).toBe(42)
  })
})
